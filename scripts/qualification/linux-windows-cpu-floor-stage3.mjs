import crypto from "node:crypto";
import path from "node:path";

import {validateHostedContext} from "./linux-kvm-capability.mjs";
import {STAGE2_PROVENANCE, buildQemuArguments as buildStage2QemuArguments,
    validatePackageClosure} from "./linux-windows-cpu-floor-stage2.mjs";
import {parseGuestOutput as parseStage2GuestOutput} from
    "./linux-windows-cpu-floor-stage2-hosted.mjs";
import {OPEN_GRAPH_QUALIFICATION_TIMEOUT_MS} from "./safety.mjs";

const SCHEMA_VERSION = 1;
const PROFILE = "baseline-cpu";
const CLASSIFICATION = "windows-baseline-cpu-floor-full-runtime-stage3-nonqualifying";
const CONFIRMATION = "RUN-WINDOWS-BASELINE-CPU-FLOOR";
const AUTHORIZATION_SCOPE = "windows-baseline-cpu-floor-full-runtime";
const CPU_MODEL = "Westmere-v2";
const CPU_VECTOR = `${CPU_MODEL},avx=off,avx2=off`;
const MACHINE_MODEL = "q35";
const GUEST_MEMORY = "6144M";
const GUEST_SMP = "2,sockets=1,cores=2,threads=1";
const OUTPUT_DISK_BYTES = "67108864";
const SYSTEM_DISK_VIRTUAL_BYTES = "51539607552";
const MAX_FAILURE_MESSAGE_CHARACTERS = 512;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const DECIMAL_PATTERN = /^(?:0|[1-9][0-9]{0,19})$/u;
const BASELINE_ARTIFACT = "MySpeed-windows-x64-baseline.exe";
const STAGED_CANDIDATE = "MySpeed.exe";
const SUMMARY_NAME = "qualification-summary.json";
const MANIFEST_NAME = "qualification-manifest.json";
const EXPECTED_PROCESS_SCENARIOS = Object.freeze(["populated-first-boot", "populated-restart",
    "fresh-no-config-reset"]);
const EXPECTED_DATABASE_SCENARIOS = Object.freeze(["preseeded-input", "after-first-shutdown",
    "after-second-shutdown", "fresh-no-config-reset"]);
const EXPECTED_OPEN_GRAPH_SCENARIOS = Object.freeze(["populated-first-boot", "populated-restart"]);
const RESET_NOTHING_TO_DO_EXIT = 113;
const SUCCESS_EXIT = 0;
const MAX_EMBEDDED_EVIDENCE_BYTES = 4 * 1024 * 1024;
const MAX_EMBEDDED_EVIDENCE_BASE64_CHARACTERS = 4 * Math.ceil(MAX_EMBEDDED_EVIDENCE_BYTES / 3);
const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;
const REGISTER_PATTERN = /^0x[a-f0-9]{8}$/u;
const PROBE_ROLES = Object.freeze(["avx", "avx2", "cpuid", "illegal", "known-bad", "known-good", "popcnt",
    "sse42"]);
const STAGE2_OUTPUT_DISK_BYTES = "67108864";
const STAGE2_SYSTEM_DISK_BYTES = "51539607552";

function keys(value, expected, name) {
    if (!value || typeof value !== "object" || Array.isArray(value) ||
        JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...expected].sort()))
        throw new TypeError(`${name} keys are invalid`);
}

function exactString(value, pattern, name) {
    if (typeof value !== "string") throw new TypeError(`${name} is invalid`);
    const match = pattern.exec(value);
    if (!match || match[0].length !== value.length) throw new TypeError(`${name} is invalid`);
    return value;
}

function decimal(value, name, {positive = false} = {}) {
    exactString(value, DECIMAL_PATTERN, name);
    const parsed = BigInt(value);
    if (positive && parsed === 0n) throw new TypeError(`${name} is invalid`);
    return parsed;
}

function same(left, right) { return JSON.stringify(left) === JSON.stringify(right); }

function decodeEvidence(value, expectedHash, name) {
    if (typeof value !== "string" || value.length > MAX_EMBEDDED_EVIDENCE_BASE64_CHARACTERS)
        throw new TypeError(`${name} base64 is invalid`);
    exactString(value, BASE64_PATTERN, `${name} base64`);
    exactString(expectedHash, SHA256_PATTERN, `${name} hash`);
    const bytes = Buffer.from(value, "base64");
    if (bytes.length < 2 || bytes.length > MAX_EMBEDDED_EVIDENCE_BYTES || bytes.toString("base64") !== value ||
        crypto.createHash("sha256").update(bytes).digest("hex") !== expectedHash)
        throw new TypeError(`${name} bytes differ`);
    let parsed;
    try { parsed = JSON.parse(new TextDecoder("utf-8", {fatal: true}).decode(bytes)); }
    catch { throw new TypeError(`${name} JSON is invalid`); }
    return {bytes, parsed};
}

function validateCpuidBytes(value) {
    keys(value, ["features", "kind", "leaf1", "leaf7Subleaf0", "maxBasicLeaf", "schemaVersion", "xcr0"],
        "baseline raw CPUID");
    keys(value.features, ["avx", "avx2", "osxsave", "popcnt", "sse42"], "baseline raw CPUID features");
    keys(value.leaf1, ["eax", "ebx", "ecx", "edx"], "baseline raw CPUID leaf 1");
    keys(value.leaf7Subleaf0, ["eax", "ebx", "ecx", "edx"], "baseline raw CPUID leaf 7");
    if (value.schemaVersion !== SCHEMA_VERSION || value.kind !== "cpuid" || !Number.isInteger(value.maxBasicLeaf) ||
        value.maxBasicLeaf < 7 || value.maxBasicLeaf > 0xffff_ffff || value.xcr0 !== null ||
        [...Object.values(value.leaf1), ...Object.values(value.leaf7Subleaf0)].some(item =>
            typeof item !== "string" || !REGISTER_PATTERN.test(item)))
        throw new TypeError("baseline raw CPUID is invalid");
    const leaf1 = Number.parseInt(value.leaf1.ecx.slice(2), 16);
    const leaf7 = Number.parseInt(value.leaf7Subleaf0.ebx.slice(2), 16);
    const projection = {sse42: ((leaf1 >>> 20) & 1) === 1, popcnt: ((leaf1 >>> 23) & 1) === 1,
        osxsave: ((leaf1 >>> 27) & 1) === 1, avx: ((leaf1 >>> 28) & 1) === 1,
        avx2: ((leaf7 >>> 5) & 1) === 1, xcr0: null};
    if (Object.keys(value.features).some(name => value.features[name] !== projection[name]))
        throw new TypeError("baseline raw CPUID feature projection differs");
    return projection;
}

