import crypto from "node:crypto";
import path from "node:path";

import {KVM_PROBE_SOURCE, classifyKvmProbe,
    validateHostedContext} from "./linux-kvm-capability.mjs";

const SCHEMA_VERSION = 1;
const MAX_RESULT_BYTES = 262_144;
const MAX_TOOL_BYTES = 1_048_576;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const DECIMAL_PATTERN = /^(?:0|[1-9][0-9]*)$/u;
const SAFE_TEXT_PATTERN = /^[^\x00-\x1f\x7f]+$/u;
const ALLOWED_FILESYSTEMS = new Set(["btrfs", "ext4", "overlay", "xfs"]);
const ORDINARY_CLASSIFICATION = "github-hosted-linux-kvm-capability-nonqualifying";
const COMBINED_CLASSIFICATION = "github-hosted-linux-kvm-privileged-capability-nonqualifying";
const ADMISSION_CLASSIFICATION = "github-hosted-windows-cpu-floor-admission-nonqualifying";

const ORDINARY_KEYS = ["capability", "classification", "closure", "compiler", "context", "durationNs",
    "finishedMonotonicNs", "probe", "probeBinary", "process", "qualifying", "releaseGateCleared", "resources",
    "schemaVersion", "source", "startedMonotonicNs", "status", "streams"];
const COMBINED_BASE_KEYS = ["capability", "classification", "context", "ordinary", "qualifying",
    "releaseGateCleared", "retryPerformed", "schemaVersion", "status"];
const OBSERVATION_KEYS = ["filesystem", "memory", "taskRoot"];
const TASK_ROOT_KEYS = ["exists", "parentWritableByCurrentUser", "path"];
const FILESYSTEM_KEYS = ["availableBlocks", "availableBytes", "fragmentSizeBytes", "mountOptions", "mountPoint",
    "remote", "taskPath", "type"];
const MEMORY_KEYS = ["cgroupHeadroomBytes", "cgroupLevels", "effectiveAvailableBytes", "memAvailableBytes",
    "selfCgroupPath"];
const CGROUP_LEVEL_KEYS = ["currentBytes", "limitBytes", "mountPoint", "mountRoot", "path"];

export const STAGE2_LIMITS = Object.freeze({
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

function deepFreeze(value) {
    if (value && typeof value === "object" && !Object.isFrozen(value)) {
        Object.freeze(value);
        for (const child of Object.values(value)) deepFreeze(child);
    }
    return value;
}

function assertKeys(value, expected, name) {
    if (value === null || typeof value !== "object" || Array.isArray(value) ||
        JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...expected].sort()))
        throw new TypeError(`${name} keys are invalid`);
}

function assertBoolean(value, name) {
    if (typeof value !== "boolean") throw new TypeError(`${name} is invalid`);
    return value;
}

function assertExactString(value, pattern, name) {
    if (typeof value !== "string") throw new TypeError(`${name} is invalid`);
    const match = value.match(pattern);
    if (!match || match[0] !== value) throw new TypeError(`${name} is invalid`);
    return value;
}

function parseDecimal(value, name, {positive = false} = {}) {
    assertExactString(value, DECIMAL_PATTERN, name);
    if (value.length > 24) throw new TypeError(`${name} is invalid`);
    const parsed = BigInt(value);
    if (positive && parsed === 0n) throw new TypeError(`${name} is invalid`);
    return parsed;
}

function sha256(bytes) {
    return crypto.createHash("sha256").update(bytes).digest("hex");
}

function decodeSerializedStream(value, name) {
    assertKeys(value, ["base64", "bytes", "sha256"], name);
    if (typeof value.base64 !== "string" || !Number.isInteger(value.bytes) || value.bytes < 0 ||
        value.bytes > MAX_RESULT_BYTES) throw new TypeError(`${name} is invalid`);
    assertExactString(value.sha256, SHA256_PATTERN, `${name} hash`);
    const bytes = Buffer.from(value.base64, "base64");
    if (bytes.toString("base64") !== value.base64 || bytes.length !== value.bytes || sha256(bytes) !== value.sha256)
        throw new TypeError(`${name} identity mismatch`);
    return bytes;
}

function validateFileDigest(value, name, {expectedBytes = null, expectedSha256 = null} = {}) {
    assertKeys(value, ["bytes", "sha256"], name);
    if (!Number.isInteger(value.bytes) || value.bytes < 1 || value.bytes > MAX_RESULT_BYTES)
        throw new TypeError(`${name} byte count is invalid`);
    assertExactString(value.sha256, SHA256_PATTERN, `${name} hash`);
    if ((expectedBytes !== null && value.bytes !== expectedBytes) ||
        (expectedSha256 !== null && value.sha256 !== expectedSha256))
        throw new TypeError(`${name} identity mismatch`);
    return {bytes: value.bytes, sha256: value.sha256};
}

