import path from "node:path";

import {validateHostedContext} from "./linux-kvm-capability.mjs";
import {buildQemuArguments, validateEarlyBoot, validateStage2Paths, validateWindowsSystemTools} from
    "./linux-windows-cpu-floor-stage2.mjs";
import {validateInstallerBootConfirmation} from "./linux-windows-cpu-floor-stage2-qmp.mjs";
import {buildWindowsMsiSetupCompleteActivation, getCompletedWindowsMsiActivationEvidence} from
    "./windows-msi-post-setup-activation.mjs";

const SCHEMA_VERSION = 1;
const SHA256 = /^[a-f0-9]{64}$/u;
const DECIMAL = /^(?:0|[1-9][0-9]*)$/u;
const POSITIVE_DECIMAL = /^[1-9][0-9]*$/u;
const STAGE2_CLASSIFICATION = "github-hosted-windows-cpu-floor-stage2-calibration-nonqualifying";
const STAGE2_SYSTEM_VIRTUAL_BYTES = "51539607552";
const MAX_PROCESS_ID = 0x7fff_ffff;
const MAX_START_TICKS_DIGITS = 24;
const STAGE2_BASE_KEYS = Object.freeze(["argv", "classification", "cleanupProven", "context", "cpuCalibrationAccepted", "earlyBoot",
    "guest", "installWim", "installWimRemoval", "iso", "media", "packageClosure", "privilegeMode", "probeArtifact", "probes",
    "qemuProcess", "qualifying", "releaseGateCleared", "schemaVersion", "selectedImage", "stage", "status",
    "toolchain"]);
const QEMU_PROCESS_KEYS = ["cleanupProven", "exitCode", "launcherExecutablePath", "processGroupId", "qemuPid",
    "qemuPidAbsentAfter", "qemuStartTicks", "signal", "terminationReason", "timedOut", "treeGone"];
const FILE_WRITE_BITS = 0o222;
const SEALED_MODE = "444";
const STAGE2_ROOT_PREFIX = "/home/runner/work/_temp/myspeed-windows-cpu-floor-";
const SEAL_KEYS = ["authority", "context", "image", "kind", "schemaVersion", "source", "status"];
const SEAL_SOURCE_KEYS = ["activation", "guestOutputSha256", "preparedSystemDisk", "processGroupId", "qemuPid",
    "qemuStartTicks", "stage2Classification", "systemTools"];
const SEAL_IMAGE_KEYS = ["backingFilename", "bytes", "dev", "format", "ino", "kind", "ownership", "path",
    "sealedReadOnly", "sha256", "virtualBytes"];

function deepFreeze(value) {
    if (value && typeof value === "object" && !Object.isFrozen(value)) {
        Object.freeze(value);
        for (const child of Object.values(value)) deepFreeze(child);
    }
    return value;
}

function exactKeys(value, expected, label) {
    if (!value || typeof value !== "object" || Array.isArray(value) ||
        JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...expected].sort()))
        throw new TypeError(`${label} keys are invalid`);
}

function exactString(value, pattern, label) {
    if (typeof value !== "string") throw new TypeError(`${label} is invalid`);
    const match = pattern.exec(value);
    if (!match || match[0].length !== value.length) throw new TypeError(`${label} is invalid`);
    return value;
}

function same(left, right) {
    return JSON.stringify(left) === JSON.stringify(right);
}

function expectedActivation(context) {
    const activation = buildWindowsMsiSetupCompleteActivation({repository: context.repository,
        sourceSha: context.sourceSha, eventSha: context.eventSha, runId: context.runId,
        runAttempt: context.runAttempt, nonce: context.nonce});
    return getCompletedWindowsMsiActivationEvidence(activation);
}

function validateRootTool(value, expectedPath, label, hasInvocationPath = false) {
    exactKeys(value, hasInvocationPath ? ["bytes", "invocationPath", "ownership", "path", "sha256"] :
        ["bytes", "ownership", "path", "sha256"], label);
    exactKeys(value.ownership, ["gid", "mode", "ordinaryUserWritable", "uid"], `${label} ownership`);
    if (value.path !== expectedPath || (hasInvocationPath && value.invocationPath !== expectedPath) ||
        value.ownership.uid !== "0" || value.ownership.gid !== "0" ||
        value.ownership.ordinaryUserWritable !== false)
        throw new TypeError(`${label} identity differs`);
    exactString(value.bytes, POSITIVE_DECIMAL, `${label} bytes`);
    exactString(value.sha256, SHA256, `${label} SHA-256`);
    exactString(value.ownership.mode, /^[4567][045][045]$/u, `${label} mode`);
}