function validateIdentity(value, name) {
    keys(value, ["bytes", "path", "sha256"], name);
    decimal(value.bytes, `${name} bytes`, {positive: true});
    exactString(value.sha256, SHA256_PATTERN, `${name} hash`);
    if (typeof value.path !== "string" || !value.path.startsWith("/") || path.posix.normalize(value.path) !== value.path)
        throw new TypeError(`${name} path is invalid`);
    return structuredClone(value);
}

function directChild(root, candidatePath, name) {
    if (candidatePath !== `${root}/${name}`) throw new TypeError(`${name} path is invalid`);
}

function validatePaths(value, context) {
    keys(value, ["outputDisk", "ovmfVars", "qemuPid", "root", "seedIso", "serialLog", "systemDisk"],
        "Stage 3 paths");
    const expectedRoot = `/home/runner/work/_temp/myspeed-stage3-${context.nonce}`;
    if (value.root !== expectedRoot) throw new TypeError("Stage 3 root is invalid");
    const names = {systemDisk: "stage3.qcow2", seedIso: "baseline-seed.iso",
        outputDisk: "baseline-output.img", ovmfVars: "OVMF_VARS.fd", qemuPid: "baseline-qemu.pid",
        serialLog: "baseline-serial.log"};
    for (const [field, name] of Object.entries(names)) directChild(expectedRoot, value[field], name);
    return structuredClone(value);
}

function validateOwnership(value, name) {
    keys(value, ["gid", "mode", "ordinaryUserWritable", "uid"], name);
    if (value.uid !== "0" || value.gid !== "0" || value.ordinaryUserWritable !== false ||
        !/^[4567][045][045]$/u.test(value.mode)) throw new TypeError(`${name} is invalid`);
}

function validatePortableIdentity(value, root, name, {invocationPath = null, version = false} = {}) {
    keys(value, ["bytes", ...(invocationPath === null ? [] : ["invocationPath"]), "ownership", "path", "sha256",
        ...(version ? ["version"] : [])], name);
    const id = validateIdentity({bytes: value.bytes, path: value.path, sha256: value.sha256}, name);
    if (!id.path.startsWith(`${root}/`)) throw new TypeError(`${name} path is invalid`);
    validateOwnership(value.ownership, `${name} ownership`);
    if (invocationPath !== null && value.invocationPath !== `${root}/${invocationPath}`)
        throw new TypeError(`${name} invocation path is invalid`);
}

function validateToolchain(value, context) {
    keys(value, ["capabilities", "firmware", "genisoimage", "installedFilesManifest", "licensesManifest", "mcopy", "mformat",
        "ovmfCode", "ovmfVarsTemplate", "packageClosureSha256", "qemu", "qemuImg", "runtime", "sevenZip",
        "wiminfo"], "Stage 3 toolchain");
    const root = `/tmp/myspeed-windows-cpu-floor-tools-${context.nonce}`;
    validatePortableIdentity(value.qemu, root, "QEMU tool", {invocationPath: "usr/bin/qemu-system-x86_64",
        version: true});
    validatePortableIdentity(value.ovmfCode, root, "OVMF code");
    validatePortableIdentity(value.ovmfVarsTemplate, root, "OVMF variables template");
    keys(value.firmware, ["kvmvapic", "searchPath", "vga"], "portable QEMU firmware");
    if (value.firmware.searchPath !== `${root}/usr/share/qemu`)
        throw new TypeError("portable QEMU firmware search path is invalid");
    for (const [k, expectedRel] of [["kvmvapic", "usr/share/qemu/kvmvapic.bin"],
        ["vga", "usr/share/seabios/vgabios-stdvga.bin"]]) {
        validatePortableIdentity(value.firmware[k], root, `portable QEMU ${k} firmware`);
        if (value.firmware[k].path !== `${root}/${expectedRel}`)
            throw new TypeError(`portable QEMU ${k} firmware path is invalid`);
    }
    keys(value.runtime, ["libraryPath", "loader"], "portable runtime");
    validatePortableIdentity(value.runtime.loader, root, "portable loader");
    if (!Array.isArray(value.runtime.libraryPath) || value.runtime.libraryPath.length < 1 ||
        value.runtime.libraryPath.length > 2 || new Set(value.runtime.libraryPath).size !== value.runtime.libraryPath.length ||
        value.runtime.libraryPath.some(item => typeof item !== "string" || !item.startsWith(`${root}/`) ||
            path.posix.normalize(item) !== item))
        throw new TypeError("Stage 3 toolchain path is invalid");
    keys(value.capabilities, ["accelerator", "cpuModels", "devices", "machines"], "QEMU capabilities");
    if (value.capabilities.accelerator !== "kvm" || !value.capabilities.cpuModels.includes(CPU_MODEL) ||
        !value.capabilities.machines.includes(MACHINE_MODEL) ||
        !["ich9-ahci", "ide-cd", "ide-hd", "isa-serial"].every(item => value.capabilities.devices.includes(item)))
        throw new TypeError("Stage 3 QEMU capability set is invalid");
    if (!value.qemu.version.startsWith("QEMU emulator version 8.2.2 "))
        throw new TypeError("Stage 3 QEMU version is invalid");
    exactString(value.packageClosureSha256, SHA256_PATTERN, "package closure hash");
    return structuredClone(value);
}

function validateIso(value) {
    keys(value, ["bytes", "digestProvenance", "etag", "finalUrl", "publisherDigestMatched", "sha256"], "Stage 2 ISO");
    decimal(value.bytes, "Stage 2 ISO bytes", {positive: true});
    exactString(value.sha256, SHA256_PATTERN, "Stage 2 ISO hash");
    if (value.bytes !== STAGE2_PROVENANCE.windowsIso.bytes || value.finalUrl !== STAGE2_PROVENANCE.windowsIso.finalUrl ||
        value.etag !== STAGE2_PROVENANCE.windowsIso.strongEtag ||
        value.digestProvenance !== STAGE2_PROVENANCE.windowsIso.digestProvenance || value.publisherDigestMatched !== null)
        throw new TypeError("Stage 2 ISO provenance is invalid");
    return structuredClone(value);
}

