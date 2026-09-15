import {describe, it} from "node:test";
import assert from "node:assert/strict";
import {createHash} from "node:crypto";

import {createWindowsMsiMatrixContract} from "../../scripts/qualification/windows-msi-matrix-contract.mjs";
import {
    runWindowsMsiGuestMatrixRow,
    validateWindowsMsiGuestMatrixRowRequest,
    validateWindowsMsiGuestMatrixRowResult
} from "../../scripts/qualification/windows-msi-guest-matrix-row.mjs";

const HASH = "a".repeat(64);
const SOURCE_SHA = "1".repeat(40);
const EVENT_SHA = "2".repeat(40);
const SCENARIO_COUNT = 14;
const rawCpuid = () => ({schemaVersion: 1, kind: "cpuid", maxBasicLeaf: 7,
    leaf1: {eax: "0x00000000", ebx: "0x00000000", ecx: "0x18900000", edx: "0x00000000"},
    leaf7Subleaf0: {eax: "0x00000000", ebx: "0x00000120", ecx: "0x00000000", edx: "0x00000000"},
    xcr0: "0x0000000000000007", features: {sse42: true, popcnt: true, osxsave: true, avx: true, avx2: true}});
const cpuProbe = () => { const record = rawCpuid(); const raw = Buffer.from(`${JSON.stringify(record)}\r\n`); return {
    bytesBase64: raw.toString("base64"), sha256: createHash("sha256").update(raw).digest("hex"), record}; };
const v2Request = scenarioIndex => {
    const value = request(scenarioIndex);
    value.schemaVersion = 2;
    delete value.guest.cpuid;
    delete value.guest.cpuProbe;
    value.guest.cpuRequirements = {sse42: true, popcnt: true, osxsave: true, avx: true, avx2: true,
        xcr0RequiredMask: "0000000000000006"};
    value.guest.cpuEvidenceSha256 = createHash("sha256")
        .update(JSON.stringify(value.guest.cpuRequirements)).digest("hex");
    return value;
};

const request = scenarioIndex => ({
    schemaVersion: 1,
    kind: "myspeed-windows-msi-guest-matrix-row-request",
    qualifying: false,
    sourceSha: SOURCE_SHA,
    eventSha: EVENT_SHA,
    runId: "123",
    runAttempt: "1",
    nonce: "3".repeat(32),
    scenarioIndex,
    matrix: createWindowsMsiMatrixContract(),
    guest: {
        profile: "modern-msi-v1",
        serial: "3".repeat(32),
        qemuCpuModel: "host",
        evidenceRoot: "E:\\myspeed-msi-evidence",
        baseImageSha256: "d".repeat(64),
        overlayNonce: "e".repeat(32),
        overlayReceiptSha256: "f".repeat(64),
        qemuLaunchSha256: "5".repeat(64),
        cpuEvidenceSha256: cpuProbe().sha256,
        cpuid: {
            vendor: "GenuineIntel",
            leaf1EcxHex: "18900000",
            leaf7EbxHex: "00000120",
            xcr0Hex: "0000000000000007",
            sse42: true,
            popcnt: true,
            osxsave: true,
            avx: true,
            avx2: true
        }, cpuProbe: cpuProbe()
    },
    prerequisites: {
        closureSha256: "7".repeat(64),
        candidateManifestSha256: "8".repeat(64),
        fixtureManifestSha256: "9".repeat(64),
        rollbackCalibrationSha256: "b".repeat(64),
        oldContainmentSha256: "c".repeat(64)
    }
});

const operations = ({failOperation = null, cleanupFails = false} = {}) => {
    const calls = [];
    return {calls, value: {
        assertGuestBoundary: async ({request: input}) => {
            calls.push("boundary");
            return {stage: "guest-boundary", passed: true, cpuEvidenceSha256: input.guest.cpuEvidenceSha256,
                qemuLaunchSha256: input.guest.qemuLaunchSha256, networkAdapters: 0,
                serial: input.guest.serial, manufacturer: "QEMU", observationCommand: {synthetic: true},
                cpuProbeCommand: {synthetic: true}};
        },
        inspectFreshScenario: async ({scenario}) => {
            calls.push(`fresh:${scenario.id}`);
            return {stage: "fresh-scenario", passed: true, products: 0, services: 0, listeners: 0,
                ownedPaths: 0, state: {synthetic: true}};
        },
        executeOperation: async ({scenario, operation, operationIndex}) => {
            calls.push(`${scenario.id}:${operationIndex}:${operation}`);
            if (operation === failOperation) throw new Error("injected");
            return {stage: "matrix-operation", passed: true, scenarioId: scenario.id, operation,
                operationIndex, actualHandler: `actual-${operation}`,
                evidence: {path: `E:\\myspeed-msi-evidence\\${operationIndex}-${operation}.json`,
                    bytes: 123, sha256: HASH}, stateProofSha256: HASH};
        },
        cleanupScenario: async ({scenario, mutationAttempted}) => {
            calls.push(`cleanup:${scenario.id}:${mutationAttempted}`);
            if (cleanupFails) throw new Error("cleanup");
            return {stage: "scenario-cleanup", passed: true, products: 0, services: 0, listeners: 0,
                ownedPaths: 0, qemuPoweroffRequired: true, containmentCleanup: null,
                uninstallCommands: [], ownedRemoval: {synthetic: true}, state: {synthetic: true}};
        }
    }};
};

