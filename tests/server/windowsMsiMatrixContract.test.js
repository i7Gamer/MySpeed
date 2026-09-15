import {describe, it} from "node:test";
import assert from "node:assert/strict";

import {
    createWindowsMsiMatrixContract,
    validateWindowsMsiMatrixContract
} from "../../scripts/qualification/windows-msi-matrix-contract.mjs";

const SCENARIO_IDS = Object.freeze([
    "clean-default",
    "clean-baseline",
    "swap-default-to-baseline",
    "swap-baseline-to-default",
    "lower-stamp-promotion",
    "higher-to-lower-stamp-diagnostic",
    "repair-executable",
    "repair-configuration",
    "transaction-rollback",
    "uninstall-reinstall",
    "authentic-1-6-0-default",
    "authentic-1-6-0-baseline",
    "authentic-1-1-0-migration",
    "legacy-no-overwrite"
]);

const clone = value => structuredClone(value);

describe("fixed Windows MSI lifecycle matrix contract", () => {
    it("pins every required row without claiming qualification", () => {
        const contract = createWindowsMsiMatrixContract();
        assert.deepEqual(Object.keys(contract), ["schemaVersion", "kind", "status", "qualifying",
            "releaseGatesCleared", "candidateBindings", "externalBindings", "sharedPrerequisites", "scenarios"]);
        assert.equal(contract.schemaVersion, 1);
        assert.equal(contract.kind, "myspeed-windows-msi-lifecycle-matrix-contract");
        assert.equal(contract.status, "unimplemented");
        assert.equal(contract.qualifying, false);
        assert.deepEqual(contract.releaseGatesCleared, []);
        assert.deepEqual(contract.scenarios.map(({id}) => id), SCENARIO_IDS);
        assert.equal(contract.scenarios.find(({id}) => id === "higher-to-lower-stamp-diagnostic").blocking, false);
        assert.ok(contract.scenarios.filter(({blocking}) => blocking).length === SCENARIO_IDS.length - 1);
        assert.ok(contract.scenarios.every(({freshEnvironment}) => freshEnvironment));
    });

    it("pins candidate artifacts and leaves generated or historical identities explicit", () => {
        const contract = createWindowsMsiMatrixContract();
        assert.deepEqual(contract.candidateBindings, {
            releaseVersion: "runtime-bound",
            windowsStamp: "runtime-bound",
            upgradeCode: "A1B2C3D4-5E6F-7890-ABCD-EF1234567890",
            default: {
                msi: {actionsArtifact: "release-msi-MySpeed-installer.msi",
                    innerFile: "MySpeed-installer.msi", releaseAsset: "MySpeed-installer.msi",
                    productCode: "inspect-and-bind", sha256: "inspect-and-bind"},
                executable: {actionsArtifact: "MySpeed-windows-x64.exe", innerFile: "MySpeed.exe",
                    releaseAsset: "MySpeed-windows-x64.exe", installedFile: "MySpeed.exe",
                    sha256: "inspect-and-bind"}
            },
            baseline: {
                msi: {actionsArtifact: "release-msi-MySpeed-installer-baseline.msi",
                    innerFile: "MySpeed-installer.msi", releaseAsset: "MySpeed-installer-baseline.msi",
                    productCode: "inspect-and-bind", sha256: "inspect-and-bind"},
                executable: {actionsArtifact: "MySpeed-windows-x64-baseline.exe", innerFile: "MySpeed.exe",
                    releaseAsset: "MySpeed-windows-x64-baseline.exe", installedFile: "MySpeed.exe",
                    sha256: "inspect-and-bind"}
            }
        });
        assert.deepEqual(contract.externalBindings, [
            "lower-stamp-fixture",
            "safe-rollback-predecessor",
            "authentic-1.6.0-default-msi",
            "authentic-1.6.0-baseline-msi",
            "authentic-1.1.0-msi"
        ]);
    });

    it("keeps rollback and authentic-old prerequisites attached only where required", () => {
        const contract = createWindowsMsiMatrixContract();
        const scenario = id => contract.scenarios.find(candidate => candidate.id === id);
        assert.deepEqual(scenario("transaction-rollback").prerequisites,
            ["offline-boundary", "service-oracle", "msi-api-rollback-controller", "sacrificial-rollback-trigger"]);
        for (const id of ["authentic-1-6-0-default", "authentic-1-6-0-baseline",
            "authentic-1-1-0-migration", "legacy-no-overwrite"])
            assert.ok(scenario(id).prerequisites.includes("authentic-old-ifeo-containment"), id);
        for (const candidate of contract.scenarios.filter(({id}) => !id.startsWith("authentic-") &&
            id !== "legacy-no-overwrite"))
            assert.ok(!candidate.prerequisites.includes("authentic-old-ifeo-containment"), candidate.id);
    });

    it("pins the operation sequence and expected outcome class of the risky rows", () => {
        const contract = createWindowsMsiMatrixContract();
        const scenario = id => contract.scenarios.find(candidate => candidate.id === id);
        assert.deepEqual(scenario("transaction-rollback"), {
            id: "transaction-rollback", blocking: true, freshEnvironment: true,
            from: "safe-rollback-predecessor", to: "candidate-default",
            operations: ["install-predecessor", "seed-data", "inject-post-removal-failure", "verify-rollback",
                "restart-and-run-oracle", "cleanup"],
            prerequisites: ["offline-boundary", "service-oracle", "msi-api-rollback-controller",
                "sacrificial-rollback-trigger"],
            expectedOutcome: "candidate-install-fails-and-predecessor-is-restored"
        });
        assert.equal(scenario("higher-to-lower-stamp-diagnostic").expectedOutcome,
            "record-observed-lower-stamp-behavior-without-policy-claim");
    });

    it("accepts only an exact independently reconstructable contract", () => {
        assert.deepEqual(validateWindowsMsiMatrixContract(createWindowsMsiMatrixContract()), {accepted: true});
        const reorderedObjectKeys = Object.fromEntries(Object.entries(createWindowsMsiMatrixContract()).reverse());
        assert.deepEqual(validateWindowsMsiMatrixContract(reorderedObjectKeys), {accepted: true});
        for (const mutate of [
            value => { value.schemaVersion = "1"; },
            value => { value.qualifying = true; },
            value => { value.releaseGatesCleared.push("Disposable Windows MSI lifecycle acceptance"); },
            value => { value.extra = true; },
            value => { value.scenarios.pop(); },
            value => { value.scenarios.reverse(); },
            value => { value.scenarios[0].extra = true; },
            value => { value.scenarios[0].id = value.scenarios[1].id; },
            value => { value.scenarios[0].freshEnvironment = false; },
            value => { value.scenarios[5].blocking = true; },
            value => { value.scenarios[8].operations[2] = "manual-cancel"; },
            value => { value.scenarios[8].prerequisites.pop(); },
            value => { value.candidateBindings.default.msi.actionsArtifact = "other.msi"; },
            value => { value.candidateBindings.baseline.msi.innerFile = "MySpeed-installer-baseline.msi"; },
            value => { value.candidateBindings.default.executable.innerFile = "MySpeed-windows-x64.exe"; },
            value => { value.externalBindings.reverse(); }
        ]) {
            const changed = clone(createWindowsMsiMatrixContract());
            mutate(changed);
            assert.throws(() => validateWindowsMsiMatrixContract(changed), /matrix contract differs/i);
        }
    });

    it("returns independent copies so callers cannot mutate the sealed template", () => {
        const first = createWindowsMsiMatrixContract();
        first.scenarios[0].operations[0] = "changed";
        assert.equal(createWindowsMsiMatrixContract().scenarios[0].operations[0], "install-candidate");
    });
});