function stage2Paths(context) {
    const root = `/home/runner/work/_temp/myspeed-windows-cpu-floor-${context.nonce}`;
    return {root, packageRoot: `${root}/packages`, portableRoot: `/tmp/myspeed-windows-cpu-floor-tools-${context.nonce}`,
        windowsIso: `${root}/windows.iso`, installWim: `${root}/install.wim`, seedIso: `${root}/seed.iso`,
        outputDisk: `${root}/output.img`, systemDisk: `${root}/system.qcow2`, ovmfVars: `${root}/OVMF_VARS.fd`,
        serialLog: `${root}/serial.log`, probeRoot: `${root}/probes`, qemuPid: `${root}/qemu.pid`};
}

function validateStage2ProbeArtifact(value) {
    keys(value, ["archive", "artifactId", "artifactName", "files", "innerManifest", "repository", "runAttempt",
        "runId", "schemaVersion", "sourceSha"], "Stage 2 probe artifact");
    if (value.schemaVersion !== SCHEMA_VERSION || value.repository !== "i7Gamer/MySpeed" ||
        value.artifactName !== "windows-cpu-readiness-evidence") throw new TypeError("Stage 2 probe artifact differs");
    exactString(value.sourceSha, /^[a-f0-9]{40}$/u, "Stage 2 probe source SHA");
    for (const name of ["artifactId", "runAttempt", "runId"])
        exactString(value[name], /^[1-9][0-9]{0,19}$/u, `Stage 2 probe ${name}`);
    keys(value.archive, ["bytes", "sha256"], "Stage 2 probe archive");
    decimal(value.archive.bytes, "Stage 2 probe archive bytes", {positive: true});
    exactString(value.archive.sha256, SHA256_PATTERN, "Stage 2 probe archive hash");
    keys(value.innerManifest, ["bytes", "name", "sha256"], "Stage 2 probe inner manifest");
    if (value.innerManifest.name !== "result.json") throw new TypeError("Stage 2 probe inner manifest differs");
    decimal(value.innerManifest.bytes, "Stage 2 probe inner manifest bytes", {positive: true});
    exactString(value.innerManifest.sha256, SHA256_PATTERN, "Stage 2 probe inner manifest hash");
    if (!Array.isArray(value.files) || value.files.length !== PROBE_ROLES.length)
        throw new TypeError("Stage 2 probe files differ");
    const roles = new Set();
    for (const file of value.files) {
        keys(file, ["bytes", "name", "role", "sha256"], "Stage 2 probe file");
        if (!PROBE_ROLES.includes(file.role) || roles.has(file.role) ||
            file.name !== `${file.role.replaceAll("-", "_")}.exe`) throw new TypeError("Stage 2 probe role differs");
        roles.add(file.role);
        decimal(file.bytes, "Stage 2 probe file bytes", {positive: true});
        exactString(file.sha256, SHA256_PATTERN, "Stage 2 probe file hash");
    }
    return structuredClone(value);
}

function validateStage2Probes(value, artifact, pathsValue) {
    keys(value, ["archive", "files", "innerManifest"], "Stage 2 acquired probes");
    if (!same(value.archive, artifact.archive) || !same(value.innerManifest, artifact.innerManifest) ||
        !Array.isArray(value.files) || value.files.length !== PROBE_ROLES.length)
        throw new TypeError("Stage 2 acquired probe closure differs");
    for (const expected of artifact.files) {
        const matches = value.files.filter(file => file?.role === expected.role);
        if (matches.length !== 1) throw new TypeError("Stage 2 acquired probe role differs");
        const actual = matches[0];
        keys(actual, ["bytes", "name", "path", "role", "sha256"], "Stage 2 acquired probe file");
        if (actual.name !== expected.name || actual.bytes !== expected.bytes || actual.sha256 !== expected.sha256 ||
            actual.path !== `${pathsValue.probeRoot}/${expected.name}`)
            throw new TypeError("Stage 2 acquired probe identity differs");
    }
    return structuredClone(value);
}

function validateStage2Media(value, pathsValue, toolchain) {
    keys(value, ["outputDisk", "ovmfVars", "seedIso", "systemDisk"], "Stage 2 media");
    keys(value.seedIso, ["bytes", "format", "path", "sha256", "sourceManifestSha256", "volumeLabel"],
        "Stage 2 seed ISO");
    if (value.seedIso.path !== pathsValue.seedIso || value.seedIso.format !== "iso9660" ||
        value.seedIso.volumeLabel !== "MYSPEEDSEED") throw new TypeError("Stage 2 seed ISO differs");
    decimal(value.seedIso.bytes, "Stage 2 seed ISO bytes", {positive: true});
    exactString(value.seedIso.sha256, SHA256_PATTERN, "Stage 2 seed ISO hash");
    exactString(value.seedIso.sourceManifestSha256, SHA256_PATTERN, "Stage 2 seed manifest hash");
    keys(value.outputDisk, ["bytes", "format", "path", "sha256", "volumeLabel"], "Stage 2 output disk");
    if (value.outputDisk.path !== pathsValue.outputDisk || value.outputDisk.bytes !== STAGE2_OUTPUT_DISK_BYTES ||
        value.outputDisk.format !== "raw-fat" || value.outputDisk.volumeLabel !== "MYSPEEDOUT")
        throw new TypeError("Stage 2 output disk differs");
    exactString(value.outputDisk.sha256, SHA256_PATTERN, "Stage 2 empty output hash");
    keys(value.systemDisk, ["bytes", "format", "path", "sha256", "virtualBytes"], "Stage 2 system disk");
    if (value.systemDisk.path !== pathsValue.systemDisk || value.systemDisk.format !== "qcow2" ||
        value.systemDisk.virtualBytes !== STAGE2_SYSTEM_DISK_BYTES)
        throw new TypeError("Stage 2 system disk differs");
    decimal(value.systemDisk.bytes, "Stage 2 system disk bytes", {positive: true});
    exactString(value.systemDisk.sha256, SHA256_PATTERN, "Stage 2 system disk hash");
    keys(value.ovmfVars, ["path", "sha256"], "Stage 2 OVMF variables");
    if (value.ovmfVars.path !== pathsValue.ovmfVars || value.ovmfVars.sha256 !== toolchain.ovmfVarsTemplate.sha256)
        throw new TypeError("Stage 2 OVMF variables differ");
    return structuredClone(value);
}

