import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {describe, it} from "node:test";

import {runHostedStage2Controller} from
    "../../scripts/qualification/linux-windows-cpu-floor-stage2-controller.mjs";
import {buildWindowsMsiStage2Request, WINDOWS_MSI_STAGE2_CLOSURE, WINDOWS_MSI_STAGE2_PROBE_ROLES,
    WINDOWS_MSI_STAGE2_ROOTS} from "../../scripts/qualification/windows-msi-stage2-request.mjs";

const NONCE = "5".repeat(32);
const RUNNER_TEMP = "/home/runner/work/_temp";
const CLOSURE_ROOT = `${RUNNER_TEMP}/myspeed-stage2-closure-${NONCE}`;
const INPUT_ROOT = `${RUNNER_TEMP}/myspeed-stage2-input-${NONCE}`;

const digest = text => createHash("sha256").update(text).digest("hex");

const context = () => ({schemaVersion: 1, repository: "i7Gamer/MySpeed", sourceSha: "1".repeat(40),
    eventSha: "2".repeat(40), runId: "34900000001", runAttempt: "1", nonce: NONCE,
    environment: {GITHUB_ACTIONS: "true", CI: "true", RUNNER_OS: "Linux", RUNNER_ARCH: "X64",
        RUNNER_ENVIRONMENT: "github-hosted", ImageOS: "ubuntu24", ImageVersion: "20260914.1"}});

/*
 * One synthetic byte string per path, so every identity in the request is distinct and a test that
 * moves a file to another root produces a genuinely different record rather than a coincidence.
 */
const contents = target => `bytes-of:${target}`;
const identity = target => {
    const text = contents(target);
    return {path: target, bytes: text.length, sha256: digest(text)};
};

/*
 * Stage 2 requires the staged archive to be the very artifact the pin names, so the fixture pins
 * what it staged - which is exactly what the acquisition step establishes before staging.
 */
const probe = () => ({artifactId: "10222222222", runId: "34800000001", runAttempt: "1",
    sourceSha: "3".repeat(40),
    archiveBytes: String(identity(`${INPUT_ROOT}/artifact.zip`).bytes),
    archiveSha256: identity(`${INPUT_ROOT}/artifact.zip`).sha256,
    files: WINDOWS_MSI_STAGE2_PROBE_ROLES.map(role => {
        const name = `${role.replaceAll("-", "_")}.exe`;
        const observed = identity(`${INPUT_ROOT}/${name}`);
        return {role, name, bytes: String(observed.bytes), sha256: observed.sha256};
    })});

const build = (overrides = {}) => buildWindowsMsiStage2Request({context: context(), identity,
    probe: probe(), ...overrides});

/*
 * The request the workflow hands Stage 2 is fed to the real Stage 2 validator, not to a regex. The
 * controller validates before it touches anything, so injected dependencies let the whole validation
 * path run with no disk, no QEMU and no admission.
 */
const validateThroughStage2 = async request => {
    const reads = [];
    let admitted = null;
    const readVerified = target => {
        reads.push(target);
        const text = contents(target);
        return {bytes: Buffer.from(text), path: target, sha256: digest(text)};
    };
    await runHostedStage2Controller(request, {readVerified,
        collectAdmission: value => { admitted = value; throw new Error("stopped after validation"); }})
        .catch(error => { if (error.message !== "stopped after validation") throw error; });
    return {reads, admitted};
};

