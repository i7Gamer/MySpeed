import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {describe, it} from "node:test";
import {fileURLToPath} from "node:url";

import {KVM_PROBE_SOURCE} from "../../scripts/qualification/linux-kvm-capability.mjs";

import {
    STAGE2_LIMITS,
    assessWindowsCpuFloorAdmission
} from "../../scripts/qualification/linux-windows-cpu-floor-admission.mjs";

const SOURCE_SHA = "a".repeat(40);
const EVENT_SHA = "b".repeat(40);
const NONCE = "0123456789abcdef0123456789abcdef";
const PROBE_BINARY = {bytes: 16_856, sha256: "e".repeat(64)};
const TEST_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));

function context() {
    return {schemaVersion: 1, repository: "i7Gamer/MySpeed", sourceSha: SOURCE_SHA,
        eventSha: EVENT_SHA, runId: "123456789", runAttempt: "2", nonce: NONCE,
        environment: {GITHUB_ACTIONS: "true", CI: "true", RUNNER_OS: "Linux", RUNNER_ARCH: "X64",
            RUNNER_ENVIRONMENT: "github-hosted", ImageOS: "ubuntu24", ImageVersion: "20260907.1"}};
}

function processRecord() {
    return {exitCode: 0, signal: null, timedOut: false, stdoutOverflow: false, stderrOverflow: false,
        cleanupProven: true, errorObserved: false};
}

function privilegedTool(pathValue, version, hash) {
    const stdout = serializedStream(Buffer.from(`${version}\n`));
    return {path: pathValue, facts: {dev: "1", ino: "2", mode: "33261", uid: "0", gid: "0", size: "4096"},
        bytes: 4096, sha256: hash, version, versionObservation: {process: processRecord(), stdout,
            stderr: serializedStream(Buffer.alloc(0))}};
}

function serializedStream(bytes) {
    return {bytes: bytes.length, sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
        base64: bytes.toString("base64")};
}

function deviceFacts() {
    return {kind: "character-device", dev: "1", ino: "2", rdev: "259", mode: "8624", uid: "0", gid: "993"};
}

function passedProbe() {
    const facts = deviceFacts();
    return {schemaVersion: 1, status: "passed", stage: "complete", errno: 0, apiVersion: 12,
        exitReason: 5, cleanupProven: true,
        device: {lstat: {...facts}, fstat: {...facts}, reopen: {...facts}}};
}

function permissionProbe() {
    return {schemaVersion: 1, status: "failed", stage: "open", errno: 13, apiVersion: null,
        exitReason: null, cleanupProven: true,
        device: {lstat: deviceFacts(), fstat: null, reopen: null}};
}

function ordinaryResult(probe = passedProbe()) {
    const capability = probe.status === "passed" ? "usable" : "permission-denied";
    return {schemaVersion: 1, status: capability === "usable" ? "passed" : "failed",
        classification: "github-hosted-linux-kvm-capability-nonqualifying", capability,
        qualifying: false, releaseGateCleared: false, context: context(),
        closure: {name: "linux-kvm-capability.mjs", bytes: 54_083, sha256: "c".repeat(64)},
        source: {bytes: Buffer.byteLength(KVM_PROBE_SOURCE),
            sha256: crypto.createHash("sha256").update(KVM_PROBE_SOURCE).digest("hex")},
        probeBinary: {...PROBE_BINARY},
        compiler: {}, resources: {}, process: processRecord(), streams: {
            stdout: serializedStream(Buffer.from(`${JSON.stringify(probe)}\n`)),
            stderr: serializedStream(Buffer.from(`${JSON.stringify({schemaVersion: 1,
                kind: "linux-kvm-probe-process", pid: 122, startTicks: "4"})}\n`))}, probe,
        startedMonotonicNs: "1", finishedMonotonicNs: "2", durationNs: "1"};
}

function jsonBytes(value) {
    return Buffer.from(`${JSON.stringify(value)}\n`);
}