function validateStage2Observation(value, context) {
    keys(value, ["argv", "classification", "cleanupProven", "context", "cpuCalibrationAccepted", "guest", "installWim",
        "installWimRemoval", "iso", "media", "packageClosure", "privilegeMode", "probeArtifact", "probes",
        "qemuProcess", "qualifying", "releaseGateCleared", "schemaVersion", "selectedImage", "stage", "status",
        "toolchain"], "Stage 2 observation");
    if (value.schemaVersion !== SCHEMA_VERSION || value.status !== "observed" || value.stage !== "complete" ||
        value.classification !== "github-hosted-windows-cpu-floor-stage2-nonqualifying" || value.qualifying !== false ||
        value.releaseGateCleared !== false || value.cpuCalibrationAccepted !== true || value.cleanupProven !== true ||
        !same(value.context, context) || !new Set(["ordinary-kvm", "reviewed-sudo-kvm"]).has(value.privilegeMode))
        throw new TypeError("Stage 2 observation is not accepted");
    keys(value.qemuProcess, ["cleanupProven", "exitCode", "launcherExecutablePath", "processGroupId", "qemuPid",
        "qemuPidAbsentAfter", "qemuStartTicks", "signal", "terminationReason", "timedOut", "treeGone"],
    "Stage 2 process");
    if (value.qemuProcess.cleanupProven !== true || value.qemuProcess.treeGone !== true ||
        value.qemuProcess.qemuPidAbsentAfter !== true || value.qemuProcess.exitCode !== 0 ||
        value.qemuProcess.signal !== null || value.qemuProcess.timedOut !== false ||
        value.qemuProcess.terminationReason !== null) throw new TypeError("Stage 2 cleanup is not proven");
    keys(value.guest, ["cpu", "instructions", "network", "output", "schemaVersion", "status"], "Stage 2 guest");
    if (value.guest.schemaVersion !== SCHEMA_VERSION || value.guest.status !== "observed")
        throw new TypeError("Stage 2 guest header is invalid");
    keys(value.guest.cpu, ["avx", "avx2", "osxsave", "popcnt", "sse42", "xcr0"], "Stage 2 CPU projection");
    if (value.guest.cpu.sse42 !== true || value.guest.cpu.popcnt !== true || value.guest.cpu.avx !== false ||
        value.guest.cpu.avx2 !== false || value.guest.cpu.osxsave !== false || value.guest.cpu.xcr0 !== null)
        throw new TypeError("Stage 2 CPU floor is invalid");
    keys(value.guest.instructions, ["avx", "avx2", "popcnt", "sse42"], "Stage 2 instruction projection");
    if (!same(value.guest.instructions, {sse42: "completed", popcnt: "completed", avx: "illegal-instruction",
        avx2: "illegal-instruction"})) throw new TypeError("Stage 2 instruction floor is invalid");
    validateZeroNetwork(value.guest.network, "Stage 2 guest network");
    const pathsValue = stage2Paths(context);
    const packageClosure = validatePackageClosure(value.packageClosure);
    const packageClosureSha256 = crypto.createHash("sha256").update(JSON.stringify(packageClosure)).digest("hex");
    const toolchain = validateToolchain(value.toolchain, context);
    if (toolchain.packageClosureSha256 !== packageClosureSha256)
        throw new TypeError("Stage 2 package closure binding differs");
    const probeArtifact = validateStage2ProbeArtifact(value.probeArtifact);
    const probes = validateStage2Probes(value.probes, probeArtifact, pathsValue);
    const expectedArgv = buildStage2QemuArguments({paths: pathsValue, toolchain});
    if (!same(value.argv, expectedArgv)) throw new TypeError("Stage 2 QEMU vector differs");
    validateProcess(value.qemuProcess, toolchain);
    const stage2Output = validateIdentity(value.guest.output, "Stage 2 guest output");
    if (stage2Output.path !== pathsValue.outputDisk ||
        stage2Output.bytes !== OUTPUT_DISK_BYTES) throw new TypeError("Stage 2 guest output binding is invalid");
    const iso = validateIso(value.iso);
    keys(value.installWim, ["bytes", "path", "sha256", "sourceIsoSha256"], "Stage 2 install WIM");
    if (value.installWim.path !== pathsValue.installWim || value.installWim.sourceIsoSha256 !== iso.sha256 ||
        decimal(value.installWim.bytes, "Stage 2 install WIM bytes", {positive: true}) >
        decimal(STAGE2_PROVENANCE.windowsIso.bytes, "Stage 2 ISO bound", {positive: true}))
        throw new TypeError("Stage 2 install WIM differs");
    exactString(value.installWim.sha256, SHA256_PATTERN, "Stage 2 install WIM hash");
    keys(value.installWimRemoval, ["path", "removed", "sha256"], "Stage 2 install WIM removal");
    if (value.installWimRemoval.path !== value.installWim.path || value.installWimRemoval.sha256 !==
        value.installWim.sha256 || value.installWimRemoval.removed !== true)
        throw new TypeError("Stage 2 install WIM removal differs");
    const media = validateStage2Media(value.media, pathsValue, toolchain);
    keys(value.selectedImage, ["architecture", "editionId", "index", "installationType", "name", "totalBytes"],
        "Stage 2 selected image");
    if (value.selectedImage.architecture !== "x64" || value.selectedImage.editionId !== "ServerStandardEval" ||
        value.selectedImage.installationType !== "Server" ||
        value.selectedImage.name !== "Windows Server 2025 SERVERSTANDARD" ||
        !Number.isInteger(value.selectedImage.index) || value.selectedImage.index < 1)
        throw new TypeError("Stage 2 selected image is invalid");
    return {...structuredClone(value), packageClosure, probeArtifact, probes, media, toolchain, iso};
}

function validateStage2GuestEvidence(value, expectedIdentity, context, projectedGuest) {
    keys(value, ["bytesBase64", "identity"], "Stage 2 raw guest evidence");
    const id = validateIdentity(value.identity, "Stage 2 raw guest identity");
    if (!same(id, expectedIdentity)) throw new TypeError("Stage 2 raw guest identity differs");
    const decoded = decodeEvidence(value.bytesBase64, id.sha256, "Stage 2 raw guest evidence");
    if (String(decoded.bytes.length) !== id.bytes) throw new TypeError("Stage 2 raw guest size differs");
    const replayed = parseStage2GuestOutput(decoded.bytes, context.nonce);
    const normalized = {...replayed, cpu: {sse42: replayed.cpu.sse42, popcnt: replayed.cpu.popcnt,
        avx: replayed.cpu.avx, avx2: replayed.cpu.avx2, osxsave: replayed.cpu.osxsave, xcr0: null}};
    if (!same(normalized.cpu, projectedGuest.cpu) || !same(normalized.instructions, projectedGuest.instructions) ||
        !same(normalized.network, projectedGuest.network))
        throw new TypeError("Stage 2 raw guest projection differs");
    return {identity: id, bytesBase64: value.bytesBase64};
}