function parseProcessIdentity(bytes, name) {
    if (bytes.length < 3 || bytes.at(-1) !== 0x0a) throw new TypeError(`${name} bytes are invalid`);
    let value;
    try { value = JSON.parse(new TextDecoder("utf-8", {fatal: true}).decode(bytes.subarray(0, -1))); }
    catch { throw new TypeError(`${name} is invalid`); }
    assertKeys(value, ["kind", "pid", "schemaVersion", "startTicks"], name);
    if (value.schemaVersion !== SCHEMA_VERSION || value.kind !== "linux-kvm-probe-process" ||
        !Number.isInteger(value.pid) || value.pid < 1 || value.pid > 0x7fff_ffff)
        throw new TypeError(`${name} is invalid`);
    parseDecimal(value.startTicks, `${name} start ticks`, {positive: true});
    if (!bytes.equals(Buffer.from(`${JSON.stringify(value)}\n`))) throw new TypeError(`${name} is not canonical`);
    return value;
}

function validatePrivilegedTool(value, expectedPath, name) {
    assertKeys(value, ["bytes", "facts", "path", "sha256", "version", "versionObservation"], name);
    if (value.path !== expectedPath || !Number.isInteger(value.bytes) || value.bytes < 1 ||
        value.bytes > MAX_TOOL_BYTES) throw new TypeError(`${name} identity is invalid`);
    assertExactString(value.sha256, SHA256_PATTERN, `${name} hash`);
    assertExactString(value.version, SAFE_TEXT_PATTERN, `${name} version`);
    assertKeys(value.facts, ["dev", "gid", "ino", "mode", "size", "uid"], `${name} facts`);
    for (const key of ["dev", "ino", "mode", "size", "uid", "gid"])
        parseDecimal(value.facts[key], `${name} ${key}`);
    if (value.facts.uid !== "0" || value.facts.gid !== "0" || value.facts.size !== String(value.bytes) ||
        (BigInt(value.facts.mode) & 0o22n) !== 0n) throw new TypeError(`${name} ownership is invalid`);
    assertKeys(value.versionObservation, ["process", "stderr", "stdout"], `${name} version observation`);
    const stdout = decodeSerializedStream(value.versionObservation.stdout, `${name} version stdout`);
    const stderr = decodeSerializedStream(value.versionObservation.stderr, `${name} version stderr`);
    const processValue = value.versionObservation.process;
    assertKeys(processValue, ["cleanupProven", "errorObserved", "exitCode", "signal", "stderrOverflow",
        "stdoutOverflow", "timedOut"], `${name} version process`);
    if (processValue.exitCode !== 0 || processValue.signal !== null || processValue.timedOut !== false ||
        processValue.stdoutOverflow !== false || processValue.stderrOverflow !== false ||
        processValue.cleanupProven !== true || processValue.errorObserved !== false || stderr.length !== 0 ||
        !stdout.toString("utf8").startsWith(`${value.version}\n`))
        throw new TypeError(`${name} version observation is invalid`);
}

function parseCanonicalEvidence(bytes, name) {
    if (!Buffer.isBuffer(bytes) || bytes.length < 3 || bytes.length > MAX_RESULT_BYTES ||
        bytes[bytes.length - 1] !== 0x0a || bytes[bytes.length - 2] === 0x0a)
        throw new TypeError(`${name} KVM evidence bytes are invalid`);
    let text;
    try { text = new TextDecoder("utf-8", {fatal: true}).decode(bytes.subarray(0, -1)); }
    catch { throw new TypeError(`${name} KVM evidence UTF-8 is invalid`); }
    let value;
    try { value = JSON.parse(text); } catch { throw new TypeError(`${name} KVM evidence JSON is invalid`); }
    if (`${JSON.stringify(value)}\n` !== bytes.toString("utf8"))
        throw new TypeError(`${name} KVM evidence is not canonical`);
    return {value, identity: {bytes: bytes.length, sha256: sha256(bytes)}};
}

function sameContext(left, right) {
    return JSON.stringify(left) === JSON.stringify(right);
}