function validateGuest(value, outputDisk, expectedContext) {
    exactKeys(value, ["activation", "cpu", "instructions", "network", "output", "schemaVersion", "status",
        "systemTools"],
        "Stage 2 guest");
    if (value.schemaVersion !== SCHEMA_VERSION || value.status !== "observed")
        throw new TypeError("Stage 2 guest header is invalid");
    exactKeys(value.cpu, ["avx", "avx2", "osxsave", "popcnt", "sse42", "xcr0"], "Stage 2 guest CPU");
    if (!same(value.cpu, {sse42: true, popcnt: true, osxsave: false, avx: false, avx2: false, xcr0: null}))
        throw new TypeError("Stage 2 guest CPU floor differs");
    exactKeys(value.instructions, ["avx", "avx2", "popcnt", "sse42"], "Stage 2 guest instructions");
    if (!same(value.instructions, {sse42: "completed", popcnt: "completed", avx: "illegal-instruction",
        avx2: "illegal-instruction"})) throw new TypeError("Stage 2 guest instructions differ");
    exactKeys(value.network, ["enabledNonLoopbackInterfaces", "hardwareNics", "nonLoopbackRoutes"],
        "Stage 2 guest network");
    if (Object.values(value.network).some(count => count !== 0))
        throw new TypeError("Stage 2 guest NIC-none observation differs");
    if (!same(value.activation, expectedActivation(expectedContext)))
        throw new TypeError("Stage 2 guest MSI post-setup activation differs");
    validateWindowsSystemTools(value.systemTools);
    exactKeys(value.output, ["bytes", "path", "sha256"], "Stage 2 guest output");
    if (value.output.path !== outputDisk || value.output.bytes !== "67108864")
        throw new TypeError("Stage 2 guest output binding differs");
    exactString(value.output.sha256, SHA256, "Stage 2 guest output SHA-256");
}

function validateQemuProcess(value, loaderPath) {
    exactKeys(value, QEMU_PROCESS_KEYS, "Stage 2 QEMU process");
    if (value.cleanupProven !== true || value.exitCode !== 0 || value.signal !== null || value.timedOut !== false ||
        value.treeGone !== true || value.qemuPidAbsentAfter !== true || value.terminationReason !== null ||
        value.launcherExecutablePath !== loaderPath) throw new TypeError("Stage 2 QEMU cleanup evidence differs");
    validateProcessIdentity(value.processGroupId, value.qemuPid, value.qemuStartTicks, "Stage 2");
}

function validateProcessIdentity(processGroupId, qemuPid, qemuStartTicks, label) {
    if (!Number.isSafeInteger(processGroupId) || processGroupId < 1 || processGroupId > MAX_PROCESS_ID ||
        !Number.isSafeInteger(qemuPid) || qemuPid < 1 || qemuPid > MAX_PROCESS_ID)
        throw new TypeError(`${label} process identity is invalid`);
    exactString(qemuStartTicks, new RegExp(`^[1-9][0-9]{0,${MAX_START_TICKS_DIGITS - 1}}$`, "u"),
        `${label} QEMU start ticks`);
}