function validateCandidate(value, context) {
    keys(value, ["archive", "artifactId", "artifactName", "file", "manifest", "qualificationSummary",
        "releaseAssetDigest", "releaseAssetId", "runAttempt", "runId", "sourceSha", "tagName"],
    "baseline candidate");
    if (value.artifactName !== BASELINE_ARTIFACT || value.sourceSha === context.sourceSha)
        throw new TypeError("baseline candidate provenance differs");
    exactString(value.sourceSha, /^[a-f0-9]{40}$/u, "baseline candidate source SHA");
    exactString(value.tagName, /^v[0-9]+\.[0-9]+\.[0-9]+$/u, "baseline candidate tag name");
    exactString(value.artifactId, /^[1-9][0-9]{0,19}$/u, "baseline artifact ID");
    exactString(value.releaseAssetId, /^[1-9][0-9]{0,19}$/u, "baseline release asset ID");
    exactString(value.releaseAssetDigest, /^sha256:[a-f0-9]{64}$/u, "baseline release asset digest");
    for (const name of ["runId", "runAttempt"])
        exactString(value[name], /^[1-9][0-9]{0,19}$/u, `baseline candidate ${name}`);
    keys(value.archive, ["bytes", "sha256"], "baseline archive");
    decimal(value.archive.bytes, "baseline archive bytes", {positive: true});
    exactString(value.archive.sha256, SHA256_PATTERN, "baseline archive hash");
    for (const [record, expectedName, label] of [[value.file, STAGED_CANDIDATE, "baseline file"],
        [value.qualificationSummary, SUMMARY_NAME, "baseline summary"], [value.manifest, MANIFEST_NAME,
            "baseline manifest"]]) {
        keys(record, ["bytes", "name", "sha256"], label);
        if (record.name !== expectedName) throw new TypeError(`${label} name differs`);
        decimal(record.bytes, `${label} bytes`, {positive: true});
        exactString(record.sha256, SHA256_PATTERN, `${label} hash`);
    }
    return structuredClone(value);
}

function validateRequest(value) {
    keys(value, ["authorization", "candidate", "context", "paths", "profile", "schemaVersion", "stage2"],
        "Stage 3 request");
    if (value.schemaVersion !== SCHEMA_VERSION || value.profile !== PROFILE) throw new TypeError("Stage 3 profile is invalid");
    const context = validateHostedContext(value.context);
    keys(value.authorization, ["candidate", "confirmation", "qemu", "scope"], "Stage 3 authorization");
    if (value.authorization.candidate !== true || value.authorization.qemu !== true ||
        value.authorization.confirmation !== CONFIRMATION || value.authorization.scope !== AUTHORIZATION_SCOPE)
        throw new TypeError("Stage 3 authorization is invalid");
    keys(value.stage2, ["guestResult", "result"], "Stage 2 binding");
    const stage2Result = validateIdentity(value.stage2.result, "Stage 2 result");
    const stage2GuestResult = validateIdentity(value.stage2.guestResult, "Stage 2 raw guest result");
    const transportRoot = `/home/runner/work/_temp/myspeed-stage2-transport-${context.nonce}`;
    if (stage2Result.path !== `${transportRoot}/stage2-result.json` ||
        stage2GuestResult.path !== `${transportRoot}/guest-result.json`)
        throw new TypeError("Stage 2 retained evidence paths differ");
    const paths = validatePaths(value.paths, context);
    return {context, paths, candidate: validateCandidate(value.candidate, context), stage2Result, stage2GuestResult,
        request: structuredClone(value)};
}

function drive(id, file, {readOnly = false, format = "raw"} = {}) {
    return `if=none,id=${id},format=${format}${readOnly ? ",readonly=on" : ""},file=${file}`;
}

export function buildBaselineQemuArguments({paths: value, toolchain, windowsIso}) {
    const iso = validateIdentity(windowsIso, "Stage 3 Windows ISO");
    const qemu = ["-nodefaults", "-no-user-config", "-display", "none", "-monitor", "none", "-accel", "kvm",
        "-machine", MACHINE_MODEL, "-cpu", CPU_VECTOR, "-smp", GUEST_SMP, "-m", GUEST_MEMORY, "-nic", "none",
        "-drive", `if=pflash,format=raw,readonly=on,file=${toolchain.ovmfCode.path}`,
        "-drive", `if=pflash,format=raw,file=${value.ovmfVars}`, "-device", "ich9-ahci,id=sata",
        "-drive", drive("osdisk", value.systemDisk, {format: "qcow2"}), "-device", "ide-hd,drive=osdisk,bus=sata.1",
        "-drive", drive("install", iso.path, {readOnly: true}), "-device", "ide-cd,drive=install,bus=sata.2",
        "-drive", drive("seed", value.seedIso, {readOnly: true}), "-device", "ide-cd,drive=seed,bus=sata.3",
        "-drive", drive("output", value.outputDisk), "-device", "ide-hd,drive=output,bus=sata.4",
        "-chardev", `file,id=serial0,path=${value.serialLog}`, "-device", "isa-serial,chardev=serial0",
        "-pidfile", value.qemuPid, "-boot", "once=d,order=c,strict=on"];
    const forbidden = /(?:^|[,=])(?:user|tap|socket|vsock)(?:[,=]|$)|(?:fat:|nbd:|ssh:|https?:)|virtio-9p/iu;
    if (qemu.some(item => forbidden.test(item))) throw new TypeError("Stage 3 QEMU vector contains a forbidden backend");
    return Object.freeze(qemu);
}

function validateAcquiredCandidate(value, candidate, root) {
    keys(value, ["candidate", "stagedFile", "stagedManifest", "stagedSummary"], "acquired candidate");
    if (!same(value.candidate, candidate)) throw new TypeError("acquired candidate provenance differs");
    const records = [[value.stagedFile, candidate.file, "candidate/MySpeed.exe"],
        [value.stagedSummary, candidate.qualificationSummary, `candidate/${SUMMARY_NAME}`],
        [value.stagedManifest, candidate.manifest, `candidate/${MANIFEST_NAME}`]];
    for (const [actual, expected, relative] of records) {
        keys(actual, ["bytes", "name", "path", "sha256"], "staged candidate file");
        if (actual.path !== `${root}/${relative}` || actual.name !== expected.name || actual.bytes !== expected.bytes ||
            actual.sha256 !== expected.sha256) throw new TypeError("staged candidate identity differs");
    }
    return structuredClone(value);
}