describe("Windows MSI modern-CPU guest matrix row", () => {
    it("binds a separate modern CPU profile and one exact row from the accepted 14-row matrix", () => {
        assert.equal(createWindowsMsiMatrixContract().scenarios.length, SCENARIO_COUNT);
        for (let index = 0; index < SCENARIO_COUNT; index++)
            assert.equal(validateWindowsMsiGuestMatrixRowRequest(request(index)).scenarioIndex, index);
        for (const mutate of [
            value => { value.qualifying = true; },
            value => { value.scenarioIndex = SCENARIO_COUNT; },
            value => { value.guest.profile = "westmere-v2"; },
            value => { value.guest.cpuid.avx2 = false; },
            value => { value.guest.cpuid.leaf1EcxHex = "00000000"; },
            value => { value.guest.cpuid.leaf7EbxHex = "00000000"; },
            value => { value.guest.cpuid.xcr0Hex = "0000000000000001"; },
            value => { const raw = Buffer.from(`${JSON.stringify(value.guest.cpuProbe.record)}\r\n\r\n`);
                value.guest.cpuProbe.bytesBase64 = raw.toString("base64");
                value.guest.cpuProbe.sha256 = createHash("sha256").update(raw).digest("hex");
                value.guest.cpuEvidenceSha256 = value.guest.cpuProbe.sha256; },
            value => { value.sourceSha += "\n"; },
            value => { value.matrix.scenarios.reverse(); }
        ]) {
            const changed = structuredClone(request(0));
            mutate(changed);
            assert.throws(() => validateWindowsMsiGuestMatrixRowRequest(changed));
        }
    });

    it("executes every operation of every matrix row through an actual-handler receipt", async () => {
        for (let index = 0; index < SCENARIO_COUNT; index++) {
            const input = request(index);
            const injected = operations();
            const result = await runWindowsMsiGuestMatrixRow(input, injected.value);
            const scenario = input.matrix.scenarios[index];
            assert.equal(result.status, "completed", scenario.id);
            assert.equal(result.rowPassed, true, scenario.id);
            assert.deepEqual(result.operations, scenario.operations);
            assert.equal(result.operationProofs.length, scenario.operations.length);
            assert.ok(result.operationProofs.every((entry, operationIndex) =>
                entry.actualHandler === `actual-${scenario.operations[operationIndex]}`));
            assert.ok(result.operationProofs.every(entry => entry.evidence.sha256 === entry.stateProofSha256));
            assert.equal(validateWindowsMsiGuestMatrixRowResult(result, input), result);
        }
    });

    it("accepts constraints before execution and retains the actual raw modern CPUID observation", async () => {
        const input = v2Request(0);
        const injected = operations();
        const observation = cpuProbe();
        injected.value.assertGuestBoundary = async () => ({stage: "guest-boundary", passed: true,
            cpuEvidenceSha256: input.guest.cpuEvidenceSha256, qemuLaunchSha256: input.guest.qemuLaunchSha256,
            networkAdapters: 0, serial: input.guest.serial, manufacturer: "QEMU",
            observationCommand: {synthetic: true}, cpuProbeCommand: {synthetic: true,
                stdoutSha256: observation.sha256}, cpuObservation: observation});
        const result = await runWindowsMsiGuestMatrixRow(input, injected.value);
        assert.equal(result.status, "completed");
        assert.deepEqual(result.boundaryReceipt.cpuObservation, observation);
        assert.equal(validateWindowsMsiGuestMatrixRowResult(result, input), result);
        for (const mutate of [
            value => { value.guest.cpuRequirements.avx2 = false; },
            value => { value.guest.cpuRequirements.xcr0RequiredMask = "0000000000000000"; }
        ]) {
            const changed = v2Request(0); mutate(changed);
            assert.throws(() => validateWindowsMsiGuestMatrixRowRequest(changed));
        }
    });

    it("rejects operation evidence outside the owned output root or not bound to the state proof", async () => {
        for (const mutate of [
            value => { value.evidence.path = "C:\\outside.json"; },
            value => { value.evidence.sha256 = "f".repeat(64); },
            value => { value.evidence.bytes = 0; }
        ]) {
            const input = request(0);
            const injected = operations();
            const original = injected.value.executeOperation;
            injected.value.executeOperation = async value => {
                const receipt = await original(value);
                mutate(receipt);
                return receipt;
            };
            const result = await runWindowsMsiGuestMatrixRow(input, injected.value);
            assert.equal(result.rowPassed, false);
        }
    });

    it("fails closed at the exact operation and still performs scenario cleanup", async () => {
        const input = request(6);
        const target = input.matrix.scenarios[6].operations[3];
        const injected = operations({failOperation: target});
        const result = await runWindowsMsiGuestMatrixRow(input, injected.value);
        assert.equal(result.status, "failed");
        assert.equal(result.rowPassed, false);
        assert.deepEqual(result.failures, [{stage: `operation:${target}`, classification: "failed"}]);
        assert.match(injected.calls.at(-1), /^cleanup:/u);
    });

    it("does not mutate or clean when the modern guest boundary or fresh-state guard fails", async () => {
        for (const failingMethod of ["assertGuestBoundary", "inspectFreshScenario"]) {
            const injected = operations();
            injected.value[failingMethod] = async () => { throw new Error("injected"); };
            const result = await runWindowsMsiGuestMatrixRow(request(0), injected.value);
            assert.equal(result.rowPassed, false);
            assert.equal(injected.calls.some(value => value.includes(":install-candidate")), false);
            assert.equal(injected.calls.some(value => value.startsWith("cleanup:")), false);
        }
    });

    it("retains independent cleanup failure and never clears a release gate", async () => {
        const injected = operations({failOperation: "seed-data", cleanupFails: true});
        const result = await runWindowsMsiGuestMatrixRow(request(0), injected.value);
        assert.ok(result.failures.some(({stage}) => stage === "cleanup"));
        assert.equal(result.qualifying, false);
        assert.deepEqual(result.releaseGatesCleared, []);
    });
});