function evidence(probe = passedProbe()) {
    const ordinary = ordinaryResult(probe);
    const ordinaryBytes = jsonBytes(ordinary);
    const ordinaryIdentity = {bytes: ordinaryBytes.length,
        sha256: crypto.createHash("sha256").update(ordinaryBytes).digest("hex"), capability: ordinary.capability};
    const rootProbeIdentity = {schemaVersion: 1, kind: "linux-kvm-probe-process", pid: 123, startTicks: "5"};
    const privilegedProbe = passedProbe();
    const combined = ordinary.capability === "usable" ?
        {schemaVersion: 1, status: "observed",
            classification: "github-hosted-linux-kvm-privileged-capability-nonqualifying",
            capability: "ordinary-usable", retryPerformed: false, qualifying: false, releaseGateCleared: false,
            context: context(), ordinary: ordinaryIdentity} :
        {schemaVersion: 1, status: "observed",
            classification: "github-hosted-linux-kvm-privileged-capability-nonqualifying",
            capability: "usable", retryPerformed: true, qualifying: false, releaseGateCleared: false,
            context: context(), ordinary: ordinaryIdentity,
            privileged: {argv: ["-n", "--", "/usr/bin/timeout", "--foreground", "--signal=KILL", "30s",
                `/home/runner/work/_temp/myspeed-kvm-capability-${NONCE}/probe`], probeBinary: {...PROBE_BINARY},
                tools: {sudo: privilegedTool("/usr/bin/sudo", "Sudo version 1.9.15p5", "1".repeat(64)),
                    timeout: privilegedTool("/usr/bin/timeout", "timeout (GNU coreutils) 9.4", "2".repeat(64))},
                observation: {process: processRecord(),
                stdout: serializedStream(Buffer.from(`${JSON.stringify(privilegedProbe)}\n`)),
                stderr: serializedStream(Buffer.from(`${JSON.stringify(rootProbeIdentity)}\n`))},
                probe: privilegedProbe, rootProbeProcess: {identity: rootProbeIdentity, after: {state: "absent"}}}};
    return {ordinaryBytes, combinedBytes: jsonBytes(combined)};
}

function observations() {
    return {
        taskRoot: {path: `/home/runner/work/_temp/myspeed-windows-cpu-floor-${NONCE}`, exists: false,
            parentWritableByCurrentUser: true},
        filesystem: {taskPath: "/home/runner/work/_temp", mountPoint: "/home/runner/work",
            type: "ext4", mountOptions: "rw,relatime", remote: false,
            availableBlocks: "19816114", fragmentSizeBytes: "4096", availableBytes: "81166802944"},
        memory: {memAvailableBytes: "15226159104", selfCgroupPath: "/sys/fs/cgroup/actions_job", cgroupLevels: [
            {path: "/sys/fs/cgroup", mountPoint: "/sys/fs/cgroup", mountRoot: "/", limitBytes: null,
                currentBytes: null},
            {path: "/sys/fs/cgroup/actions_job", mountPoint: "/sys/fs/cgroup", mountRoot: "/",
                limitBytes: "16000000000", currentBytes: "2000000000"}
        ], cgroupHeadroomBytes: "14000000000",
            effectiveAvailableBytes: "14000000000"}
    };
}

function request(overrides = {}) {
    return {context: context(), kvmEvidence: evidence(), observations: observations(), ...overrides};
}