function validateStage2Evidence(value, expectedContext, checkedPaths) {
    const expectedKeys = [...STAGE2_BASE_KEYS];
    if (Object.hasOwn(value ?? {}, "bootConfirmation")) {
        validateInstallerBootConfirmation(value.bootConfirmation);
        if (value.bootConfirmation === undefined)
            throw new TypeError("Stage 2 boot confirmation is invalid");
        expectedKeys.push("bootConfirmation");
    }
    exactKeys(value, expectedKeys, "Stage 2 result");
    if (value.schemaVersion !== SCHEMA_VERSION || value.status !== "observed" || value.stage !== "complete" ||
        value.classification !== STAGE2_CLASSIFICATION || value.qualifying !== false ||
        value.releaseGateCleared !== false || value.cpuCalibrationAccepted !== true || value.cleanupProven !== true ||
        !["ordinary-kvm", "reviewed-sudo-kvm"].includes(value.privilegeMode) ||
        !same(value.context, expectedContext)) throw new TypeError("Stage 2 accepted result differs");
    if (!value.toolchain || typeof value.toolchain !== "object" || !value.toolchain.runtime)
        throw new TypeError("Stage 2 toolchain identity is incomplete");
    validateRootTool(value.toolchain.qemuImg, `${checkedPaths.portableRoot}/usr/bin/qemu-img`,
        "Stage 2 qemu-img", true);
    validateRootTool(value.toolchain.runtime.loader,
        `${checkedPaths.portableRoot}/usr/lib/x86_64-linux-gnu/ld-linux-x86-64.so.2`, "Stage 2 runtime loader");
    validateRootTool(value.toolchain.ovmfCode, `${checkedPaths.portableRoot}/usr/share/OVMF/OVMF_CODE_4M.fd`,
        "Stage 2 OVMF code");
    if (!same(value.argv, buildQemuArguments({paths: checkedPaths, toolchain: value.toolchain})))
        throw new TypeError("Stage 2 NIC-none QEMU vector differs");
    exactKeys(value.media, ["outputDisk", "ovmfVars", "seedIso", "systemDisk"], "Stage 2 media");
    exactKeys(value.media.systemDisk, ["bytes", "format", "path", "sha256", "virtualBytes"],
        "Stage 2 prepared system disk");
    if (value.media.systemDisk.path !== checkedPaths.systemDisk || value.media.systemDisk.format !== "qcow2" ||
        value.media.systemDisk.virtualBytes !== STAGE2_SYSTEM_VIRTUAL_BYTES)
        throw new TypeError("Stage 2 prepared system disk differs");
    exactString(value.media.systemDisk.bytes, POSITIVE_DECIMAL, "Stage 2 prepared system disk bytes");
    exactString(value.media.systemDisk.sha256, SHA256, "Stage 2 prepared system disk SHA-256");
    validateQemuProcess(value.qemuProcess, value.toolchain.runtime.loader.path);
    validateEarlyBoot(value.earlyBoot, checkedPaths, value.bootConfirmation);
    validateGuest(value.guest, checkedPaths.outputDisk, expectedContext);
    return value;
}

function validateFileIdentity(value, expectedPath, label) {
    exactKeys(value, ["bytes", "dev", "ino", "kind", "ownership", "path", "sha256"], label);
    exactKeys(value.ownership, ["gid", "mode", "ordinaryUserWritable", "uid"], `${label} ownership`);
    if (value.path !== expectedPath || value.kind !== "file" ||
        typeof value.ownership.ordinaryUserWritable !== "boolean")
        throw new TypeError(`${label} is invalid`);
    exactString(value.dev, POSITIVE_DECIMAL, `${label} device`);
    exactString(value.ino, POSITIVE_DECIMAL, `${label} inode`);
    exactString(value.bytes, POSITIVE_DECIMAL, `${label} bytes`);
    exactString(value.sha256, SHA256, `${label} SHA-256`);
    exactString(value.ownership.uid, DECIMAL, `${label} UID`);
    exactString(value.ownership.gid, DECIMAL, `${label} GID`);
    exactString(value.ownership.mode, /^[0-7]{3,4}$/u, `${label} mode`);
    return structuredClone(value);
}

function validateQcow2(value) {
    exactKeys(value, ["backingFilename", "format", "virtualBytes"], "installed base qemu-img observation");
    if (value.format !== "qcow2" || value.virtualBytes !== STAGE2_SYSTEM_VIRTUAL_BYTES || value.backingFilename !== null)
        throw new TypeError(value.backingFilename === null ? "installed base qemu-img identity differs" :
            "installed base backing file is forbidden");
    return structuredClone(value);
}

function validateSealed(before, after) {
    if (after.path !== before.path || after.dev !== before.dev || after.ino !== before.ino ||
        after.bytes !== before.bytes || after.sha256 !== before.sha256)
        throw new TypeError("installed base changed while sealing");
    const mode = Number.parseInt(after.ownership.mode, 8);
    if (after.ownership.uid !== "0" || after.ownership.gid !== "0" ||
        after.ownership.ordinaryUserWritable !== false || (mode & FILE_WRITE_BITS) !== 0)
        throw new TypeError("installed base is not root-owned and read-only");
}