function validatePreparedMedia(value, pathsValue) {
    keys(value, ["outputDisk", "ovmfVars", "seedIso", "systemDisk"], "Stage 3 media");
    const expected = [[value.seedIso, pathsValue.seedIso], [value.outputDisk, pathsValue.outputDisk],
        [value.ovmfVars, pathsValue.ovmfVars]];
    for (const [record, expectedPath] of expected) {
        validateIdentity(record, "Stage 3 media file");
        if (record.path !== expectedPath) throw new TypeError("Stage 3 media path differs");
    }
    keys(value.systemDisk, ["bytes", "path", "sha256", "virtualBytes"], "Stage 3 system disk");
    if (value.systemDisk.path !== pathsValue.systemDisk || value.systemDisk.virtualBytes !== SYSTEM_DISK_VIRTUAL_BYTES)
        throw new TypeError("Stage 3 system disk differs");
    decimal(value.systemDisk.bytes, "Stage 3 system disk bytes", {positive: true});
    exactString(value.systemDisk.sha256, SHA256_PATTERN, "Stage 3 system disk hash");
    if (value.outputDisk.bytes !== OUTPUT_DISK_BYTES) throw new TypeError("Stage 3 output disk size differs");
    return structuredClone(value);
}

function validateProcess(value, toolchain) {
    keys(value, ["cleanupProven", "exitCode", "launcherExecutablePath", "processGroupId", "qemuPid",
        "qemuPidAbsentAfter", "qemuStartTicks", "signal", "terminationReason", "timedOut", "treeGone"],
    "Stage 3 QEMU process");
    if (value.exitCode !== 0 || value.signal !== null || value.timedOut !== false || value.cleanupProven !== true ||
        value.treeGone !== true || value.qemuPidAbsentAfter !== true || value.launcherExecutablePath !==
        toolchain.runtime.loader.path || value.terminationReason !== null || !Number.isInteger(value.qemuPid) ||
        value.qemuPid < 1 || value.qemuPid > 0x7fff_ffff || !Number.isInteger(value.processGroupId) ||
        value.processGroupId < 1 || value.processGroupId > 0x7fff_ffff ||
        !/^[1-9][0-9]{0,23}$/u.test(value.qemuStartTicks)) throw new TypeError("Stage 3 QEMU cleanup is not proven");
    return structuredClone(value);
}

function validateZeroNetwork(value, name) {
    keys(value, ["enabledNonLoopbackInterfaces", "hardwareNics", "nonLoopbackRoutes"], name);
    if (value.hardwareNics !== 0 || value.enabledNonLoopbackInterfaces !== 0 || value.nonLoopbackRoutes !== 0)
        throw new TypeError(`${name} is invalid`);
}

function boundedSummaryString(value, name) {
    if (typeof value !== "string" || value.length < 1 || value.length > 256 || /[\x00-\x1f\x7f]/u.test(value))
        throw new TypeError(`${name} is invalid`);
    return value;
}

function validateFullSummary(value, requestValue) {
    keys(value, ["architecture", "artifactSha256", "command", "databaseChecks", "exit", "mode", "networkIsolation",
        "openGraphChecks", "platform", "processes", "shutdownProofs", "sourceSha", "status"], "full verifier summary");
    if (value.status !== "passed" || value.exit !== 0 || value.mode !== "full" || value.sourceSha !==
        requestValue.candidate.sourceSha || value.artifactSha256 !== requestValue.candidate.file.sha256 ||
        value.platform !== "win32" || value.architecture !== "x64" || !Array.isArray(value.command) ||
        value.command.length !== 1 || path.win32.basename(value.command[0]) !== STAGED_CANDIDATE)
        throw new TypeError("full verifier summary is invalid");
    if (!Array.isArray(value.processes) || value.processes.length !== EXPECTED_PROCESS_SCENARIOS.length)
        throw new TypeError("full verifier process receipts are incomplete");
    value.processes.forEach((record, index) => {
        keys(record, ["pid", "scenario"], "full verifier process receipt");
        if (record.scenario !== EXPECTED_PROCESS_SCENARIOS[index] || !Number.isInteger(record.pid) ||
            record.pid < 1 || record.pid > 0xffff_ffff)
            throw new TypeError("full verifier process receipt is invalid");
    });
    if (!Array.isArray(value.databaseChecks) || value.databaseChecks.length !== EXPECTED_DATABASE_SCENARIOS.length)
        throw new TypeError("full verifier database receipts are incomplete");
    let expectedPopulated = null;
    value.databaseChecks.forEach((record, index) => {
        if (index === EXPECTED_DATABASE_SCENARIOS.length - 1) {
            keys(record, ["configTable", "integrity", "scenario"], "full verifier reset database receipt");
            if (record.scenario !== EXPECTED_DATABASE_SCENARIOS[index] || record.integrity !== "ok" ||
                record.configTable !== false) throw new TypeError("full verifier reset database receipt is invalid");
            return;
        }
        keys(record, ["passwordValueSha256", "ping", "resultId", "scenario"],
            "full verifier populated database receipt");
        if (record.scenario !== EXPECTED_DATABASE_SCENARIOS[index])
            throw new TypeError("full verifier database scenario is invalid");
        const observed = {ping: boundedSummaryString(record.ping, "full verifier database ping"),
            resultId: boundedSummaryString(record.resultId, "full verifier database result ID"),
            passwordValueSha256: exactString(record.passwordValueSha256, SHA256_PATTERN,
                "full verifier database password fingerprint")};
        if (expectedPopulated === null) expectedPopulated = observed;
        else if (!same(observed, expectedPopulated))
            throw new TypeError("full verifier populated database receipts differ");
    });
    if (!Array.isArray(value.openGraphChecks) || value.openGraphChecks.length !== EXPECTED_OPEN_GRAPH_SCENARIOS.length)
        throw new TypeError("full verifier OpenGraph receipts are incomplete");
    value.openGraphChecks.forEach((record, index) => {
        keys(record, ["elapsedMs", "scenario"], "full verifier OpenGraph receipt");
        if (record.scenario !== EXPECTED_OPEN_GRAPH_SCENARIOS[index] || !Number.isInteger(record.elapsedMs) ||
            record.elapsedMs < 0 || record.elapsedMs > OPEN_GRAPH_QUALIFICATION_TIMEOUT_MS)
            throw new TypeError("full verifier OpenGraph receipt is invalid");
    });
    keys(value.networkIsolation, ["enabledNonLoopbackInterfaces", "hardwareNics", "kind", "nonLoopbackRoutes"],
        "full verifier network isolation");
    validateZeroNetwork({hardwareNics: value.networkIsolation.hardwareNics,
        enabledNonLoopbackInterfaces: value.networkIsolation.enabledNonLoopbackInterfaces,
        nonLoopbackRoutes: value.networkIsolation.nonLoopbackRoutes}, "full verifier network isolation");
    if (value.networkIsolation.kind !== "qemu-nic-none-windows-guest")
        throw new TypeError("full verifier network isolation kind is invalid");
    if (!Array.isArray(value.shutdownProofs) || value.shutdownProofs.length !== EXPECTED_PROCESS_SCENARIOS.length)
        throw new TypeError("full verifier shutdown proof set is invalid");
    for (const [index, proof] of value.shutdownProofs.entries()) {
        keys(proof, ["candidateExitCode", "candidateExited", "controllerLifecyclePassed", "forced", "handlesClosed",
            "jobActiveProcesses", "scenario"], "full verifier shutdown proof");
        const expectedExit = proof.scenario === "fresh-no-config-reset" ? RESET_NOTHING_TO_DO_EXIT : SUCCESS_EXIT;
        if (proof.scenario !== EXPECTED_PROCESS_SCENARIOS[index] || proof.controllerLifecyclePassed !== true ||
            proof.candidateExited !== true || proof.candidateExitCode !== expectedExit || proof.forced !== false ||
            proof.jobActiveProcesses !== 0 || proof.handlesClosed !== true)
            throw new TypeError("full verifier shutdown proof is invalid");
    }
}