function validateOrdinaryEvidence(bytes, expectedContext) {
    const parsed = parseCanonicalEvidence(bytes, "ordinary");
    const value = parsed.value;
    assertKeys(value, ORDINARY_KEYS, "ordinary KVM evidence");
    if (value.schemaVersion !== SCHEMA_VERSION || value.classification !== ORDINARY_CLASSIFICATION ||
        value.qualifying !== false || value.releaseGateCleared !== false)
        throw new TypeError("ordinary KVM evidence header is invalid");
    const checkedContext = validateHostedContext(value.context);
    if (!sameContext(checkedContext, expectedContext)) throw new TypeError("ordinary KVM context mismatch");
    assertKeys(value.closure, ["bytes", "name", "sha256"], "ordinary KVM closure");
    if (value.closure.name !== "linux-kvm-capability.mjs")
        throw new TypeError("ordinary KVM closure identity is invalid");
    validateFileDigest({bytes: value.closure.bytes, sha256: value.closure.sha256}, "ordinary KVM closure");
    validateFileDigest(value.source, "ordinary KVM source", {expectedBytes: Buffer.byteLength(KVM_PROBE_SOURCE),
        expectedSha256: sha256(Buffer.from(KVM_PROBE_SOURCE))});
    const probeBinary = validateFileDigest(value.probeBinary, "ordinary KVM probe binary");
    const verdict = classifyKvmProbe({process: value.process, probe: value.probe});
    assertKeys(value.streams, ["stderr", "stdout"], "ordinary KVM streams");
    const stdout = decodeSerializedStream(value.streams.stdout, "ordinary KVM stdout");
    const stderr = decodeSerializedStream(value.streams.stderr, "ordinary KVM stderr");
    parseProcessIdentity(stderr, "ordinary KVM process identity");
    if (!stdout.equals(Buffer.from(`${JSON.stringify(value.probe)}\n`)))
        throw new TypeError("ordinary KVM raw streams differ from probe");
    const expectedStatus = verdict.usable ? "passed" : "failed";
    if (value.capability !== verdict.classification || value.status !== expectedStatus ||
        !["usable", "permission-denied"].includes(verdict.classification))
        throw new TypeError("ordinary KVM evidence is not usable or retryable");
    return {value, probeBinary, identity: {...parsed.identity, capability: value.capability}};
}

function validateCombinedEvidence(bytes, ordinary, expectedContext) {
    const parsed = parseCanonicalEvidence(bytes, "combined");
    const value = parsed.value;
    const expectedKeys = value.retryPerformed === true ? [...COMBINED_BASE_KEYS, "privileged"] : COMBINED_BASE_KEYS;
    assertKeys(value, expectedKeys, "combined KVM evidence");
    if (value.schemaVersion !== SCHEMA_VERSION || value.classification !== COMBINED_CLASSIFICATION ||
        value.status !== "observed" || value.qualifying !== false || value.releaseGateCleared !== false)
        throw new TypeError("combined KVM evidence header is invalid");
    const checkedContext = validateHostedContext(value.context);
    if (!sameContext(checkedContext, expectedContext)) throw new TypeError("combined KVM context mismatch");
    assertKeys(value.ordinary, ["bytes", "capability", "sha256"], "combined KVM ordinary identity");
    assertExactString(value.ordinary.sha256, SHA256_PATTERN, "combined KVM ordinary hash");
    if (value.ordinary.bytes !== ordinary.identity.bytes || value.ordinary.sha256 !== ordinary.identity.sha256 ||
        value.ordinary.capability !== ordinary.identity.capability)
        throw new TypeError("combined KVM ordinary identity mismatch");
    if (ordinary.value.capability === "usable") {
        if (value.retryPerformed !== false || value.capability !== "ordinary-usable")
            throw new TypeError("combined KVM ordinary usable result is invalid");
    } else {
        if (value.retryPerformed !== true || value.capability !== "usable")
            throw new TypeError("combined KVM privileged retry is not usable");
        assertKeys(value.privileged, ["argv", "observation", "probe", "probeBinary", "rootProbeProcess", "tools"],
            "combined KVM privileged evidence");
        assertKeys(value.privileged.observation, ["process", "stderr", "stdout"],
            "combined KVM privileged observation");
        validateFileDigest(value.privileged.probeBinary, "combined KVM probe binary",
            {expectedBytes: ordinary.probeBinary.bytes, expectedSha256: ordinary.probeBinary.sha256});
        const expectedProbePath = `/home/runner/work/_temp/myspeed-kvm-capability-${expectedContext.nonce}/probe`;
        const expectedArgv = ["-n", "--", "/usr/bin/timeout", "--foreground", "--signal=KILL", "30s",
            expectedProbePath];
        if (JSON.stringify(value.privileged.argv) !== JSON.stringify(expectedArgv))
            throw new TypeError("combined KVM privileged argv is invalid");
        assertKeys(value.privileged.tools, ["sudo", "timeout"], "combined KVM privileged tools");
        validatePrivilegedTool(value.privileged.tools.sudo, "/usr/bin/sudo", "sudo tool");
        validatePrivilegedTool(value.privileged.tools.timeout, "/usr/bin/timeout", "timeout tool");
        const privilegedStdout = decodeSerializedStream(value.privileged.observation.stdout,
            "combined KVM privileged stdout");
        const privilegedStderr = decodeSerializedStream(value.privileged.observation.stderr,
            "combined KVM privileged stderr");
        const verdict = classifyKvmProbe({process: value.privileged.observation.process,
            probe: value.privileged.probe});
        assertKeys(value.privileged.rootProbeProcess, ["after", "identity"], "root probe identity");
        assertKeys(value.privileged.rootProbeProcess.after, ["state"], "root probe final state");
        const parsedRootIdentity = parseProcessIdentity(privilegedStderr, "root probe process identity");
        if (!sameContext(parsedRootIdentity, value.privileged.rootProbeProcess.identity))
            throw new TypeError("root probe process identity is invalid");
        if (!verdict.usable || verdict.classification !== "usable" ||
            value.privileged.rootProbeProcess.after.state !== "absent" ||
            !privilegedStdout.equals(Buffer.from(`${JSON.stringify(value.privileged.probe)}\n`)))
            throw new TypeError("combined KVM privileged retry is not usable");
    }
    return {value, identity: {...parsed.identity, capability: value.capability,
        retryPerformed: value.retryPerformed}};
}