export function validateSameJobInstalledBaseSeal(value, expectedContext) {
    const checkedContext = validateHostedContext(expectedContext);
    exactKeys(value, SEAL_KEYS, "installed base seal");
    if (value.schemaVersion !== SCHEMA_VERSION || value.kind !== "myspeed-stage2-installed-base-same-job-ephemeral" ||
        value.status !== "sealed" || value.authority !== "same-job-ephemeral-identity-only" ||
        !same(value.context, checkedContext)) throw new TypeError("installed base seal header is invalid");
    exactKeys(value.source, SEAL_SOURCE_KEYS, "installed base seal source");
    if (value.source.stage2Classification !== STAGE2_CLASSIFICATION)
        throw new TypeError("installed base seal Stage 2 classification differs");
    if (!same(value.source.activation, expectedActivation(checkedContext)))
        throw new TypeError("installed base seal MSI post-setup activation differs");
    validateWindowsSystemTools(value.source.systemTools);
    validateProcessIdentity(value.source.processGroupId, value.source.qemuPid, value.source.qemuStartTicks,
        "installed base seal");
    exactString(value.source.guestOutputSha256, SHA256, "installed base seal guest output SHA-256");
    exactKeys(value.source.preparedSystemDisk, ["bytes", "sha256"], "installed base seal prepared system disk");
    exactString(value.source.preparedSystemDisk.bytes, POSITIVE_DECIMAL,
        "installed base seal prepared system disk bytes");
    exactString(value.source.preparedSystemDisk.sha256, SHA256,
        "installed base seal prepared system disk SHA-256");
    exactKeys(value.image, SEAL_IMAGE_KEYS, "installed base seal image");
    const expectedRoot = `${STAGE2_ROOT_PREFIX}${checkedContext.nonce}`;
    exactString(value.image.path, /^[^\x00-\x1f\x7f]{1,512}$/u, "installed base seal image path");
    if (!value.image.path.startsWith(`${expectedRoot}/`) || path.posix.normalize(value.image.path) !== value.image.path)
        throw new TypeError("installed base seal image path is invalid");
    const identity = validateFileIdentity({path: value.image.path, kind: value.image.kind, dev: value.image.dev,
        ino: value.image.ino, bytes: value.image.bytes, sha256: value.image.sha256,
        ownership: value.image.ownership}, value.image.path, "installed base seal image");
    validateSealed(identity, identity);
    validateQcow2({format: value.image.format, virtualBytes: value.image.virtualBytes,
        backingFilename: value.image.backingFilename});
    if (value.image.sealedReadOnly !== true || value.image.sha256 === value.source.preparedSystemDisk.sha256)
        throw new TypeError("installed base seal image identity is invalid");
    return deepFreeze(structuredClone(value));
}

export async function sealSameJobInstalledBase({expectedContext, paths, stage2Result}, operations) {
    const required = ["inspectFile", "inspectQcow2", "observeQemuGroup", "sealExact"];
    if (!operations || typeof operations !== "object" || required.some(name => typeof operations[name] !== "function"))
        throw new TypeError("installed base sealing operation is absent");
    const checkedContext = validateHostedContext(expectedContext);
    const checkedPaths = validateStage2Paths(paths, checkedContext);
    const evidence = validateStage2Evidence(stage2Result, checkedContext, checkedPaths);
    const group = await operations.observeQemuGroup({processGroupId: evidence.qemuProcess.processGroupId,
        qemuPid: evidence.qemuProcess.qemuPid, qemuStartTicks: evidence.qemuProcess.qemuStartTicks});
    exactKeys(group, ["activeProcesses", "processGroupId"], "installed base QEMU process group observation");
    if (group.processGroupId !== evidence.qemuProcess.processGroupId || group.activeProcesses !== 0)
        throw new TypeError("installed base QEMU process group is not empty");
    const before = validateFileIdentity(await operations.inspectFile({path: checkedPaths.systemDisk}),
        checkedPaths.systemDisk, "installed base before sealing");
    if (before.sha256 === evidence.media.systemDisk.sha256)
        throw new TypeError("installed base still has the prepared empty-disk identity");
    const image = validateQcow2(await operations.inspectQcow2({path: checkedPaths.systemDisk,
        qemuImgPath: evidence.toolchain.qemuImg.path}));
    await operations.sealExact({path: checkedPaths.systemDisk, kind: "file", dev: before.dev, ino: before.ino,
        uid: "0", gid: "0", mode: SEALED_MODE});
    const after = validateFileIdentity(await operations.inspectFile({path: checkedPaths.systemDisk}),
        checkedPaths.systemDisk, "installed base after sealing");
    validateSealed(before, after);
    const sealed = {schemaVersion: SCHEMA_VERSION, kind: "myspeed-stage2-installed-base-same-job-ephemeral",
        status: "sealed", authority: "same-job-ephemeral-identity-only", context: structuredClone(checkedContext),
        source: {stage2Classification: evidence.classification,
            activation: structuredClone(evidence.guest.activation),
            systemTools: structuredClone(evidence.guest.systemTools),
            processGroupId: evidence.qemuProcess.processGroupId,
            qemuPid: evidence.qemuProcess.qemuPid, qemuStartTicks: evidence.qemuProcess.qemuStartTicks,
            guestOutputSha256: evidence.guest.output.sha256,
            preparedSystemDisk: {bytes: evidence.media.systemDisk.bytes, sha256: evidence.media.systemDisk.sha256}},
        image: {...after, ...image, sealedReadOnly: true}};
    return validateSameJobInstalledBaseSeal(sealed, checkedContext);
}