describe("hosted Windows CPU-floor Stage 2 admission", () => {
    it("publishes the reviewed immutable arithmetic and execution bounds", () => {
        assert.deepEqual(STAGE2_LIMITS, {
            guestVcpus: 2,
            guestRamBytes: "6442450944",
            guestDiskMaxBytes: "51539607552",
            windowsIsoBytes: "8152356864",
            toolsFirmwareMaxBytes: "2147483648",
            harnessEvidenceMaxBytes: "2147483648",
            taskRootMaxBytes: "63986931712",
            hostFreeReserveBytes: "17179869184",
            startFreeRequiredBytes: "81166800896",
            startEffectiveAvailableMemoryBytes: "12884901888",
            hostMemoryAbortBytes: "4294967296",
            resourcePollSeconds: 5,
            executionDeadlineMinutes: 270,
            cleanupEvidenceMinutes: 30,
            workflowTimeoutMinutes: 300
        });
        assert.equal(BigInt(STAGE2_LIMITS.guestDiskMaxBytes) + BigInt(STAGE2_LIMITS.windowsIsoBytes) +
            BigInt(STAGE2_LIMITS.toolsFirmwareMaxBytes) + BigInt(STAGE2_LIMITS.harnessEvidenceMaxBytes),
        BigInt(STAGE2_LIMITS.taskRootMaxBytes));
        assert.equal(BigInt(STAGE2_LIMITS.taskRootMaxBytes) + BigInt(STAGE2_LIMITS.hostFreeReserveBytes),
            BigInt(STAGE2_LIMITS.startFreeRequiredBytes));
        assert.equal(Object.isFrozen(STAGE2_LIMITS), true);
    });

    it("admits exact ordinary KVM evidence at the exact resource boundaries without authorizing execution", () => {
        const input = request();
        input.observations.filesystem.availableBlocks = "79264454";
        input.observations.filesystem.fragmentSizeBytes = "1024";
        input.observations.filesystem.availableBytes = STAGE2_LIMITS.startFreeRequiredBytes;
        input.observations.memory.memAvailableBytes = STAGE2_LIMITS.startEffectiveAvailableMemoryBytes;
        input.observations.memory.cgroupLevels = [{path: "/sys/fs/cgroup", mountPoint: "/sys/fs/cgroup",
            mountRoot: "/", limitBytes: null, currentBytes: null}];
        input.observations.memory.selfCgroupPath = "/sys/fs/cgroup";
        input.observations.memory.cgroupHeadroomBytes = null;
        input.observations.memory.effectiveAvailableBytes = STAGE2_LIMITS.startEffectiveAvailableMemoryBytes;
        const result = assessWindowsCpuFloorAdmission(input);
        assert.equal(result.status, "admitted");
        assert.equal(result.admitted, true);
        assert.equal(result.qualifying, false);
        assert.equal(result.releaseGateCleared, false);
        assert.equal(result.mediaAcquisitionAuthorized, false);
        assert.equal(result.qemuLaunchAuthorized, false);
        assert.equal(result.kvm.ordinary.capability, "usable");
        assert.equal(result.kvm.combined.capability, "ordinary-usable");
        assert.deepEqual(result.reasons, []);
        assert.equal(Object.isFrozen(result), true);
        assert.equal(Object.isFrozen(result.observations.filesystem), true);
    });

    it("accepts an exact permission-denied ordinary attempt only when the bound privileged retry is usable", () => {
        const result = assessWindowsCpuFloorAdmission(request({kvmEvidence: evidence(permissionProbe())}));
        assert.equal(result.admitted, true);
        assert.equal(result.kvm.ordinary.capability, "permission-denied");
        assert.equal(result.kvm.combined.capability, "usable");
        assert.equal(result.kvm.combined.retryPerformed, true);
        const missingIdentity = request({kvmEvidence: evidence(permissionProbe())});
        const combined = JSON.parse(missingIdentity.kvmEvidence.combinedBytes);
        combined.privileged.rootProbeProcess.identity = null;
        missingIdentity.kvmEvidence.combinedBytes = jsonBytes(combined);
        assert.throws(() => assessWindowsCpuFloorAdmission(missingIdentity), /root probe process identity/u);
    });

    it("replays the retained hosted permission-denied and privileged evidence bytes", () => {
        const evidenceRoot = path.join(TEST_DIRECTORY, "..", "fixtures", "linux-kvm-privileged-capability-evidence");
        const ordinaryBytes = fs.readFileSync(path.join(evidenceRoot, "result.json"));
        const combinedBytes = fs.readFileSync(path.join(evidenceRoot, "privileged-result.json"));
        const retainedContext = JSON.parse(ordinaryBytes).context;
        const retainedObservations = observations();
        retainedObservations.taskRoot.path =
            `/home/runner/work/_temp/myspeed-windows-cpu-floor-${retainedContext.nonce}`;
        const result = assessWindowsCpuFloorAdmission({context: retainedContext,
            kvmEvidence: {ordinaryBytes, combinedBytes}, observations: retainedObservations});
        assert.equal(result.status, "admitted");
        assert.equal(result.kvm.ordinary.capability, "permission-denied");
        assert.equal(result.kvm.combined.capability, "usable");
    });

    it("rejects well-formed capacity, memory, root, filesystem and writability failures", () => {
        const cases = [
            ["insufficient-filesystem-capacity", value => {
                value.filesystem.availableBlocks = "81166800895";
                value.filesystem.fragmentSizeBytes = "1";
                value.filesystem.availableBytes = "81166800895";
            }],
            ["insufficient-effective-memory", value => {
                value.memory.memAvailableBytes = "12884901887";
                value.memory.cgroupLevels = [{path: "/sys/fs/cgroup", mountPoint: "/sys/fs/cgroup",
                    mountRoot: "/", limitBytes: null, currentBytes: null}];
                value.memory.selfCgroupPath = "/sys/fs/cgroup";
                value.memory.cgroupHeadroomBytes = null;
                value.memory.effectiveAvailableBytes = "12884901887";
            }],
            ["task-root-already-exists", (value, root) => root.exists = true],
            ["task-root-parent-not-writable", (value, root) => root.parentWritableByCurrentUser = false],
            ["remote-filesystem", value => value.filesystem.remote = true],
            ["filesystem-not-writable", value => value.filesystem.mountOptions = "ro,relatime"]
        ];
        for (const [reason, mutate] of cases) {
            const input = request();
            mutate(input.observations, input.observations.taskRoot);
            const result = assessWindowsCpuFloorAdmission(input);
            assert.equal(result.admitted, false, reason);
            assert.equal(result.status, "rejected", reason);
            assert.equal(result.reasons.includes(reason), true, reason);
            assert.equal(result.mediaAcquisitionAuthorized, false, reason);
        }
    });

    it("recomputes statvfs and memory derivations rather than trusting caller totals", () => {
        for (const mutate of [
            value => value.filesystem.availableBytes = "81166802945",
            value => value.memory.effectiveAvailableBytes = "13999999999",
            value => value.filesystem.fragmentSizeBytes = "4096\n",
            value => value.memory.memAvailableBytes = "1.5"
        ]) {
            const input = request();
            mutate(input.observations);
            assert.throws(() => assessWindowsCpuFloorAdmission(input), /invalid|mismatch/u);
        }
        const invalidUnlimitedLeaf = request();
        invalidUnlimitedLeaf.observations.memory.cgroupLevels[1].limitBytes = null;
        invalidUnlimitedLeaf.observations.memory.cgroupLevels[1].currentBytes = "2000000000";
        invalidUnlimitedLeaf.observations.memory.cgroupHeadroomBytes = null;
        invalidUnlimitedLeaf.observations.memory.effectiveAvailableBytes =
            invalidUnlimitedLeaf.observations.memory.memAvailableBytes;
        assert.equal(assessWindowsCpuFloorAdmission(invalidUnlimitedLeaf).admitted, true);
        invalidUnlimitedLeaf.observations.memory.cgroupLevels[1].currentBytes = null;
        assert.throws(() => assessWindowsCpuFloorAdmission(invalidUnlimitedLeaf), /invalid/u);
        const invalidMountRoot = request();
        invalidMountRoot.observations.memory.cgroupLevels[0].mountRoot = "/docker-subtree";
        assert.throws(() => assessWindowsCpuFloorAdmission(invalidMountRoot), /root-unlimited/u);
        const escapedCgroup = request();
        escapedCgroup.observations.memory.cgroupLevels[0].path = "/other";
        assert.throws(() => assessWindowsCpuFloorAdmission(escapedCgroup), /cgroup mount binding/u);
        const skippedFiniteRoot = request();
        skippedFiniteRoot.observations.memory.cgroupLevels.shift();
        assert.throws(() => assessWindowsCpuFloorAdmission(skippedFiniteRoot), /cgroup ancestry/u);
        const skippedAncestor = request();
        skippedAncestor.observations.memory.cgroupLevels[1].path = "/sys/fs/cgroup/parent/actions_job";
        skippedAncestor.observations.memory.selfCgroupPath = "/sys/fs/cgroup/parent/actions_job";
        assert.throws(() => assessWindowsCpuFloorAdmission(skippedAncestor), /cgroup ancestry/u);
        const wrongSelf = request();
        wrongSelf.observations.memory.selfCgroupPath = "/sys/fs/cgroup/another_job";
        assert.throws(() => assessWindowsCpuFloorAdmission(wrongSelf), /self cgroup/u);
        const rootMount = request();
        rootMount.observations.filesystem.mountPoint = "/";
        assert.equal(assessWindowsCpuFloorAdmission(rootMount).admitted, true);
    });

    it("rejects unbound, changed, noncanonical and non-usable KVM evidence", () => {
        const cases = [
            value => value.combinedBytes = Buffer.concat([value.combinedBytes, Buffer.from("\n")]),
            value => { const parsed = JSON.parse(value.combinedBytes); parsed.context.runAttempt = "3";
                value.combinedBytes = jsonBytes(parsed); },
            value => { const parsed = JSON.parse(value.combinedBytes); parsed.ordinary.sha256 = "0".repeat(64);
                value.combinedBytes = jsonBytes(parsed); },
            value => { const parsed = JSON.parse(value.combinedBytes); parsed.capability = "execution-failed";
                parsed.status = "failed"; value.combinedBytes = jsonBytes(parsed); },
            value => { const parsed = JSON.parse(value.ordinaryBytes); parsed.process.cleanupProven = false;
                value.ordinaryBytes = jsonBytes(parsed); },
            value => { const parsed = JSON.parse(value.ordinaryBytes); parsed.streams.stdout.sha256 = "0".repeat(64);
                value.ordinaryBytes = jsonBytes(parsed); },
            value => { const parsed = JSON.parse(value.ordinaryBytes); parsed.source.sha256 = "0".repeat(64);
                value.ordinaryBytes = jsonBytes(parsed); },
            value => { const parsed = JSON.parse(value.combinedBytes); parsed.privileged.argv[6] = "/tmp/probe";
                value.combinedBytes = jsonBytes(parsed); },
            value => { const parsed = JSON.parse(value.combinedBytes);
                parsed.privileged.probeBinary.sha256 = "0".repeat(64); value.combinedBytes = jsonBytes(parsed); }
        ];
        for (const mutate of cases) {
            const input = request({kvmEvidence: evidence(permissionProbe())});
            mutate(input.kvmEvidence);
            assert.throws(() => assessWindowsCpuFloorAdmission(input), /KVM|canonical|context|identity|usable/u);
        }
    });

    it("rejects schema additions, path escape, unsupported filesystems and mutable input aliases", () => {
        const extra = request();
        extra.observations.extra = true;
        assert.throws(() => assessWindowsCpuFloorAdmission(extra), /keys/u);
        const escaped = request();
        escaped.observations.taskRoot.path = `/home/runner/work/myspeed-windows-cpu-floor-${NONCE}`;
        assert.throws(() => assessWindowsCpuFloorAdmission(escaped), /task root/u);
        const unsupported = request();
        unsupported.observations.filesystem.type = "nfs";
        assert.throws(() => assessWindowsCpuFloorAdmission(unsupported), /filesystem type/u);
        const input = request();
        const result = assessWindowsCpuFloorAdmission(input);
        input.observations.memory.memAvailableBytes = "1";
        assert.notEqual(result.observations.memory.memAvailableBytes, "1");
    });
});