export function validateBaselineGuestResult(value, requestValue) {
    const checked = validateRequest(requestValue);
    keys(value, ["candidate", "context", "cpu", "network", "profile", "releaseGatesCleared", "schemaVersion", "status",
        "verifier"], "baseline guest result");
    if (value.schemaVersion !== SCHEMA_VERSION || value.status !== "observed" || value.profile !== PROFILE ||
        !same(value.context, checked.context) || !Array.isArray(value.releaseGatesCleared) ||
        value.releaseGatesCleared.length !== 0) throw new TypeError("baseline guest header is invalid");
    keys(value.candidate, ["artifactName", "sha256", "sourceSha"], "baseline guest candidate");
    if (value.candidate.artifactName !== BASELINE_ARTIFACT || value.candidate.sourceSha !== checked.candidate.sourceSha ||
        value.candidate.sha256 !== checked.candidate.file.sha256) throw new TypeError("baseline guest candidate differs");
    keys(value.cpu, ["avx", "avx2", "cpuidBytesBase64", "cpuidSha256", "model", "osxsave", "popcnt", "sse42",
        "xcr0"],
    "baseline guest CPU");
    const cpuid = decodeEvidence(value.cpu.cpuidBytesBase64, value.cpu.cpuidSha256, "baseline guest CPUID");
    const projection = validateCpuidBytes(cpuid.parsed);
    if (value.cpu.model !== CPU_MODEL || value.cpu.sse42 !== true || value.cpu.popcnt !== true ||
        value.cpu.avx !== false || value.cpu.avx2 !== false || value.cpu.osxsave !== false || value.cpu.xcr0 !== null ||
        !same(projection, {sse42: value.cpu.sse42, popcnt: value.cpu.popcnt, osxsave: value.cpu.osxsave,
            avx: value.cpu.avx, avx2: value.cpu.avx2, xcr0: value.cpu.xcr0}))
        throw new TypeError("baseline guest CPU does not prove the target floor");
    validateZeroNetwork(value.network, "baseline guest network");
    keys(value.verifier, ["summary", "summaryBytesBase64", "summarySha256"], "baseline verifier evidence");
    const summary = decodeEvidence(value.verifier.summaryBytesBase64, value.verifier.summarySha256,
        "baseline verifier summary");
    if (!same(summary.parsed, value.verifier.summary)) throw new TypeError("baseline verifier summary bytes differ");
    validateFullSummary(value.verifier.summary, checked.request);
    return structuredClone(value);
}

function validateCollectedGuest(value, requestValue, pathsValue, expectedOutputDisk) {
    keys(value, ["bytesBase64", "identity", "result", "sourceOutputDisk"], "baseline collected guest result");
    const sourceOutputDisk = validateIdentity(value.sourceOutputDisk, "baseline guest source output disk");
    if (sourceOutputDisk.path !== pathsValue.outputDisk || !same(sourceOutputDisk, expectedOutputDisk))
        throw new TypeError("baseline guest source output disk differs");
    const id = validateIdentity(value.identity, "baseline collected guest result identity");
    directChild(pathsValue.root, id.path, "baseline-result.json");
    const decoded = decodeEvidence(value.bytesBase64, id.sha256, "baseline collected guest result");
    if (String(decoded.bytes.length) !== id.bytes || !same(decoded.parsed, value.result))
        throw new TypeError("baseline collected guest result bytes differ");
    return validateBaselineGuestResult(value.result, requestValue);
}