function assertAbsoluteNormalized(value, name) {
    assertExactString(value, SAFE_TEXT_PATTERN, name);
    if (!path.posix.isAbsolute(value) || path.posix.normalize(value) !== value)
        throw new TypeError(`${name} is invalid`);
    return value;
}

function validateObservations(value, checkedContext) {
    assertKeys(value, OBSERVATION_KEYS, "observations");
    assertKeys(value.taskRoot, TASK_ROOT_KEYS, "observations.taskRoot");
    const expectedRootName = `myspeed-windows-cpu-floor-${checkedContext.nonce}`;
    const taskRootPath = assertAbsoluteNormalized(value.taskRoot.path, "task root path");
    assertBoolean(value.taskRoot.exists, "task root exists");
    assertBoolean(value.taskRoot.parentWritableByCurrentUser, "task root parent writability");
    if (path.posix.basename(taskRootPath) !== expectedRootName)
        throw new TypeError("task root identity mismatch");

    assertKeys(value.filesystem, FILESYSTEM_KEYS, "observations.filesystem");
    const taskPath = assertAbsoluteNormalized(value.filesystem.taskPath, "filesystem task path");
    const mountPoint = assertAbsoluteNormalized(value.filesystem.mountPoint, "filesystem mount point");
    if (path.posix.dirname(taskRootPath) !== taskPath ||
        !(taskPath === mountPoint || taskPath.startsWith(mountPoint === "/" ? "/" : `${mountPoint}/`)))
        throw new TypeError("task root filesystem binding mismatch");
    if (!ALLOWED_FILESYSTEMS.has(value.filesystem.type)) throw new TypeError("filesystem type is not approved");
    assertExactString(value.filesystem.mountOptions, SAFE_TEXT_PATTERN, "filesystem mount options");
    assertBoolean(value.filesystem.remote, "filesystem remote");
    const availableBlocks = parseDecimal(value.filesystem.availableBlocks, "statvfs available blocks");
    const fragmentSize = parseDecimal(value.filesystem.fragmentSizeBytes, "statvfs fragment size", {positive: true});
    const availableBytes = parseDecimal(value.filesystem.availableBytes, "statvfs available bytes");
    if (availableBlocks * fragmentSize !== availableBytes)
        throw new TypeError("statvfs available bytes mismatch");

    assertKeys(value.memory, MEMORY_KEYS, "observations.memory");
    const memAvailable = parseDecimal(value.memory.memAvailableBytes, "MemAvailable", {positive: true});
    if (!Array.isArray(value.memory.cgroupLevels) || value.memory.cgroupLevels.length === 0 ||
        value.memory.cgroupLevels.length > 64) throw new TypeError("cgroup levels are invalid");
    let recomputedHeadroom = null;
    let priorPath = null;
    const selfCgroupPath = assertAbsoluteNormalized(value.memory.selfCgroupPath, "self cgroup path");
    for (const [index, level] of value.memory.cgroupLevels.entries()) {
        assertKeys(level, CGROUP_LEVEL_KEYS, `cgroup level ${index}`);
        const levelPath = assertAbsoluteNormalized(level.path, `cgroup level ${index} path`);
        const mountPointPath = assertAbsoluteNormalized(level.mountPoint, `cgroup level ${index} mount point`);
        const mountRootPath = assertAbsoluteNormalized(level.mountRoot, `cgroup level ${index} mount root`);
        if (!(levelPath === mountPointPath || levelPath.startsWith(`${mountPointPath}/`)))
            throw new TypeError("cgroup mount binding is invalid");
        if (index === 0 && levelPath !== mountPointPath) throw new TypeError("cgroup ancestry is invalid");
        if (index > 0 && (level.mountPoint !== value.memory.cgroupLevels[0].mountPoint ||
            level.mountRoot !== value.memory.cgroupLevels[0].mountRoot ||
            path.posix.dirname(levelPath) !== priorPath)) throw new TypeError("cgroup ancestry is invalid");
        priorPath = levelPath;
        if (level.limitBytes === null) {
            if (index === 0) {
                if (mountRootPath !== "/" || level.currentBytes !== null)
                    throw new TypeError("cgroup root-unlimited observation is invalid");
            } else parseDecimal(level.currentBytes, `cgroup level ${index} current`);
            continue;
        }
        const limit = parseDecimal(level.limitBytes, `cgroup level ${index} limit`, {positive: true});
        const current = parseDecimal(level.currentBytes, `cgroup level ${index} current`);
        if (current > limit) throw new TypeError("cgroup current memory exceeds limit");
        const headroom = limit - current;
        if (recomputedHeadroom === null || headroom < recomputedHeadroom) recomputedHeadroom = headroom;
    }
    if (priorPath !== selfCgroupPath) throw new TypeError("self cgroup binding is invalid");
    const cgroupHeadroom = value.memory.cgroupHeadroomBytes === null ? null :
        parseDecimal(value.memory.cgroupHeadroomBytes, "cgroup headroom");
    if (cgroupHeadroom !== recomputedHeadroom) throw new TypeError("cgroup headroom mismatch");
    const effective = parseDecimal(value.memory.effectiveAvailableBytes, "effective available memory");
    const recomputedEffective = cgroupHeadroom === null || memAvailable < cgroupHeadroom ? memAvailable : cgroupHeadroom;
    if (effective !== recomputedEffective) throw new TypeError("effective available memory mismatch");
    return structuredClone(value);
}