describe("Windows MSI Stage 2 request", () => {
    it("names the exact ordered Stage 2 closure rather than the MSI closure", () => {
        assert.deepEqual([...WINDOWS_MSI_STAGE2_CLOSURE], [
            "scripts/qualification/linux-windows-cpu-floor-admission.mjs",
            "scripts/qualification/linux-windows-cpu-floor-stage2-controller.mjs",
            "scripts/qualification/linux-windows-cpu-floor-stage2-hosted.mjs",
            "scripts/qualification/linux-windows-cpu-floor-stage2-qmp.mjs",
            "scripts/qualification/linux-windows-cpu-floor-stage2.mjs",
            "scripts/qualification/linux-kvm-capability.mjs",
            "scripts/qualification/linux-kvm-privileged-capability.mjs",
            "scripts/qualification/windows-msi-post-setup-activation.mjs"]);
        assert.equal(WINDOWS_MSI_STAGE2_ROOTS.closurePrefix, `${RUNNER_TEMP}/myspeed-stage2-closure-`);
        assert.equal(WINDOWS_MSI_STAGE2_ROOTS.inputPrefix, `${RUNNER_TEMP}/myspeed-stage2-input-`);
        assert.deepEqual([...WINDOWS_MSI_STAGE2_PROBE_ROLES],
            ["avx", "avx2", "cpuid", "illegal", "known-bad", "known-good", "popcnt", "sse42"]);
    });

    /*
     * The defect this replaces: the workflow built the request around
     * `myspeed-msi-closure-<nonce>` with every MSI controller member in it, and staged the KVM and
     * probe inputs under the MSI input root. The validator names different roots and an exact
     * eight-file list, so the run would have failed at its first Stage 2 call.
     */
    it("passes the real Stage 2 validator with its own closure and input roots", async () => {
        const request = build();
        assert.equal(request.closure.root, CLOSURE_ROOT);
        assert.equal(request.closure.files.length, WINDOWS_MSI_STAGE2_CLOSURE.length);
        assert.deepEqual(request.closure.files.map(file => file.path),
            WINDOWS_MSI_STAGE2_CLOSURE.map(name => `${CLOSURE_ROOT}/${name}`));
        assert.equal(request.kvm.ordinary.path, `${INPUT_ROOT}/ordinary.json`);
        assert.equal(request.kvm.combined.path, `${INPUT_ROOT}/combined.json`);
        assert.equal(request.probeStage.archive.path, `${INPUT_ROOT}/artifact.zip`);
        assert.equal(request.probeStage.result.path, `${INPUT_ROOT}/result.json`);
        const {reads, admitted} = await validateThroughStage2(request);
        assert.notEqual(admitted, null, "validation did not reach admission");
        assert.deepEqual(admitted.context, request.context);
        /* Every closure member and both KVM inputs were verified before admission was collected. */
        for (const name of WINDOWS_MSI_STAGE2_CLOSURE)
            assert.ok(reads.includes(`${CLOSURE_ROOT}/${name}`), name);
        assert.ok(reads.includes(`${INPUT_ROOT}/ordinary.json`));
        assert.ok(reads.includes(`${INPUT_ROOT}/combined.json`));
    });

    it("keeps the MSI closure out of the Stage 2 request", async () => {
        const request = build();
        const text = JSON.stringify(request);
        assert.equal(text.includes("myspeed-msi-closure-"), false);
        assert.equal(text.includes("myspeed-msi-input-"), false);
        assert.equal(text.includes("post-release-msi-linux-controller.mjs"), false);
        assert.equal(text.includes("windows-msi-guest-matrix-executor.mjs"), false);
    });

    /*
     * A request that drifts back towards the MSI roots, loses a closure member or reorders the list
     * has to be refused by Stage 2 itself, which is the check a regex over the workflow text could
     * never make.
     */
    it("is refused by Stage 2 when a root, a member or the order drifts", async () => {
        const cases = {
            "closure root moved to the MSI closure": request => ({...request,
                closure: {...request.closure,
                    root: `${RUNNER_TEMP}/myspeed-msi-closure-${NONCE}`}}),
            "closure member dropped": request => ({...request,
                closure: {...request.closure, files: request.closure.files.slice(1)}}),
            "closure order reversed": request => ({...request,
                closure: {...request.closure, files: [...request.closure.files].reverse()}}),
            "extra MSI member appended": request => ({...request, closure: {...request.closure,
                files: [...request.closure.files,
                    identity(`${CLOSURE_ROOT}/scripts/release/post-release-msi-linux-controller.mjs`)]}}),
            "KVM input staged under the MSI input root": request => ({...request,
                kvm: {...request.kvm,
                    ordinary: identity(`${RUNNER_TEMP}/myspeed-msi-input-${NONCE}/ordinary.json`)}}),
            "probe archive staged under the MSI input root": request => ({...request,
                probeStage: {...request.probeStage,
                    archive: identity(`${RUNNER_TEMP}/myspeed-msi-input-${NONCE}/artifact.zip`)}})
        };
        for (const [name, mutate] of Object.entries(cases)) {
            const {admitted} = await validateThroughStage2(mutate(build()))
                .then(value => value, () => ({admitted: null}));
            assert.equal(admitted, null, name);
        }
    });

    it("binds the probe artifact identity the acquisition step pinned", () => {
        const request = build();
        assert.equal(request.probeArtifact.artifactName, "windows-cpu-readiness-evidence");
        assert.equal(request.probeArtifact.repository, "i7Gamer/MySpeed");
        assert.equal(request.probeArtifact.archive.sha256,
            identity(`${INPUT_ROOT}/artifact.zip`).sha256);
        assert.equal(request.probeArtifact.files.length, 8);
        assert.deepEqual(request.probeStage.files.map(file => file.path),
            WINDOWS_MSI_STAGE2_PROBE_ROLES.map(role =>
                `${INPUT_ROOT}/${role.replaceAll("-", "_")}.exe`));
        assert.throws(() => build({probe: {...probe(), files: probe().files.slice(1)}}),
            /probe/iu);
        assert.throws(() => build({context: {...context(), nonce: "not-a-nonce"}}), /context|nonce/iu);
    });
});