export function validateCompletedStage3Result(value, requestValue, retainedStage2Bytes) {
    const checked = validateRequest(requestValue);
    if (!Buffer.isBuffer(retainedStage2Bytes) || retainedStage2Bytes.length < 2 ||
        retainedStage2Bytes.length > MAX_EMBEDDED_EVIDENCE_BYTES ||
        String(retainedStage2Bytes.length) !== checked.stage2Result.bytes ||
        crypto.createHash("sha256").update(retainedStage2Bytes).digest("hex") !== checked.stage2Result.sha256)
        throw new TypeError("retained Stage 2 result bytes differ");
    let stage2Value;
    try { stage2Value = JSON.parse(new TextDecoder("utf-8", {fatal: true}).decode(retainedStage2Bytes)); }
    catch { throw new TypeError("retained Stage 2 result JSON is invalid"); }
    const stage2 = validateStage2Observation(stage2Value, checked.context);
    keys(value, ["argv", "baselineFullRuntimeAccepted", "candidate", "classification", "cleanupProven", "context",
        "cpuFloorAccepted", "guest", "guestEvidence", "media", "outputDisk", "qemuProcess", "qualifying",
        "releaseGateCleared", "schemaVersion", "stage", "stage2GuestEvidence", "stage2Result", "status"],
    "completed Stage 3 result");
    if (value.schemaVersion !== SCHEMA_VERSION || value.status !== "observed" || value.stage !== "complete" ||
        value.classification !== CLASSIFICATION || value.qualifying !== false || value.releaseGateCleared !== false ||
        value.baselineFullRuntimeAccepted !== true || value.cpuFloorAccepted !== true || value.cleanupProven !== true ||
        !same(value.context, checked.context) || !same(value.stage2Result, checked.stage2Result))
        throw new TypeError("completed Stage 3 result is not accepted");
    const candidate = validateAcquiredCandidate(value.candidate, checked.candidate, checked.paths.root);
    validateStage2GuestEvidence(value.stage2GuestEvidence, checked.stage2GuestResult, checked.context, stage2.guest);
    const media = validatePreparedMedia(value.media, checked.paths);
    const windowsIso = {path: `/home/runner/work/_temp/myspeed-windows-cpu-floor-${checked.context.nonce}/windows.iso`,
        bytes: stage2.iso.bytes, sha256: stage2.iso.sha256};
    const argv = buildBaselineQemuArguments({paths: checked.paths, toolchain: stage2.toolchain, windowsIso});
    if (!same(value.argv, argv)) throw new TypeError("completed Stage 3 QEMU vector differs");
    validateProcess(value.qemuProcess, stage2.toolchain);
    const outputDisk = validateIdentity(value.outputDisk, "completed Stage 3 output disk");
    if (outputDisk.path !== checked.paths.outputDisk || outputDisk.bytes !== OUTPUT_DISK_BYTES)
        throw new TypeError("completed Stage 3 output disk differs");
    const guest = validateCollectedGuest(value.guestEvidence, checked.request, checked.paths, outputDisk);
    if (!same(guest, value.guest)) throw new TypeError("completed Stage 3 guest evidence differs");
    return Object.freeze({accepted: true, stage2, candidate, media});
}

function failure(context, stage, error, cleanupProven) {
    const message = (error instanceof Error ? error.message : String(error)).replace(/[\x00-\x1f\x7f]+/gu, " ")
        .slice(0, MAX_FAILURE_MESSAGE_CHARACTERS);
    return Object.freeze({schemaVersion: SCHEMA_VERSION, status: "failed", stage, classification: CLASSIFICATION,
        qualifying: false, releaseGateCleared: false, baselineFullRuntimeAccepted: false, cpuFloorAccepted: false,
        cleanupProven, context: context ? structuredClone(context) : null, failure: message || "unspecified failure"});
}

export async function runWindowsCpuFloorStage3(input, operations) {
    let context = null;
    let stage = "request";
    let cleanupProven = true;
    try {
        const checked = validateRequest(input);
        context = checked.context;
        const required = ["acquireCandidate", "collectBaselineGuestResult", "launchBaselineGuest",
            "prepareBaselineMedia", "replayStage2"];
        if (!operations || typeof operations !== "object" || required.some(name => typeof operations[name] !== "function"))
            throw new TypeError("Stage 3 operations are incomplete");
        stage = "stage2-replay";
        const replay = await operations.replayStage2({context, identity: checked.stage2Result,
            guestIdentity: checked.stage2GuestResult});
        keys(replay, ["guestEvidence", "identity", "result"], "Stage 2 replay");
        if (!same(replay.identity, checked.stage2Result)) throw new TypeError("Stage 2 result identity differs");
        const stage2 = validateStage2Observation(replay.result, context);
        const stage2GuestEvidence = validateStage2GuestEvidence(replay.guestEvidence, checked.stage2GuestResult,
            context, stage2.guest);
        const windowsIso = {path: `/home/runner/work/_temp/myspeed-windows-cpu-floor-${context.nonce}/windows.iso`,
            bytes: stage2.iso.bytes, sha256: stage2.iso.sha256};
        stage = "candidate";
        const candidate = validateAcquiredCandidate(await operations.acquireCandidate({context,
            candidate: checked.candidate, root: checked.paths.root}), checked.candidate, checked.paths.root);
        stage = "media";
        const media = validatePreparedMedia(await operations.prepareBaselineMedia({context, candidate,
            paths: checked.paths, stage2, toolchain: stage2.toolchain, windowsIso}), checked.paths);
        const argv = buildBaselineQemuArguments({paths: checked.paths, toolchain: stage2.toolchain, windowsIso});
        stage = "qemu-launch";
        cleanupProven = false;
        const launch = await operations.launchBaselineGuest({context, argv, candidate, media, paths: checked.paths,
            profile: PROFILE, stage2, toolchain: stage2.toolchain, windowsIso});
        keys(launch, ["argv", "outputDisk", "process"], "Stage 3 launch observation");
        if (!same(launch.argv, argv)) throw new TypeError("Stage 3 observed QEMU vector differs");
        try { validateProcess(launch.process, stage2.toolchain); }
        catch (error) { cleanupProven = false; throw error; }
        cleanupProven = true;
        const outputDisk = validateIdentity(launch.outputDisk, "Stage 3 completed output disk");
        if (outputDisk.path !== checked.paths.outputDisk || outputDisk.bytes !== OUTPUT_DISK_BYTES)
            throw new TypeError("Stage 3 output disk differs");
        stage = "guest-output";
        const guestEvidence = await operations.collectBaselineGuestResult({context, candidate,
            outputDisk, paths: checked.paths});
        const guest = validateCollectedGuest(guestEvidence, checked.request, checked.paths, outputDisk);
        return Object.freeze({schemaVersion: SCHEMA_VERSION, status: "observed", stage: "complete",
            classification: CLASSIFICATION, qualifying: false, releaseGateCleared: false,
            baselineFullRuntimeAccepted: true, cpuFloorAccepted: true, cleanupProven: true, context,
            stage2Result: checked.stage2Result, stage2GuestEvidence, candidate, media, argv,
            qemuProcess: launch.process, outputDisk,
            guestEvidence: structuredClone(guestEvidence), guest});
    } catch (error) { return failure(context, stage, error, cleanupProven); }
}

export const STAGE3_CONSTANTS = Object.freeze({AUTHORIZATION_SCOPE, BASELINE_ARTIFACT, CLASSIFICATION, CONFIRMATION,
    CPU_MODEL, OUTPUT_DISK_BYTES, PROFILE, SYSTEM_DISK_VIRTUAL_BYTES});