export function assessWindowsCpuFloorAdmission(input) {
    assertKeys(input, ["context", "kvmEvidence", "observations"], "admission request");
    const checkedContext = validateHostedContext(input.context);
    assertKeys(input.kvmEvidence, ["combinedBytes", "ordinaryBytes"], "KVM evidence");
    const ordinary = validateOrdinaryEvidence(input.kvmEvidence.ordinaryBytes, checkedContext);
    const combined = validateCombinedEvidence(input.kvmEvidence.combinedBytes, ordinary, checkedContext);
    const observations = validateObservations(input.observations, checkedContext);
    const reasons = [];
    if (BigInt(observations.filesystem.availableBytes) < BigInt(STAGE2_LIMITS.startFreeRequiredBytes))
        reasons.push("insufficient-filesystem-capacity");
    if (BigInt(observations.memory.effectiveAvailableBytes) <
        BigInt(STAGE2_LIMITS.startEffectiveAvailableMemoryBytes)) reasons.push("insufficient-effective-memory");
    if (observations.taskRoot.exists) reasons.push("task-root-already-exists");
    if (!observations.taskRoot.parentWritableByCurrentUser) reasons.push("task-root-parent-not-writable");
    if (observations.filesystem.remote) reasons.push("remote-filesystem");
    if (!observations.filesystem.mountOptions.split(",").includes("rw")) reasons.push("filesystem-not-writable");
    const admitted = reasons.length === 0;
    return deepFreeze({schemaVersion: SCHEMA_VERSION, status: admitted ? "admitted" : "rejected",
        classification: ADMISSION_CLASSIFICATION, admitted, qualifying: false, releaseGateCleared: false,
        mediaAcquisitionAuthorized: false, qemuLaunchAuthorized: false, context: checkedContext,
        kvm: {ordinary: ordinary.identity, combined: combined.identity}, budget: structuredClone(STAGE2_LIMITS),
        observations, reasons});
}
