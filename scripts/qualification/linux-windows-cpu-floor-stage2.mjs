import crypto from "node:crypto";
import path from "node:path";

import {validateHostedContext} from "./linux-kvm-capability.mjs";
import {STAGE2_LIMITS} from "./linux-windows-cpu-floor-admission.mjs";
import {validateInstallerBootConfirmation, validateInstallerBootInput,
    validateWinpeDiagnosticAuthorization, validateWinpeDiagnosticInput, winpeDiagnosticScriptName,
    MID_WINDOW_SAMPLE_OFFSETS_MILLISECONDS, MID_WINDOW_FRAME_FILENAMES, QMP_SHUTDOWN_CAUSES} from
    "./linux-windows-cpu-floor-stage2-qmp.mjs";
import {buildWindowsMsiSetupCompleteActivation, createWindowsBaseCalibrationHandoff,
    getCompletedWindowsMsiActivationEvidence} from "./windows-msi-post-setup-activation.mjs";

const SCHEMA_VERSION = 1;
export const MAX_STAGE2_RESULT_BYTES = 4_194_304;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const MAX_SYSTEM_TOOL_BYTES = 268_435_456n;
export const WINDOWS_SYSTEM_TOOL_PATHS = deepFreeze([
    {role: "msiexec", path: "C:\\Windows\\System32\\msiexec.exe"},
    {role: "sc", path: "C:\\Windows\\System32\\sc.exe"},
    {role: "powershell", path: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"}
]);
const DECIMAL_PATTERN = /^(?:0|[1-9][0-9]*)$/u;
const PACKAGE_NAME_PATTERN = /^[a-z0-9][a-z0-9+.-]{0,127}$/u;
const VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9.+:~_-]{0,127}$/u;
const PACKAGE_PATH_PATTERN = /^pool\/[A-Za-z0-9+._~\/-]{1,240}\.deb$/u;
const SNAPSHOT_PATH_PATTERN = /^dists\/[a-z0-9-]+\/[A-Za-z0-9+._\/-]{1,240}$/u;
const MAX_PACKAGE_COUNT = 512;
const MAX_INDEX_COUNT = 16;
const MAX_DEPENDENCIES = 128;
const MAX_TOOL_BYTES = 2_147_483_648n;
const MAX_WIM_BYTES = 8_152_356_864n;
const GUEST_OUTPUT_BYTES = "67108864";
const GUEST_DISK_BYTES = "51539607552";
const GUEST_PROBE_TIMEOUT_MILLISECONDS = 10_000;
const GUEST_PROBE_CLEANUP_TIMEOUT_MILLISECONDS = 5_000;
const MAX_GUEST_FAILURE_MESSAGE_CHARACTERS = 512;
const MAX_WIM_SELECTION_DIAGNOSTIC_BYTES = 131_072;
const MAX_QEMU_DIAGNOSTIC_STREAM_BYTES = 65_536;
const MAX_QEMU_DIAGNOSTIC_BASE64_CHARACTERS = Math.ceil(MAX_QEMU_DIAGNOSTIC_STREAM_BYTES / 3) * 4;
const MAX_EARLY_BOOT_SCREENSHOT_BYTES = 1_048_576;
const MAX_EARLY_BOOT_SCREENSHOT_BASE64_CHARACTERS = Math.ceil(MAX_EARLY_BOOT_SCREENSHOT_BYTES / 3) * 4;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const CPU_MODEL = "Westmere-v2";
const MACHINE_MODEL = "q35";
/*
 * Boot selection has two mechanisms on x86 and only one of them reaches this machine's firmware.
 * "-boot order=/once=" travels through the RTC CMOS boot byte that SeaBIOS reads; OVMF never looks
 * at it, so the order this harness used to declare was invisible to the firmware that actually runs
 * and the guest booted whatever EDK II enumerated first. bootindex travels through the fw_cfg
 * "bootorder" file, which OVMF's QemuBootOrderLib does read - and which stayed empty while no device
 * carried one. QEMU documents that mixing the two is undefined, so only bootindex is used now.
 *
 * The system disk is first and the installer second, which covers both boots in one static order:
 * on the install boot the disk is a blank image with no EFI system partition, so no boot option
 * exists for it and the installer is the first option that does; after setup reboots, the disk
 * carries a boot manager and wins, so setup cannot loop. The system disk needs its own index for
 * that second boot - QemuBootOrderLib drops PciRoot()-rooted options that match no bootorder entry,
 * so an unindexed disk would lose the boot manager setup had just written.
 */
const SYSTEM_DISK_BOOT_INDEX = 0;
const INSTALL_MEDIA_BOOT_INDEX = 1;
const SEVEN_ZIP_LIBRARY_RELATIVE_PATH = "usr/lib/7zip";
const SEVEN_ZIP_RELATIVE_PATH = `${SEVEN_ZIP_LIBRARY_RELATIVE_PATH}/7z`;
const CLASSIFICATION = "github-hosted-windows-cpu-floor-stage2-calibration-nonqualifying";
/*
 * A distinct classification, so no consumer can mistake a diagnostic record for a calibration one.
 * It is not a weaker calibration: no CPU floor is observed on this path, no guest receipt exists,
 * and `cpuCalibrationAccepted` is false on every exit it can reach. A capture that completes proves
 * that bounded, authentic evidence was collected from a guest - never that Windows installed.
 */
export const WINPE_DIAGNOSTIC_CLASSIFICATION =
    "github-hosted-windows-cpu-floor-winpe-answer-file-diagnostic-nonqualifying";
const WINPE_DIAGNOSTIC_STAGE = "winpe-answer-file-diagnostic";
const MAX_WINPE_DIAGNOSTIC_MEMBER_BASE64_CHARACTERS = Math.ceil(131_072 / 3) * 4;
const EXPECTED_IMAGE = Object.freeze({name: "Windows Server 2025 SERVERSTANDARD", architecture: "x64",
    editionId: "ServerStandardEval", installationType: "Server"});
const WIM_SELECTION_DIAGNOSTIC_KIND = "windows-server-2025-wim-selection-diagnostic";
export const STAGE2_DIAGNOSTIC_DEADLINES = Object.freeze({executionMinutes: 25, cleanupMinutes: 5});
const MAX_LATE_BOOT_SCREENSHOT_BYTES = 1_048_576;
const MAX_LATE_BOOT_SCREENSHOT_BASE64_CHARACTERS = Math.ceil(MAX_LATE_BOOT_SCREENSHOT_BYTES / 3) * 4;
const MAX_LATE_BOOT_MILESTONES = 2;
const LATE_BOOT_OFFSETS = Object.freeze([120_000, 300_000]);

export const PREDEADLINE_FRAME_STATUSES = Object.freeze(["captured", "skipped", "unavailable", "malformed"]);
export const PREDEADLINE_FRAME_SKIPPED_REASONS = Object.freeze(["insufficient-time", "guest-already-exited", "disabled"]);
/*
 * "reader-unavailable" belongs here too: the stop-optional-continuation policy reports it for
 * predeadline whenever an earlier optional QMP command (a legacy milestone or a mid-window sample)
 * has already made the shared reader unsafe to reuse. Omitting it here silently rewrote a disclosed,
 * meaningful reason down to "command-failed" during collection and replay.
 */
export const PREDEADLINE_FRAME_UNAVAILABLE_REASONS = Object.freeze([
    "command-timeout", "command-failed", "qmp-write-failed", "qmp-stream-ended",
    "qmp-error-response", "qmp-id-mismatch", "file-missing", "cleanup-unproven", "read-error",
    "reader-unavailable"
]);
export const PREDEADLINE_FRAME_MALFORMED_REASONS = Object.freeze(["invalid-png-signature", "read-cap-exceeded", "hash-mismatch", "path-mismatch"]);
export const MAX_PREDEADLINE_FRAME_BYTES = MAX_LATE_BOOT_SCREENSHOT_BYTES;
export const MAX_PREDEADLINE_FRAME_BASE64_CHARACTERS = Math.ceil(MAX_PREDEADLINE_FRAME_BYTES / 3) * 4;

/*
 * Mid-window's own closed vocabulary, kept separate from predeadline's: "insufficient-time" and
 * "session-closed" are admission/cancellation outcomes that never write anything; "reader-unavailable"
 * is the disclosed cost of the conservative stop-optional-continuation policy (a prior optional QMP
 * command failed and the shared reader can no longer be proven safe to reuse); "session-unavailable"
 * is the hosted-layer fallback for a slot whose callback never arrived at all (see
 * collectMidWindowFramesDiagnostic in the hosted module).
 */
export const MID_WINDOW_FRAME_STATUSES = Object.freeze(["captured", "skipped", "unavailable", "malformed"]);
export const MID_WINDOW_FRAME_SKIPPED_REASONS = Object.freeze(["insufficient-time", "session-closed"]);
export const MID_WINDOW_FRAME_UNAVAILABLE_REASONS = Object.freeze([
    "command-timeout", "command-failed", "qmp-write-failed", "qmp-stream-ended",
    "qmp-error-response", "qmp-id-mismatch", "file-missing", "cleanup-unproven", "read-error",
    "reader-unavailable", "session-unavailable"
]);
export const MID_WINDOW_FRAME_MALFORMED_REASONS = Object.freeze(["invalid-png-signature", "read-cap-exceeded", "hash-mismatch", "path-mismatch"]);
export const MAX_MID_WINDOW_FRAME_BYTES = MAX_LATE_BOOT_SCREENSHOT_BYTES;
export const MAX_MID_WINDOW_FRAME_BASE64_CHARACTERS = Math.ceil(MAX_MID_WINDOW_FRAME_BYTES / 3) * 4;

export const TOP_LEVEL_PACKAGE_PINS = deepFreeze([
    {name: "7zip", version: "23.01+dfsg-11", architecture: "amd64",
        filename: "pool/universe/7/7zip/7zip_23.01+dfsg-11_amd64.deb", bytes: "1846156",
        sha256: "0f79450d81e64326a862a8645ae1613890e486115101e51e41ca07d929388d87"},
    {name: "genisoimage", version: "9:1.1.11-3.5", architecture: "amd64",
        filename: "pool/main/c/cdrkit/genisoimage_1.1.11-3.5_amd64.deb", bytes: "377720",
        sha256: "cfa9f63d8208a3e1b2c228357707f607e2b402334262d6f591abc44a429bb217"},
    {name: "mtools", version: "4.0.43-1build1", architecture: "amd64",
        filename: "pool/main/m/mtools/mtools_4.0.43-1build1_amd64.deb", bytes: "196676",
        sha256: "deb50411c17b001c2400dd8a0146f39d12070a2fe5e92d734b1c6d0e73119262"},
    {name: "ovmf", version: "2024.02-2ubuntu0.9", architecture: "all",
        filename: "pool/main/e/edk2/ovmf_2024.02-2ubuntu0.9_all.deb", bytes: "5187470",
        sha256: "a094c13d06f2740691ff57d108dff32aa087179363ddb0de42d463b4f7f9bc13"},
    {name: "qemu-system-x86", version: "1:8.2.2+ds-0ubuntu1.18", architecture: "amd64",
        filename: "pool/main/q/qemu/qemu-system-x86_8.2.2+ds-0ubuntu1.18_amd64.deb", bytes: "11222476",
        sha256: "14602e262627adac030329d2cecfee5f6c0938b34566ff2ea2d4c9a9eb02430d"},
    {name: "qemu-utils", version: "1:8.2.2+ds-0ubuntu1.18", architecture: "amd64",
        filename: "pool/main/q/qemu/qemu-utils_8.2.2+ds-0ubuntu1.18_amd64.deb", bytes: "2220842",
        sha256: "10695e57937d8a1d0ec6d017a6770d02353ec0c9500e4a36928230b2d39026c5"},
    {name: "wimtools", version: "1.14.4-1.1build2", architecture: "amd64",
        filename: "pool/universe/w/wimlib/wimtools_1.14.4-1.1build2_amd64.deb", bytes: "105746",
        sha256: "b86ad991bf2f714adb5494b768308f44e0265502cecbe4743714871dc4544500"}
]);

export const PACKAGE_ROOTS = Object.freeze(TOP_LEVEL_PACKAGE_PINS.map(value => value.name));

export const STAGE2_PROVENANCE = deepFreeze({
    ubuntuSnapshot: {id: "20260913T000000Z",
        baseUrl: "https://snapshot.ubuntu.com/ubuntu/20260913T000000Z/", suites: ["noble", "noble-updates"],
        components: ["main", "universe"], architecture: "amd64", noInstallRecommends: true,
        isolatedEmptyDpkgStatus: true},
    ubuntuArchiveSignerFingerprint: "f6ecb3762474eda9d21b7022871920d1991bc93c",
    windowsIso: {aliasUrl: "https://aka.ms/WinServ2025iso-enus",
        finalUrl: "https://software-static.download.prss.microsoft.com/dbazure/998969d5-f34g-4e03-ac9d-1f9786c66749/26100.32230.260111-0550.lt_release_svc_refresh_SERVER_EVAL_x64FRE_en-us.iso",
        bytes: "8152356864", strongEtag: '"0x60A8C190FBB54AF58E40BA049FF290D098101E0EAD343CE912A1DC685219BE85"',
        strongEtagIsDigest: false, digestProvenance: "windows-official-https-local-digest"},
    qemu: {packageVersion: "1:8.2.2+ds-0ubuntu1.18", cpuModel: CPU_MODEL, machine: MACHINE_MODEL},
    expectedImage: EXPECTED_IMAGE,
    transfer: {seed: "read-only-iso9660", guestOutput: "separate-raw-fat", hostMountAllowed: false,
        qemuVirtualFatAllowed: false}
});

function deepFreeze(value) {
    if (value && typeof value === "object" && !Object.isFrozen(value)) {
        Object.freeze(value);
        for (const child of Object.values(value)) deepFreeze(child);
    }
    return value;
}

function buildPostSetupActivation(context) {
    return buildWindowsMsiSetupCompleteActivation({repository: context.repository, sourceSha: context.sourceSha,
        eventSha: context.eventSha, runId: context.runId, runAttempt: context.runAttempt, nonce: context.nonce});
}

function activationEvidence(activation) {
    return getCompletedWindowsMsiActivationEvidence(activation);
}

class WimSelectionError extends TypeError {
    constructor(diagnostic) {
        super("WIM supported image is not unique");
        this.diagnostic = diagnostic;
    }
}

export class GuestBootstrapError extends Error {
    constructor(guestFailure, earlyBoot = null, lateBoot = null) {
        super(`guest bootstrap failed: ${guestFailure.failure}`);
        this.guestFailure = guestFailure;
        this.earlyBoot = earlyBoot;
        this.lateBoot = lateBoot;
    }
}

export class QemuLaunchError extends Error {
    constructor(diagnostic, earlyBoot = null, guestFailure = null, lateBoot = null) {
        super("QEMU process did not complete cleanly");
        this.diagnostic = diagnostic;
        this.earlyBoot = earlyBoot;
        this.guestFailure = guestFailure;
        this.lateBoot = lateBoot;
    }
}

function assertKeys(value, expected, name) {
    if (value === null || typeof value !== "object" || Array.isArray(value) ||
        JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...expected].sort()))
        throw new TypeError(`${name} keys are invalid`);
}

function exactString(value, pattern, name) {
    if (typeof value !== "string") throw new TypeError(`${name} is invalid`);
    const match = value.match(pattern);
    if (!match || match[0] !== value) throw new TypeError(`${name} is invalid`);
    return value;
}

function decimal(value, name, {positive = false} = {}) {
    exactString(value, DECIMAL_PATTERN, name);
    if (value.length > 24) throw new TypeError(`${name} is invalid`);
    const parsed = BigInt(value);
    if (positive && parsed === 0n) throw new TypeError(`${name} is invalid`);
    return parsed;
}

function sha256(bytes) {
    return crypto.createHash("sha256").update(bytes).digest("hex");
}

function canonicalSha256(value) {
    return sha256(Buffer.from(JSON.stringify(value)));
}

function same(left, right) {
    return JSON.stringify(left) === JSON.stringify(right);
}

function packageReference(value) {
    return `${value.name}:${value.architecture}=${value.version}`;
}

function safeRelative(value, pattern, name) {
    exactString(value, pattern, name);
    if (path.posix.isAbsolute(value) || path.posix.normalize(value) !== value || value.startsWith("../") ||
        value.includes("/../")) throw new TypeError(`${name} is invalid`);
    return value;
}

function validateSnapshot(value) {
    assertKeys(value, ["architecture", "baseUrl", "components", "id", "isolatedEmptyDpkgStatus",
        "noInstallRecommends", "suites"],
        "package snapshot");
    if (!same(value, STAGE2_PROVENANCE.ubuntuSnapshot)) throw new TypeError("package snapshot is not pinned");
}

export function validatePackageClosure(value) {
    assertKeys(value, ["indexes", "packages", "releases", "roots", "schemaVersion", "snapshot"],
        "package closure");
    if (value.schemaVersion !== SCHEMA_VERSION) throw new TypeError("package closure schema is invalid");
    validateSnapshot(value.snapshot);
    if (!Array.isArray(value.roots) || !same(value.roots, PACKAGE_ROOTS))
        throw new TypeError("package roots are invalid");
    if (!Array.isArray(value.indexes) || value.indexes.length < 1 || value.indexes.length > MAX_INDEX_COUNT)
        throw new TypeError("package indexes are invalid");
    if (!Array.isArray(value.releases) || value.releases.length !== value.snapshot.suites.length)
        throw new TypeError("package release signatures are invalid");
    const releaseSuites = new Set();
    for (const release of value.releases) {
        assertKeys(release, ["bytes", "inReleasePath", "sha256", "signatureVerified", "signerFingerprint", "suite"],
            "package release");
        exactString(release.suite, /^[a-z0-9-]+$/u, "package release suite");
        safeRelative(release.inReleasePath, SNAPSHOT_PATH_PATTERN, "package InRelease path");
        decimal(release.bytes, "package InRelease bytes", {positive: true});
        exactString(release.sha256, SHA256_PATTERN, "package InRelease hash");
        exactString(release.signerFingerprint, /^[a-f0-9]{40}$/u, "package signer fingerprint");
        if (!value.snapshot.suites.includes(release.suite) || releaseSuites.has(release.suite) ||
            release.inReleasePath !== `dists/${release.suite}/InRelease` || release.signatureVerified !== true ||
            release.signerFingerprint !== STAGE2_PROVENANCE.ubuntuArchiveSignerFingerprint)
            throw new TypeError("package release signature is invalid");
        releaseSuites.add(release.suite);
    }
    for (const suite of value.snapshot.suites)
        if (!releaseSuites.has(suite)) throw new TypeError("package release signature is missing");
    const indexKeys = new Set();
    for (const index of value.indexes) {
        assertKeys(index, ["architecture", "bytes", "component", "inReleaseSha256", "listedSha256", "path",
            "sha256", "suite"], "package index");
        if (!value.snapshot.suites.includes(index.suite) || !value.snapshot.components.includes(index.component) ||
            index.architecture !== value.snapshot.architecture)
            throw new TypeError("package index source is invalid");
        safeRelative(index.path, SNAPSHOT_PATH_PATTERN, "package index path");
        decimal(index.bytes, "package index bytes", {positive: true});
        exactString(index.sha256, SHA256_PATTERN, "package index hash");
        exactString(index.listedSha256, SHA256_PATTERN, "package index listed hash");
        exactString(index.inReleaseSha256, SHA256_PATTERN, "package index release hash");
        const release = value.releases.find(candidate => candidate.suite === index.suite);
        if (!release || index.sha256 !== index.listedSha256 || index.inReleaseSha256 !== release.sha256)
            throw new TypeError("package index signed hash binding is invalid");
        const key = `${index.suite}/${index.component}/${index.architecture}`;
        if (indexKeys.has(key)) throw new TypeError("package index is duplicated");
        indexKeys.add(key);
    }
    if (!Array.isArray(value.packages) || value.packages.length < PACKAGE_ROOTS.length ||
        value.packages.length > MAX_PACKAGE_COUNT) throw new TypeError("package records are invalid");
    const records = new Map();
    let totalBytes = 0n;
    for (const record of value.packages) {
        assertKeys(record, ["architecture", "bytes", "dependsOn", "filename", "name", "sha256", "version"],
            "package record");
        exactString(record.name, PACKAGE_NAME_PATTERN, "package name");
        exactString(record.version, VERSION_PATTERN, "package version");
        if (record.architecture !== "amd64" && record.architecture !== "all")
            throw new TypeError("package architecture is invalid");
        safeRelative(record.filename, PACKAGE_PATH_PATTERN, "package filename");
        totalBytes += decimal(record.bytes, "package bytes", {positive: true});
        exactString(record.sha256, SHA256_PATTERN, "package hash");
        if (!Array.isArray(record.dependsOn) || record.dependsOn.length > MAX_DEPENDENCIES ||
            record.dependsOn.some(item => typeof item !== "string" || item.length > 300))
            throw new TypeError("package dependencies are invalid");
        const reference = packageReference(record);
        if (records.has(reference)) throw new TypeError("package record is duplicated");
        records.set(reference, record);
    }
    if (totalBytes > MAX_TOOL_BYTES) throw new TypeError("package closure exceeds the tool budget");
    const rootReferences = [];
    for (const pin of TOP_LEVEL_PACKAGE_PINS) {
        const matches = [...records].filter(([, record]) => record.name === pin.name &&
            record.architecture === pin.architecture);
        if (matches.length !== 1) throw new TypeError("package root resolution is invalid");
        const record = matches[0][1];
        for (const key of ["version", "architecture", "filename", "bytes", "sha256"])
            if (record[key] !== pin[key]) throw new TypeError("package root pin is invalid");
        rootReferences.push(matches[0][0]);
    }
    for (const record of records.values()) {
        const uniqueDependencies = new Set(record.dependsOn);
        if (uniqueDependencies.size !== record.dependsOn.length) throw new TypeError("package dependency is duplicated");
        for (const dependency of record.dependsOn)
            if (!records.has(dependency)) throw new TypeError("package dependency is missing");
    }
    const reachable = new Set();
    const pending = [...rootReferences];
    while (pending.length > 0) {
        const reference = pending.pop();
        if (reachable.has(reference)) continue;
        reachable.add(reference);
        pending.push(...records.get(reference).dependsOn);
    }
    if (reachable.size !== records.size) throw new TypeError("package record is not reachable from a root");
    const canonical = structuredClone(value);
    canonical.packages.sort((left, right) => packageReference(left).localeCompare(packageReference(right), "en"));
    canonical.indexes.sort((left, right) => left.path.localeCompare(right.path, "en"));
    canonical.releases.sort((left, right) => left.suite.localeCompare(right.suite, "en"));
    return deepFreeze(canonical);
}

function validateImageRecord(value, name) {
    assertKeys(value, ["architecture", "editionId", "index", "installationType", "name", "totalBytes"], name);
    if (!Number.isInteger(value.index) || value.index < 1 || value.index > 100) throw new TypeError(`${name} index is invalid`);
    for (const key of ["name", "architecture", "editionId", "installationType"])
        exactString(value[key], /^[^\x00-\x1f\x7f]{1,160}$/u, `${name} ${key}`);
    decimal(value.totalBytes, `${name} total bytes`, {positive: true});
}

export function selectWindowsImage(inventory) {
    if (!Array.isArray(inventory) || inventory.length < 1 || inventory.length > 100)
        throw new TypeError("WIM image inventory is invalid");
    const indexes = new Set();
    for (const [offset, image] of inventory.entries()) {
        validateImageRecord(image, `WIM image ${offset}`);
        if (indexes.has(image.index)) throw new TypeError("WIM image index is duplicated");
        indexes.add(image.index);
    }
    const matches = inventory.filter(image => image.name === EXPECTED_IMAGE.name &&
        image.architecture === EXPECTED_IMAGE.architecture && image.editionId === EXPECTED_IMAGE.editionId &&
        image.installationType === EXPECTED_IMAGE.installationType);
    if (matches.length !== 1) {
        const observedImages = structuredClone(inventory);
        const diagnostic = {schemaVersion: SCHEMA_VERSION, kind: WIM_SELECTION_DIAGNOSTIC_KIND,
            expected: structuredClone(EXPECTED_IMAGE), matchCount: matches.length,
            observedImages, inventorySha256: canonicalSha256(observedImages)};
        if (Buffer.byteLength(JSON.stringify(diagnostic)) > MAX_WIM_SELECTION_DIAGNOSTIC_BYTES)
            throw new TypeError("WIM selection diagnostic exceeds its bound");
        throw new WimSelectionError(deepFreeze(diagnostic));
    }
    return deepFreeze(structuredClone(matches[0]));
}

function validatePaths(value, context) {
    const keys = ["installWim", "outputDisk", "ovmfVars", "packageRoot", "portableRoot", "probeRoot", "qemuPid", "root",
        "seedIso", "serialLog", "systemDisk", "windowsIso"];
    assertKeys(value, keys, "Stage 2 paths");
    const expectedRoot = `/home/runner/work/_temp/myspeed-windows-cpu-floor-${context.nonce}`;
    const expectedPortableRoot = `/tmp/myspeed-windows-cpu-floor-tools-${context.nonce}`;
    if (value.root !== expectedRoot || value.portableRoot !== expectedPortableRoot)
        throw new TypeError("Stage 2 root is invalid");
    const seen = new Set();
    for (const [key, candidate] of Object.entries(value)) {
        exactString(candidate, /^[^\x00-\x1f\x7f]{1,512}$/u, `Stage 2 ${key} path`);
        if (!path.posix.isAbsolute(candidate) || path.posix.normalize(candidate) !== candidate ||
            (key !== "root" && key !== "portableRoot" && !candidate.startsWith(`${expectedRoot}/`)) ||
            seen.has(candidate))
            throw new TypeError(`Stage 2 ${key} path is invalid`);
        seen.add(candidate);
    }
    return structuredClone(value);
}

export function validateStage2Paths(value, context) {
    return validatePaths(value, context);
}

function validateToolchain(value, portableRoot) {
    const toolKeys = ["capabilities", "firmware", "genisoimage", "installedFilesManifest", "licensesManifest", "mcopy",
        "mformat", "ovmfCode", "ovmfVarsTemplate", "packageClosureSha256", "qemu", "qemuImg", "runtime", "sevenZip",
        "wiminfo"];
    assertKeys(value, toolKeys, "portable toolchain");
    const commandPaths = {genisoimage: "usr/bin/genisoimage", mcopy: "usr/bin/mcopy", mformat: "usr/bin/mformat",
        qemu: "usr/bin/qemu-system-x86_64", qemuImg: "usr/bin/qemu-img", sevenZip: SEVEN_ZIP_RELATIVE_PATH,
        wiminfo: "usr/bin/wiminfo"};
    for (const key of ["genisoimage", "mcopy", "mformat", "ovmfCode", "ovmfVarsTemplate", "qemu", "qemuImg", "sevenZip",
        "wiminfo"]) {
        const expected = key === "qemu" ? ["bytes", "invocationPath", "ownership", "path", "sha256", "version"] :
            commandPaths[key] === undefined ? ["bytes", "ownership", "path", "sha256"] :
                ["bytes", "invocationPath", "ownership", "path", "sha256"];
        assertKeys(value[key], expected, `portable ${key}`);
        exactString(value[key].path, /^[^\x00-\x1f\x7f]{1,512}$/u, `portable ${key} path`);
        if (!value[key].path.startsWith(`${portableRoot}/`) || path.posix.normalize(value[key].path) !== value[key].path)
            throw new TypeError(`portable ${key} path is invalid`);
        if (commandPaths[key] !== undefined && value[key].invocationPath !== `${portableRoot}/${commandPaths[key]}`)
            throw new TypeError(`portable ${key} invocation path is invalid`);
        exactString(value[key].sha256, SHA256_PATTERN, `portable ${key} hash`);
        decimal(value[key].bytes, `portable ${key} bytes`, {positive: true});
        assertKeys(value[key].ownership, ["gid", "mode", "ordinaryUserWritable", "uid"],
            `portable ${key} ownership`);
        if (value[key].ownership.uid !== "0" || value[key].ownership.gid !== "0" ||
            value[key].ownership.ordinaryUserWritable !== false ||
            !/^[4567][045][045]$/u.test(value[key].ownership.mode))
            throw new TypeError(`portable ${key} ownership is invalid`);
    }
    assertKeys(value.firmware, ["kvmvapic", "searchPath", "vga"], "portable QEMU firmware");
    if (value.firmware.searchPath !== `${portableRoot}/usr/share/qemu`)
        throw new TypeError("portable QEMU firmware search path is invalid");
    for (const [key, expectedPath] of [["kvmvapic", `${portableRoot}/usr/share/qemu/kvmvapic.bin`],
        ["vga", `${portableRoot}/usr/share/seabios/vgabios-stdvga.bin`]]) {
        const firmware = value.firmware[key];
        assertKeys(firmware, ["bytes", "ownership", "path", "sha256"], `portable QEMU ${key} firmware`);
        if (firmware.path !== expectedPath) throw new TypeError(`portable QEMU ${key} firmware path is invalid`);
        exactString(firmware.sha256, SHA256_PATTERN, `portable QEMU ${key} firmware hash`);
        decimal(firmware.bytes, `portable QEMU ${key} firmware bytes`, {positive: true});
        assertKeys(firmware.ownership, ["gid", "mode", "ordinaryUserWritable", "uid"],
            `portable QEMU ${key} firmware ownership`);
        if (firmware.ownership.uid !== "0" || firmware.ownership.gid !== "0" ||
            firmware.ownership.ordinaryUserWritable !== false || !/^[4567][045][045]$/u.test(firmware.ownership.mode))
            throw new TypeError(`portable QEMU ${key} firmware ownership is invalid`);
    }
    assertKeys(value.runtime, ["libraryPath", "loader"], "portable runtime");
    assertKeys(value.runtime.loader, ["bytes", "ownership", "path", "sha256"], "portable runtime loader");
    if (!value.runtime.loader.path.startsWith(`${portableRoot}/`) ||
        path.posix.normalize(value.runtime.loader.path) !== value.runtime.loader.path)
        throw new TypeError("portable runtime loader path is invalid");
    exactString(value.runtime.loader.sha256, SHA256_PATTERN, "portable runtime loader hash");
    decimal(value.runtime.loader.bytes, "portable runtime loader bytes", {positive: true});
    assertKeys(value.runtime.loader.ownership, ["gid", "mode", "ordinaryUserWritable", "uid"],
        "portable runtime loader ownership");
    if (value.runtime.loader.ownership.uid !== "0" || value.runtime.loader.ownership.gid !== "0" ||
        value.runtime.loader.ownership.ordinaryUserWritable !== false ||
        !/^[4567][045][045]$/u.test(value.runtime.loader.ownership.mode))
        throw new TypeError("portable runtime loader ownership is invalid");
    const expectedLibraryPath = [path.posix.dirname(value.runtime.loader.path),
        `${portableRoot}/${SEVEN_ZIP_LIBRARY_RELATIVE_PATH}`];
    if (!Array.isArray(value.runtime.libraryPath) ||
        JSON.stringify(value.runtime.libraryPath) !== JSON.stringify(expectedLibraryPath))
        throw new TypeError("portable runtime library path is invalid");
    if (!value.qemu.version.startsWith("QEMU emulator version 8.2.2 "))
        throw new TypeError("QEMU version is invalid");
    exactString(value.packageClosureSha256, SHA256_PATTERN, "portable package closure hash");
    for (const key of ["installedFilesManifest", "licensesManifest"]) {
        assertKeys(value[key], ["bytes", "sha256"], `portable ${key}`);
        decimal(value[key].bytes, `portable ${key} bytes`, {positive: true});
        exactString(value[key].sha256, SHA256_PATTERN, `portable ${key} hash`);
    }
    assertKeys(value.capabilities, ["accelerator", "cpuModels", "devices", "machines"], "QEMU capabilities");
    if (value.capabilities.accelerator !== "kvm" || !value.capabilities.cpuModels.includes(CPU_MODEL) ||
        !value.capabilities.machines.includes(MACHINE_MODEL) ||
        !["ich9-ahci", "ide-cd", "ide-hd", "isa-serial", "VGA", "qemu-xhci", "usb-kbd"]
            .every(item => value.capabilities.devices.includes(item)))
        throw new TypeError("QEMU capability set is invalid");
    return deepFreeze(structuredClone(value));
}

function validatePackageAcquisition(value, packageClosure, pathsValue) {
    assertKeys(value, ["complete", "packages"], "package acquisition");
    if (value.complete !== true || !Array.isArray(value.packages) ||
        value.packages.length !== packageClosure.packages.length) throw new TypeError("package acquisition is incomplete");
    const expected = new Map(packageClosure.packages.map(record => [packageReference(record), record]));
    const observed = new Set();
    for (const record of value.packages) {
        assertKeys(record, ["bytes", "path", "reference", "sha256"], "acquired package");
        if (observed.has(record.reference) || !expected.has(record.reference))
            throw new TypeError("acquired package identity is invalid");
        observed.add(record.reference);
        const pinned = expected.get(record.reference);
        if (record.bytes !== pinned.bytes || record.sha256 !== pinned.sha256 ||
            !record.path.startsWith(`${pathsValue.packageRoot}/`) || path.posix.normalize(record.path) !== record.path)
            throw new TypeError("acquired package hash or path is invalid");
    }
    return deepFreeze(structuredClone(value));
}

/*
 * The one place the three probe names per role are written down. The release artifact spells two of
 * them with an underscore, the guest collector below opens '<role>.exe', and the seed entry is what
 * bridges them - so the table is an explicit literal rather than a transform, and a new role cannot
 * silently acquire a wrong artifact name. A drift test pins it against the release preparation.
 */
export const PROBE_SEED_FILES = deepFreeze([
    {role: "avx", artifactName: "avx.exe", seedName: "avx.exe"},
    {role: "avx2", artifactName: "avx2.exe", seedName: "avx2.exe"},
    {role: "cpuid", artifactName: "cpuid.exe", seedName: "cpuid.exe"},
    {role: "illegal", artifactName: "illegal.exe", seedName: "illegal.exe"},
    {role: "known-bad", artifactName: "known_bad.exe", seedName: "known-bad.exe"},
    {role: "known-good", artifactName: "known_good.exe", seedName: "known-good.exe"},
    {role: "popcnt", artifactName: "popcnt.exe", seedName: "popcnt.exe"},
    {role: "sse42", artifactName: "sse42.exe", seedName: "sse42.exe"}
]);
const PROBE_ROLES = Object.freeze(PROBE_SEED_FILES.map(entry => entry.role));
const PROBE_SEED_NAME_BY_ROLE = new Map(PROBE_SEED_FILES.map(entry => [entry.role, entry.seedName]));
const PROBE_SEED_NAME_BY_ARTIFACT = new Map(PROBE_SEED_FILES.map(entry => [entry.artifactName, entry.seedName]));
export function probeSeedName(artifactName) {
    const seedName = PROBE_SEED_NAME_BY_ARTIFACT.get(artifactName);
    if (seedName === undefined) throw new TypeError("probe artifact name is not a sealed probe");
    return seedName;
}

function validateProbeArtifact(value, context) {
    assertKeys(value, ["archive", "artifactId", "artifactName", "files", "innerManifest", "repository", "runAttempt",
        "runId", "schemaVersion", "sourceSha"], "probe artifact request");
    if (value.schemaVersion !== SCHEMA_VERSION || value.repository !== context.repository ||
        value.artifactName !== "windows-cpu-readiness-evidence") throw new TypeError("probe artifact header is invalid");
    exactString(value.sourceSha, /^[a-f0-9]{40}$/u, "probe artifact source SHA");
    for (const key of ["runId", "runAttempt", "artifactId"])
        exactString(value[key], /^[1-9][0-9]{0,19}$/u, `probe artifact ${key}`);
    assertKeys(value.archive, ["bytes", "sha256"], "probe artifact archive");
    decimal(value.archive.bytes, "probe artifact archive bytes", {positive: true});
    exactString(value.archive.sha256, SHA256_PATTERN, "probe artifact archive hash");
    assertKeys(value.innerManifest, ["bytes", "name", "sha256"], "probe artifact inner manifest");
    if (value.innerManifest.name !== "result.json") throw new TypeError("probe artifact inner manifest name is invalid");
    decimal(value.innerManifest.bytes, "probe artifact inner manifest bytes", {positive: true});
    exactString(value.innerManifest.sha256, SHA256_PATTERN, "probe artifact inner manifest hash");
    if (!Array.isArray(value.files) || value.files.length !== PROBE_ROLES.length)
        throw new TypeError("probe artifact file set is invalid");
    const roles = new Set();
    for (const file of value.files) {
        assertKeys(file, ["bytes", "name", "role", "sha256"], "probe artifact file");
        if (!PROBE_ROLES.includes(file.role) || roles.has(file.role) ||
            file.name !== `${file.role.replaceAll("-", "_")}.exe`)
            throw new TypeError("probe artifact role is invalid");
        roles.add(file.role);
        decimal(file.bytes, "probe artifact file bytes", {positive: true});
        exactString(file.sha256, SHA256_PATTERN, "probe artifact file hash");
    }
    return deepFreeze(structuredClone(value));
}

function validateAcquiredProbes(value, artifact, pathsValue) {
    assertKeys(value, ["archive", "files", "innerManifest"], "acquired probe closure");
    if (!same(value.archive, artifact.archive) || !same(value.innerManifest, artifact.innerManifest))
        throw new TypeError("acquired probe archive or inner manifest identity is invalid");
    if (!Array.isArray(value.files) || value.files.length !== artifact.files.length)
        throw new TypeError("acquired probe closure is incomplete");
    for (const expected of artifact.files) {
        const matches = value.files.filter(file => file.role === expected.role);
        if (matches.length !== 1) throw new TypeError("acquired probe role is invalid");
        const actual = matches[0];
        assertKeys(actual, ["bytes", "name", "path", "role", "sha256"], "acquired probe file");
        if (actual.name !== expected.name || actual.bytes !== expected.bytes || actual.sha256 !== expected.sha256 ||
            actual.path !== `${pathsValue.probeRoot}/${expected.name}`)
            throw new TypeError("acquired probe identity is invalid");
    }
    return deepFreeze(structuredClone(value));
}

function drive(id, format, file, readOnly = false) {
    return `if=none,id=${id},format=${format}${readOnly ? ",readonly=on" : ""},file=${file}`;
}

export function buildQemuArguments({paths: value, toolchain}) {
    const argv = ["-nodefaults", "-no-user-config", "-display", "none", "-monitor", "none", "-qmp", "stdio",
        "-L", toolchain.firmware.searchPath, "-accel", "kvm",
        "-machine", MACHINE_MODEL, "-cpu", CPU_MODEL, "-smp", "2,sockets=1,cores=2,threads=1", "-m", "6144M",
        "-device", `VGA,id=video0,romfile=${toolchain.firmware.vga.path}`, "-device", "qemu-xhci,id=usb0", "-device",
        "usb-kbd,bus=usb0.0",
        "-nic", "none", "-drive", `if=pflash,format=raw,readonly=on,file=${toolchain.ovmfCode.path}`,
        "-drive", `if=pflash,format=raw,file=${value.ovmfVars}`, "-device", "ich9-ahci,id=sata",
        "-drive", drive("osdisk", "qcow2", value.systemDisk), "-device",
        `ide-hd,drive=osdisk,bus=sata.1,bootindex=${SYSTEM_DISK_BOOT_INDEX}`,
        "-drive", drive("install", "raw", value.windowsIso, true), "-device",
        `ide-cd,drive=install,bus=sata.2,bootindex=${INSTALL_MEDIA_BOOT_INDEX}`,
        "-drive", drive("seed", "raw", value.seedIso, true), "-device", "ide-cd,drive=seed,bus=sata.3",
        "-drive", drive("output", "raw", value.outputDisk), "-device", "ide-hd,drive=output,bus=sata.4",
        "-chardev", `file,id=serial0,path=${value.serialLog}`, "-device", "isa-serial,chardev=serial0",
        "-pidfile", value.qemuPid];
    const forbiddenSwitches = new Set(["-net", "-netdev", "-virtfs", "-fsdev"]);
    if (argv.some(value => forbiddenSwitches.has(value) ||
        /(?:^|[,=])(?:tap|user|socket|vsock)(?:[,=]|$)|(?:^|[,=])(?:fat:|nbd:|ssh:|https?:)/iu.test(value) ||
        /^virtio-9p(?:-|,|$)/iu.test(value)))
        throw new TypeError("QEMU vector contains a forbidden backend");
    return deepFreeze(argv);
}

function validateAdmission(value, context) {
    const checkedContext = validateHostedContext(context);
    assertKeys(value, ["admitted", "budget", "classification", "context", "kvm", "mediaAcquisitionAuthorized",
        "observations", "qemuLaunchAuthorized", "qualifying", "reasons", "releaseGateCleared", "schemaVersion",
        "status"], "admission");
    if (value.schemaVersion !== SCHEMA_VERSION || value.classification !==
        "github-hosted-windows-cpu-floor-admission-nonqualifying" || value.status !== "admitted" ||
        value.admitted !== true || value.qualifying !== false || value.releaseGateCleared !== false ||
        value.mediaAcquisitionAuthorized !== false || value.qemuLaunchAuthorized !== false ||
        !same(value.context, checkedContext) || !same(value.budget, STAGE2_LIMITS) || !Array.isArray(value.reasons) ||
        value.reasons.length !== 0) throw new TypeError("admission is not accepted");
    assertKeys(value.kvm, ["combined", "ordinary"], "admission KVM identity");
    assertKeys(value.kvm.ordinary, ["bytes", "capability", "sha256"], "ordinary KVM identity");
    assertKeys(value.kvm.combined, ["bytes", "capability", "retryPerformed", "sha256"], "combined KVM identity");
    for (const identity of [value.kvm.ordinary, value.kvm.combined]) {
        if (!Number.isInteger(identity.bytes) || identity.bytes < 1 || identity.bytes > 262_144)
            throw new TypeError("admission KVM evidence size is invalid");
        exactString(identity.sha256, SHA256_PATTERN, "admission KVM evidence hash");
    }
}

function selectPrivilegeMode(admission) {
    if (admission.kvm.ordinary.capability === "usable" && admission.kvm.combined.capability === "ordinary-usable" &&
        admission.kvm.combined.retryPerformed === false) return "ordinary-kvm";
    if (admission.kvm.ordinary.capability === "permission-denied" && admission.kvm.combined.capability === "usable" &&
        admission.kvm.combined.retryPerformed === true) return "reviewed-sudo-kvm";
    throw new TypeError("admission KVM privilege mode is invalid");
}

function validateIso(value) {
    assertKeys(value, ["bytes", "etag", "finalUrl", "observerA", "observerB"], "Windows ISO observation");
    if (value.finalUrl !== STAGE2_PROVENANCE.windowsIso.finalUrl || value.bytes !== STAGE2_PROVENANCE.windowsIso.bytes ||
        value.etag !== STAGE2_PROVENANCE.windowsIso.strongEtag)
        throw new TypeError("Windows ISO provenance is invalid");
    for (const [name, observer] of [["A", value.observerA], ["B", value.observerB]]) {
        assertKeys(observer, ["id", "sha256"], `Windows ISO observer ${name}`);
        exactString(observer.id, /^[a-z0-9][a-z0-9-]{0,63}$/u, `Windows ISO observer ${name} id`);
        exactString(observer.sha256, SHA256_PATTERN, `Windows ISO observer ${name} hash`);
    }
    if (value.observerA.id === value.observerB.id || value.observerA.sha256 !== value.observerB.sha256)
        throw new TypeError("Windows ISO observers are not independent and matching");
    return {bytes: value.bytes, etag: value.etag, finalUrl: value.finalUrl, sha256: value.observerA.sha256,
        digestProvenance: STAGE2_PROVENANCE.windowsIso.digestProvenance, publisherDigestMatched: null};
}

function validateInstallWim(value, pathsValue, iso) {
    assertKeys(value, ["bytes", "path", "sha256", "sourceIsoSha256"], "install WIM observation");
    if (value.path !== pathsValue.installWim || value.sourceIsoSha256 !== iso.sha256)
        throw new TypeError("install WIM source binding is invalid");
    const bytes = decimal(value.bytes, "install WIM bytes", {positive: true});
    if (bytes > MAX_WIM_BYTES) throw new TypeError("install WIM exceeds its bound");
    exactString(value.sha256, SHA256_PATTERN, "install WIM hash");
    return structuredClone(value);
}

/*
 * Explicit locale configuration for the windowsPE pass, so no Setup page is left to a default this
 * harness never chose. Both generated answer files take the component from here rather than from a
 * second copy, and the installation media is the en-us evaluation ISO, so one locale covers every
 * field and needs no language pack. This component is valid only in the windowsPE pass.
 *
 * What this is NOT: a settled root cause for run 35106186247. The only evidence retained from that
 * run is two sampled frames and a QEMU that the launch budget killed; the first frame resembles the
 * "Select language settings" page, and nothing observed says the guest stayed there, that an answer
 * file was ever read, or that it progressed at all between the frames. The WinPE answer-file
 * diagnostic exists precisely because that question is open - configuring the locale removes one
 * candidate explanation, it does not confirm it was the explanation.
 */
const GUEST_SETUP_LOCALE = "en-US";

/*
 * The WinPE answer-file diagnostic's guest side: one fixed cmd script, seeded on the same read-only
 * ISO the answer file travels on, invoked by the one line the host types into a WinPE console.
 *
 * Identity before anything else. The script runs from wherever Setup mounted the seed, so it first
 * proves it is on the seed it was generated for - the volume label plus a marker file whose single
 * line carries this run's nonce - and only then looks for somewhere to write. The destination is
 * resolved the same way: exactly one volume carrying both the expected label and a marker naming
 * this nonce. Zero matches and two matches are distinct refusals, and nothing is written in either.
 *
 * No arbitrary names ever reach cmd syntax. The sources and the cache-presence probes are a fixed
 * allowlist of seven literal paths; the presence table records an index, a flag and a size, never a
 * discovered filename. The marker check counts lines with a `for /f` whose variable is never
 * expanded into a command, so a hostile marker file cannot inject anything.
 *
 * Cached answer files are probed for presence and size only and are never copied: an unattend.xml
 * Setup has cached contains this run's synthetic administrator password.
 */
const WINPE_DIAGNOSTIC_SEED_LABEL = "MYSPEEDSEED";
const WINPE_DIAGNOSTIC_OUTPUT_LABEL = "MYSPEEDOUT";
export const WINPE_DIAGNOSTIC_SEED_MARKER_NAME = "seed.tag";
export const WINPE_DIAGNOSTIC_OUTPUT_MARKER_NAME = "msout.tag";
export const WINPE_DIAGNOSTIC_EXIT_CODES = Object.freeze({
    complete: 0, seedMarkerAbsent: 11, seedIdentityDiffers: 12, destinationAmbiguous: 13,
    destinationAbsent: 14, outputPreexisting: 15, startMarkerUnwritable: 16, collectionIncomplete: 17
});
/*
 * The members the host is allowed to read back, and nothing else. Every name is 8.3-safe so it
 * survives a FAT short-name round trip unchanged.
 */
export const WINPE_DIAGNOSTIC_MEMBERS = Object.freeze([
    {name: "MSDIAG.STA", role: "start-marker"},
    {name: "MSACT.LOG", role: "setup-action-log"},
    {name: "MSERR.LOG", role: "setup-error-log"},
    {name: "MSBTACT.LOG", role: "setup-boot-action-log"},
    {name: "MSCACHE.TXT", role: "cache-presence"},
    {name: "MSDIAG.OK", role: "completion-marker"},
    {name: "MSDIAG.ERR", role: "incomplete-marker"}
]);
/* Index -> path, so the guest never has to echo a filesystem name into its report. */
export const WINPE_DIAGNOSTIC_CACHE_PROBES = Object.freeze([
    "X:\\Windows\\Panther\\unattend.xml",
    "X:\\Windows\\Panther\\Unattend\\unattend.xml",
    "X:\\$Windows.~BT\\Sources\\Panther\\unattend.xml",
    "X:\\Windows\\Panther\\setupact.log",
    "X:\\Windows\\Panther\\setuperr.log",
    "X:\\$Windows.~BT\\Sources\\Panther\\setupact.log",
    "X:\\$Windows.~BT\\Sources\\Panther\\setuperr.log"
]);

export function winpeDiagnosticSeedMarker(nonce) { return `${WINPE_DIAGNOSTIC_SEED_LABEL} ${nonce}`; }
export function winpeDiagnosticOutputMarker(nonce) { return `${WINPE_DIAGNOSTIC_OUTPUT_LABEL} ${nonce}`; }

/*
 * The six lines a test may replace. Everything below the seam is byte-identical between the script
 * this renders for the guest and the script a fixture exercises under a local cmd.exe.
 */
export const WINPE_DIAGNOSTIC_PRODUCTION_SEAM = Object.freeze({
    seed: "%~dp0",
    seedVolume: "%~d0",
    volumePrefix: "vol ",
    volumeSuffix: "",
    /* Quoted tokens, so a root is one `for` item whatever it contains, and `%%~D` unquotes it. */
    roots: [..."cdefghijklmnopqrstuvwyz"].map(letter => `"${letter}:"`).join(" "),
    sources: Object.freeze(["X:\\Windows\\Panther\\setupact.log", "X:\\Windows\\Panther\\setuperr.log",
        "X:\\$Windows.~BT\\Sources\\Panther\\setupact.log"]),
    cacheProbes: WINPE_DIAGNOSTIC_CACHE_PROBES
});

export function renderWinpeDiagnosticScript(nonce, seam = WINPE_DIAGNOSTIC_PRODUCTION_SEAM) {
    exactString(nonce, /^[a-f0-9]{32}$/u, "WinPE diagnostic nonce");
    if (seam.sources.length !== 3 || seam.cacheProbes.length !== WINPE_DIAGNOSTIC_CACHE_PROBES.length)
        throw new TypeError("WinPE diagnostic seam is invalid");
    const backslash = String.fromCharCode(92);
    const dest = `%MSDEST%${backslash}`;
    const lines = [
        "@echo off",
        "setlocal EnableExtensions DisableDelayedExpansion",
        `set "MSSEEDMARK=${winpeDiagnosticSeedMarker(nonce)}"`,
        `set "MSOUTMARK=${winpeDiagnosticOutputMarker(nonce)}"`,
        `set "MSSEEDLABEL=${WINPE_DIAGNOSTIC_SEED_LABEL}"`,
        `set "MSOUTLABEL=${WINPE_DIAGNOSTIC_OUTPUT_LABEL}"`,
        /* Absolute system tool paths: a PATH this script did not set must not choose its tools. */
        `set "MSGREP=%SystemRoot%${backslash}System32${backslash}findstr.exe"`,
        "rem ---- seam ----",
        `set "MSSEED=${seam.seed}"`,
        `set "MSSEEDVOL=${seam.seedVolume}"`,
        `set "MSVOLPRE=${seam.volumePrefix}"`,
        `set "MSVOLPOST=${seam.volumeSuffix}"`,
        `set "MSROOTS=${seam.roots}"`,
        ...seam.sources.map((source, index) => `set "MSSRC${index + 1}=${source}"`),
        ...seam.cacheProbes.map((probe, index) => `set "MSCACHE${index + 1}=${probe}"`),
        "rem ---- end seam ----",
        `if not exist "%MSSEED%${WINPE_DIAGNOSTIC_SEED_MARKER_NAME}" exit /b ` +
            `${WINPE_DIAGNOSTIC_EXIT_CODES.seedMarkerAbsent}`,
        `call :marker "%MSSEED%${WINPE_DIAGNOSTIC_SEED_MARKER_NAME}" "%MSSEEDMARK%"`,
        `if errorlevel 1 exit /b ${WINPE_DIAGNOSTIC_EXIT_CODES.seedIdentityDiffers}`,
        "call :label \"%MSSEEDVOL%\" \"%MSSEEDLABEL%\"",
        `if errorlevel 1 exit /b ${WINPE_DIAGNOSTIC_EXIT_CODES.seedIdentityDiffers}`,
        "set \"MSDEST=\"",
        "set \"MSCOUNT=0\"",
        "for %%D in (%MSROOTS%) do call :probe \"%%~D\"",
        `if "%MSCOUNT%"=="0" exit /b ${WINPE_DIAGNOSTIC_EXIT_CODES.destinationAbsent}`,
        `if not "%MSCOUNT%"=="1" exit /b ${WINPE_DIAGNOSTIC_EXIT_CODES.destinationAmbiguous}`,
        `if not defined MSDEST exit /b ${WINPE_DIAGNOSTIC_EXIT_CODES.destinationAbsent}`,
        ...WINPE_DIAGNOSTIC_MEMBERS.map(member =>
            `if exist "${dest}${member.name}" exit /b ${WINPE_DIAGNOSTIC_EXIT_CODES.outputPreexisting}`),
        `>"${dest}MSDIAG.STA" echo %MSOUTMARK%`,
        `if errorlevel 1 exit /b ${WINPE_DIAGNOSTIC_EXIT_CODES.startMarkerUnwritable}`,
        `if not exist "${dest}MSDIAG.STA" exit /b ${WINPE_DIAGNOSTIC_EXIT_CODES.startMarkerUnwritable}`,
        "set \"MSFAIL=0\"",
        "call :grab \"%MSSRC1%\" \"MSACT.LOG\"",
        "call :grab \"%MSSRC2%\" \"MSERR.LOG\"",
        "call :grab \"%MSSRC3%\" \"MSBTACT.LOG\"",
        `>"${dest}MSCACHE.TXT" echo %MSOUTMARK%`,
        "if errorlevel 1 set \"MSFAIL=1\"",
        ...WINPE_DIAGNOSTIC_CACHE_PROBES.map((probe, index) =>
            `call :cache ${index + 1} "%MSCACHE${index + 1}%"`),
        `if not exist "${dest}MSCACHE.TXT" set "MSFAIL=1"`,
        "if not \"%MSFAIL%\"==\"0\" goto :incomplete",
        `>"${dest}MSDIAG.OK" echo %MSOUTMARK%`,
        `if errorlevel 1 exit /b ${WINPE_DIAGNOSTIC_EXIT_CODES.collectionIncomplete}`,
        `if not exist "${dest}MSDIAG.OK" exit /b ${WINPE_DIAGNOSTIC_EXIT_CODES.collectionIncomplete}`,
        `exit /b ${WINPE_DIAGNOSTIC_EXIT_CODES.complete}`,
        "",
        ":incomplete",
        `>"${dest}MSDIAG.ERR" echo %MSOUTMARK%`,
        `exit /b ${WINPE_DIAGNOSTIC_EXIT_CODES.collectionIncomplete}`,
        "",
        /*
         * Exactly one non-blank line, and that line matches. The loop variable is counted and never
         * expanded into a command, so marker content can never become cmd syntax.
         */
        ":marker",
        "set \"MSN=0\"",
        "for /f \"usebackq delims=\" %%L in (\"%~1\") do set /a MSN=MSN+1",
        "if not \"%MSN%\"==\"1\" exit /b 1",
        "\"%MSGREP%\" /x /c:\"%~2\" \"%~1\" >nul 2>&1",
        "if errorlevel 1 exit /b 1",
        "exit /b 0",
        "",
        /*
         * The label as reported by the volume itself under en-US WinPE. Parsed deterministically
         * from the expected `Volume in drive <X> is <LABEL>` line, requiring exact label equality.
         * Unrecognized output, missing label or non-matching label fails closed.
         */
        ":label",
        "set \"MSMATCH=0\"",
        "for /f \"tokens=1-5* delims= \" %%A in ('\"%MSVOLPRE%%~1%MSVOLPOST%\" 2^>nul') do " +
            "if \"%%A\"==\"Volume\" if \"%%B\"==\"in\" if \"%%C\"==\"drive\" if \"%%E\"==\"is\" if \"%%F\"==\"%~2\" set \"MSMATCH=1\"",
        "if not \"%MSMATCH%\"==\"1\" exit /b 1",
        "exit /b 0",
        "",
        ":probe",
        "set \"MSP=%~1\"",
        `if not exist "%MSP%${backslash}${WINPE_DIAGNOSTIC_OUTPUT_MARKER_NAME}" goto :eof`,
        `call :marker "%MSP%${backslash}${WINPE_DIAGNOSTIC_OUTPUT_MARKER_NAME}" "%MSOUTMARK%"`,
        "if errorlevel 1 goto :eof",
        "call :label \"%MSP%\" \"%MSOUTLABEL%\"",
        "if errorlevel 1 goto :eof",
        "set \"MSDEST=%MSP%\"",
        "set /a MSCOUNT=MSCOUNT+1",
        "goto :eof",
        "",
        /*
         * A source that does not exist is recorded as absent by the presence table, not as a
         * failure; a copy that was attempted and did not land is a failure.
         */
        ":grab",
        "if not exist \"%~1\" goto :eof",
        `copy /y "%~1" "${dest}%~2" >nul 2>&1`,
        "if errorlevel 1 set \"MSFAIL=1\"",
        `if not exist "${dest}%~2" set "MSFAIL=1"`,
        "goto :eof",
        "",
        ":cache",
        `if not exist "%~2" >>"${dest}MSCACHE.TXT" echo %~1=0 0`,
        "if not exist \"%~2\" goto :eof",
        `for %%F in ("%~2") do >>"${dest}MSCACHE.TXT" echo %~1=1 %%~zF`,
        "goto :eof",
        ""
    ];
    const text = lines.join("\r\n");
    /*
     * A render-time gate on the exact class of bug that silently rewrites this script: a backslash
     * or a percent eaten by JavaScript escaping produces a valid-looking batch file that writes
     * somewhere else. Every path separator the body depends on is asserted here, so the failure is
     * at render time rather than inside a guest nobody can see.
     */
    for (const expected of [`"%MSSEED%${WINPE_DIAGNOSTIC_SEED_MARKER_NAME}"`,
        `"%MSP%${backslash}${WINPE_DIAGNOSTIC_OUTPUT_MARKER_NAME}"`, `"${dest}MSDIAG.STA"`,
        `"${dest}MSDIAG.OK"`, `"${dest}MSDIAG.ERR"`, `"${dest}MSCACHE.TXT"`, `"${dest}%~2"`,
        "%SystemRoot%\\System32\\findstr.exe", "%MSVOLPRE%%~1%MSVOLPOST%", "%%~zF", "%MSOUTMARK%"])
        if (!text.includes(expected))
            throw new Error(`rendered WinPE diagnostic script lost ${expected}`);
    if (/[^\r]\n|\r(?!\n)/u.test(text)) throw new Error("rendered WinPE diagnostic script line endings differ");
    return Buffer.from(text, "ascii");
}

export const WINDOWS_PE_INTERNATIONAL_COMPONENT =
    `<component name="Microsoft-Windows-International-Core-WinPE" processorArchitecture="amd64" ` +
    `publicKeyToken="31bf3856ad364e35" language="neutral" versionScope="nonSxS">` +
    `<SetupUILanguage><UILanguage>${GUEST_SETUP_LOCALE}</UILanguage></SetupUILanguage>` +
    `<InputLocale>${GUEST_SETUP_LOCALE}</InputLocale><SystemLocale>${GUEST_SETUP_LOCALE}</SystemLocale>` +
    `<UILanguage>${GUEST_SETUP_LOCALE}</UILanguage><UserLocale>${GUEST_SETUP_LOCALE}</UserLocale></component>`;

function renderAutounattend(image, nonce) {
    const password = `Myspeed-Eval-${nonce.slice(0, 16)}!aA1`;
    const xml = `<?xml version="1.0" encoding="utf-8"?>\r\n<unattend xmlns="urn:schemas-microsoft-com:unattend" ` +
        `xmlns:wcm="http://schemas.microsoft.com/WMIConfig/2002/State">\r\n` +
        `<settings pass="windowsPE">${WINDOWS_PE_INTERNATIONAL_COMPONENT}` +
        `<component name="Microsoft-Windows-Setup" processorArchitecture="amd64" ` +
        `publicKeyToken="31bf3856ad364e35" language="neutral" versionScope="nonSxS"><DiskConfiguration>` +
        `<Disk wcm:action="add"><DiskID>0</DiskID><WillWipeDisk>true</WillWipeDisk><CreatePartitions>` +
        `<CreatePartition wcm:action="add"><Order>1</Order><Size>100</Size><Type>EFI</Type></CreatePartition>` +
        `<CreatePartition wcm:action="add"><Order>2</Order><Size>16</Size><Type>MSR</Type></CreatePartition>` +
        `<CreatePartition wcm:action="add"><Order>3</Order><Extend>true</Extend><Type>Primary</Type></CreatePartition>` +
        `</CreatePartitions><ModifyPartitions><ModifyPartition wcm:action="add"><Order>1</Order><PartitionID>1</PartitionID>` +
        `<Format>FAT32</Format><Label>System</Label></ModifyPartition><ModifyPartition wcm:action="add"><Order>2</Order>` +
        `<PartitionID>3</PartitionID><Format>NTFS</Format><Label>Windows</Label><Letter>C</Letter></ModifyPartition>` +
        `</ModifyPartitions></Disk></DiskConfiguration><ImageInstall><OSImage>` +
        `<InstallFrom><MetaData wcm:action="add"><Key>/IMAGE/NAME</Key><Value>${image.name}</Value>` +
        `</MetaData></InstallFrom><InstallTo><DiskID>0</DiskID><PartitionID>3</PartitionID></InstallTo>` +
        `</OSImage></ImageInstall><UserData><AcceptEula>true</AcceptEula></UserData></component></settings>\r\n` +
        `<settings pass="specialize"><component name="Microsoft-Windows-Deployment" processorArchitecture="amd64" ` +
        `publicKeyToken="31bf3856ad364e35" language="neutral" versionScope="nonSxS"><RunSynchronous>` +
        `<RunSynchronousCommand wcm:action="add"><Order>1</Order><Path>powershell.exe -NoLogo -NoProfile ` +
        `-NonInteractive -ExecutionPolicy Bypass -Command &quot;$s=(Get-Volume -FileSystemLabel MYSPEEDSEED ` +
        `-ErrorAction Stop).DriveLetter; &amp; ($s+':\\install-activation.ps1')&quot;</Path>` +
        `</RunSynchronousCommand></RunSynchronous></component></settings>\r\n` +
        `<settings pass="oobeSystem"><component name="Microsoft-Windows-Shell-Setup" processorArchitecture="amd64" ` +
        `publicKeyToken="31bf3856ad364e35" language="neutral" versionScope="nonSxS"><UserAccounts>` +
        `<AdministratorPassword><Value>${password}</Value><PlainText>true</PlainText></AdministratorPassword>` +
        `</UserAccounts></component></settings>\r\n</unattend>\r\n`;
    return Buffer.from(xml, "utf8");
}

export function renderGuestBootstrap(context) {
    const activation = buildPostSetupActivation(context);
    const nonce = context.nonce;
    const setupComplete = activation.files.setupComplete;
    const dispatcher = activation.files.dispatcher;
    const startupTask = activation.startupTask;
    const activationRoot = path.win32.dirname(setupComplete.path);
    if (activationRoot !== path.win32.dirname(dispatcher.path))
        throw new TypeError("activation installed files do not share one root");
    const roles = PROBE_ROLES.map(role => `'${role}'`).join(",");
    const script = `param([switch]$LibraryMode)\r\n$ErrorActionPreference = 'Stop'\r\nSet-StrictMode -Version Latest\r\n` +
        `$EXPECTED_NONCE = '${nonce}'\r\n$MAX_STREAM_BYTES = 4096\r\n$EXPECTED_ILLEGAL_EXIT = 3221225501L\r\n` +
        `$PROBE_TIMEOUT_MILLISECONDS = ${GUEST_PROBE_TIMEOUT_MILLISECONDS}\r\n` +
        `$PROBE_CLEANUP_TIMEOUT_MILLISECONDS = ${GUEST_PROBE_CLEANUP_TIMEOUT_MILLISECONDS}\r\n` +
        `$MAX_FAILURE_MESSAGE_CHARACTERS = ${MAX_GUEST_FAILURE_MESSAGE_CHARACTERS}\r\n` +
        `$MAX_SYSTEM_TOOL_BYTES = ${MAX_SYSTEM_TOOL_BYTES}\r\n` +
        /*
         * The installed paths are part of the host contract, so the guest reports the declared
         * paths rather than paths it assembles from %SystemRoot% - which Windows Setup writes as
         * `C:\WINDOWS`, against a host comparison that is case sensitive.
         */
        `$EXPECTED_ACTIVATION_ROOT = '${activationRoot}'\r\n` +
        `$EXPECTED_SETUP_COMPLETE_PATH = '${setupComplete.path}'\r\n` +
        `$EXPECTED_DISPATCHER_PATH = '${dispatcher.path}'\r\n` +
        `$EXPECTED_SETUP_COMPLETE_BYTES = ${setupComplete.bytes}\r\n` +
        `$EXPECTED_SETUP_COMPLETE_SHA = '${setupComplete.sha256}'\r\n` +
        `$EXPECTED_DISPATCHER_BYTES = ${dispatcher.bytes}\r\n` +
        `$EXPECTED_DISPATCHER_SHA = '${dispatcher.sha256}'\r\n` +
        /*
         * The two shutdown marker bodies, rendered from the same function the host reconstructs them
         * with, so the bytes on the disk and the bytes the host compares against have one source.
         * JSON carries no apostrophe, which is what makes a single-quoted literal byte-exact here.
         */
        `$SHUTDOWN_OUTCOME_NAME = '${SHUTDOWN_OUTCOME_SOURCE}'\r\n` +
        `$SHUTDOWN_RETURNED_JSON = '${canonicalShutdownMarker(nonce, "returned").toString("utf8")}'\r\n` +
        `$SHUTDOWN_FAILED_JSON = '${canonicalShutdownMarker(nonce, "failed").toString("utf8")}'\r\n` +
        `function Get-MyspeedGuestFileSha([IO.Stream]$Stream) {\r\n` +
        `  $sha = [Security.Cryptography.SHA256]::Create()\r\n` +
        `  try { return ([BitConverter]::ToString($sha.ComputeHash($Stream))).Replace('-','').ToLowerInvariant() } ` +
        `finally { $sha.Dispose() }\r\n}\r\n` +
        `function New-MyspeedGuestNativeOperations {\r\n` +
        `  Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class ` +
        `MyspeedErrorMode { [DllImport("kernel32.dll")] public static extern uint SetErrorMode(uint mode); }'\r\n` +
        `  $probeTimeoutMilliseconds = $PROBE_TIMEOUT_MILLISECONDS\r\n` +
        `  $probeCleanupTimeoutMilliseconds = $PROBE_CLEANUP_TIMEOUT_MILLISECONDS\r\n` +
        `  $expectedActivationRoot = $EXPECTED_ACTIVATION_ROOT\r\n` +
        `  $expectedSetupCompletePath = $EXPECTED_SETUP_COMPLETE_PATH\r\n` +
        `  $expectedDispatcherPath = $EXPECTED_DISPATCHER_PATH\r\n` +
        `  $expectedSetupCompleteBytes = $EXPECTED_SETUP_COMPLETE_BYTES\r\n` +
        `  $expectedSetupCompleteSha = $EXPECTED_SETUP_COMPLETE_SHA\r\n` +
        `  $expectedDispatcherBytes = $EXPECTED_DISPATCHER_BYTES\r\n` +
        `  $expectedDispatcherSha = $EXPECTED_DISPATCHER_SHA\r\n` +
        `  $getFileSha = \${function:Get-MyspeedGuestFileSha}.GetNewClosure()\r\n` +
        `  $maximumStreamBytes = $MAX_STREAM_BYTES\r\n` +
        `  $maximumSystemToolBytes = $MAX_SYSTEM_TOOL_BYTES\r\n` +
        `  $expectedNonce = $EXPECTED_NONCE\r\n` +
        `  $collectEvidence = { param([string]$Seed)\r\n` +
        `    $runs = [Collections.Generic.List[object]]::new()\r\n    foreach ($role in @(${roles})) {\r\n` +
        `    $stdout = Join-Path $env:SystemRoot ('Temp\\myspeed-' + $role + '.stdout')\r\n` +
        `    $stderr = Join-Path $env:SystemRoot ('Temp\\myspeed-' + $role + '.stderr')\r\n` +
        `    $process = Start-Process -FilePath (Join-Path $Seed ($role + '.exe')) -NoNewWindow -PassThru ` +
        `-RedirectStandardOutput $stdout -RedirectStandardError $stderr\r\n` +
        `    try {\r\n      $null = $process.Handle\r\n` +
        `      if (-not $process.WaitForExit($probeTimeoutMilliseconds)) {\r\n        $process.Kill()\r\n` +
        `        if (-not $process.WaitForExit($probeCleanupTimeoutMilliseconds)) { ` +
        `throw 'Probe cleanup exceeded its deadline' }\r\n        throw 'Probe exceeded its deadline'\r\n      }\r\n` +
        `      $rawExit = $process.ExitCode\r\n      if ($rawExit -isnot [int]) { ` +
        `throw 'Probe exit code is unavailable' }\r\n` +
        `      $stdoutBytes = [IO.File]::ReadAllBytes($stdout); $stderrBytes = [IO.File]::ReadAllBytes($stderr)\r\n` +
        `      if ($stdoutBytes.Length -gt $maximumStreamBytes -or $stderrBytes.Length -gt $maximumStreamBytes) { ` +
        `throw 'Probe stream exceeded its bound' }\r\n` +
        `      $unsignedExit = [BitConverter]::ToUInt32([BitConverter]::GetBytes([int32]$rawExit),0)\r\n` +
        `      $runs.Add([ordered]@{role=$role;exitCode=$unsignedExit;` +
        `stdoutBase64=[Convert]::ToBase64String($stdoutBytes);stderrBase64=[Convert]::ToBase64String($stderrBytes)})\r\n` +
        `      Remove-Item -LiteralPath $stdout,$stderr -Force -ErrorAction Stop\r\n` +
        `    } finally { $process.Dispose() }\r\n    }\r\n` +
        `    $physical = @(Get-CimInstance Win32_NetworkAdapter -ErrorAction Stop | Where-Object { $_.PhysicalAdapter -eq $true })\r\n` +
        `    $enabled = @(Get-NetAdapter -IncludeHidden -ErrorAction Stop | Where-Object { $_.Status -eq 'Up' -and ` +
        `$_.InterfaceDescription -notmatch 'Loopback' })\r\n` +
        `    $routes = @(Get-NetRoute -ErrorAction Stop | Where-Object { $_.InterfaceAlias -notmatch 'Loopback' })\r\n` +
        `    return [ordered]@{schemaVersion=1;nonce=$expectedNonce;runs=$runs;network=[ordered]@{` +
        `hardwareNics=$physical.Count;enabledNonLoopbackInterfaces=$enabled.Count;nonLoopbackRoutes=$routes.Count}}\r\n` +
        `  }.GetNewClosure()\r\n` +
        `  $observeSystemTools = {\r\n` +
        `    $systemTools = [Collections.Generic.List[object]]::new()\r\n` +
        `    foreach ($expectedTool in @(` + WINDOWS_SYSTEM_TOOL_PATHS.map(tool =>
            `[pscustomobject]@{role='${tool.role}';path='${tool.path}'}`).join(",") + `)) {\r\n` +
        `      $toolItem = Get-Item -LiteralPath $expectedTool.path -Force -ErrorAction Stop\r\n` +
        `      if ($toolItem -isnot [IO.FileInfo] -or ` +
        `($toolItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or $toolItem.Length -lt 1 -or ` +
        `$toolItem.Length -gt $maximumSystemToolBytes) { throw 'Windows system tool identity differs' }\r\n` +
        `      $toolStream = $null; try {\r\n` +
        `        $toolStream = [IO.File]::Open($expectedTool.path,[IO.FileMode]::Open,[IO.FileAccess]::Read,` +
        `[IO.FileShare]::Read)\r\n` +
        `        if ($toolStream.Length -ne $toolItem.Length -or $toolStream.Length -lt 1 -or ` +
        `$toolStream.Length -gt $maximumSystemToolBytes) { throw 'Windows system tool stream differs' }\r\n` +
        `        $toolBytes = [string]$toolStream.Length; $toolSha = & $getFileSha $toolStream\r\n` +
        `        if ($toolStream.Length -ne $toolItem.Length -or [string]$toolStream.Length -cne $toolBytes) { ` +
        `throw 'Windows system tool changed while hashing' }\r\n` +
        `        $systemTools.Add([ordered]@{role=$expectedTool.role;path=$expectedTool.path;` +
        `bytes=$toolBytes;sha256=$toolSha})\r\n` +
        `      } finally { if ($null -ne $toolStream) { $toolStream.Dispose() } }\r\n` +
        `    }\r\n` +
        `    return $systemTools\r\n` +
        `  }.GetNewClosure()\r\n` +
        `  $observeActivation = {\r\n` +
        `    $root = $expectedActivationRoot\r\n` +
        `    $rootItem = Get-Item -LiteralPath $root -Force -ErrorAction Stop\r\n` +
        `    if ($rootItem -isnot [IO.DirectoryInfo] -or ` +
        `($rootItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { ` +
        `throw 'MSI activation target root differs' }\r\n` +
        `    $records = [ordered]@{}\r\n` +
        `    foreach ($expected in @(` +
        `[pscustomobject]@{key='setupComplete';name='SetupComplete.cmd';path=$expectedSetupCompletePath;` +
        `bytes=$expectedSetupCompleteBytes;sha=$expectedSetupCompleteSha},` +
        `[pscustomobject]@{key='dispatcher';name='myspeed-msi-setupcomplete.ps1';` +
        `path=$expectedDispatcherPath;bytes=$expectedDispatcherBytes;sha=$expectedDispatcherSha})) {\r\n` +
        `      $target = Join-Path $root $expected.name; $targetItem = Get-Item -LiteralPath $target ` +
        `-Force -ErrorAction Stop\r\n` +
        `      if ($targetItem -isnot [IO.FileInfo] -or ` +
        `($targetItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or ` +
        `$targetItem.Length -ne [int64]$expected.bytes) { throw 'MSI activation installed file differs' }\r\n` +
        `      $targetStream = $null; try {\r\n` +
        `        $targetStream = [IO.File]::Open($target,[IO.FileMode]::Open,[IO.FileAccess]::Read,` +
        `[IO.FileShare]::Read)\r\n` +
        `        if ($targetStream.Length -ne [int64]$expected.bytes -or ` +
        `(& $getFileSha $targetStream) -cne $expected.sha) { ` +
        `throw 'MSI activation installed identity differs' }\r\n` +
        `        $records[$expected.key] = [ordered]@{path=$expected.path;bytes=[int64]$expected.bytes;` +
        `sha256=[string]$expected.sha}\r\n` +
        `      } finally { if ($null -ne $targetStream) { $targetStream.Dispose() } }\r\n` +
        `    }\r\n` +
        `    $tasks=@(Get-ScheduledTask -TaskName '${startupTask.name}' -TaskPath '${startupTask.path}' ` +
        `-ErrorAction Stop);if($tasks.Count-ne 1){throw 'MSI startup task count differs'};$task=$tasks[0];` +
        `$actions=@($task.Actions);$triggers=@($task.Triggers);if($actions.Count-ne 1-or$triggers.Count-ne 1-or` +
        `[string]$actions[0].Execute-cne'${startupTask.executable}'-or` +
        `[string]$actions[0].Arguments-cne'${startupTask.arguments}'-or` +
        `[string]$task.Principal.UserId-cne'${startupTask.principal}'-or` +
        `[string]$task.Principal.RunLevel-cne'${startupTask.runLevel}'-or` +
        `[string]$triggers[0].CimClass.CimClassName-cne'MSFT_TaskBootTrigger'-or` +
        `$triggers[0].Enabled-ne$true){throw 'MSI startup task identity differs'}\r\n` +
        `    return [ordered]@{state='windows-setup-complete-startup-dispatch-ready';setupCompleted=$true;` +
        `startupTaskInstalled=$true;nativeMsiExecutionStarted=$false;files=$records;startupTask=[ordered]@{` +
        `name='${startupTask.name}';path='${startupTask.path}';trigger='${startupTask.trigger}';` +
        `principal='${startupTask.principal}';runLevel='${startupTask.runLevel}';` +
        `executable='${startupTask.executable}';arguments='${startupTask.arguments}'}}\r\n` +
        `  }.GetNewClosure()\r\n` +
        `  $writeExclusive = { param([string]$Path,[byte[]]$Bytes)\r\n` +
        `    $temporaryPath = $Path + '.tmp'\r\n    try {\r\n` +
        `      $stream = [IO.FileStream]::new($temporaryPath,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,` +
        `[IO.FileShare]::None)\r\n` +
        `      try { $stream.Write($Bytes,0,$Bytes.Length); $stream.Flush($true) } finally { $stream.Dispose() }\r\n` +
        `      $observed = [IO.File]::ReadAllBytes($temporaryPath)\r\n` +
        `      if (-not [Collections.StructuralComparisons]::StructuralEqualityComparer.Equals($observed,$Bytes)) { ` +
        `throw 'Guest outcome write verification failed' }\r\n` +
        `      [IO.File]::Move($temporaryPath,$Path)\r\n` +
        `    } catch {\r\n      if ([IO.File]::Exists($temporaryPath)) { ` +
        `[IO.File]::Delete($temporaryPath) }\r\n      throw\r\n    }\r\n` +
        `  }.GetNewClosure()\r\n` +
        `  return @{SetErrorMode={ param([uint32]$Mode) [MyspeedErrorMode]::SetErrorMode($Mode) };` +
        `ResolveVolume={ param([string]$Label) (Get-Volume -FileSystemLabel $Label -ErrorAction Stop).DriveLetter + ':\\' };` +
        `CollectEvidence=$collectEvidence;ObserveActivation=$observeActivation;ObserveSystemTools=$observeSystemTools;` +
        `WriteExclusive=$writeExclusive}\r\n}\r\n` +
        `function Invoke-MyspeedGuestBootstrap {\r\n  param([hashtable]$Operations,` +
        `[scriptblock]$Shutdown = { Stop-Computer -Force })\r\n` +
        `  $bootstrapFailure = $null\r\n  $outputRoot = $null\r\n  $successBytes = $null\r\n` +
        `  $errorModeChanged = $false\r\n` +
        `  try {\r\n    if ($null -eq $Operations) { $Operations = New-MyspeedGuestNativeOperations }\r\n` +
        `    foreach ($name in @('SetErrorMode','ResolveVolume','CollectEvidence','ObserveActivation','ObserveSystemTools',` +
        `'WriteExclusive')) { ` +
        `if ($Operations[$name] -isnot [scriptblock]) { throw ('Guest operation is absent: ' + $name) } }\r\n` +
        `    $previousErrorMode = & $Operations.SetErrorMode 3\r\n` +
        `    if ($previousErrorMode -isnot [uint32]) { throw 'Previous error mode is invalid' }\r\n` +
        `    $errorModeChanged = $true\r\n` +
        `    $seed = & $Operations.ResolveVolume 'MYSPEEDSEED'\r\n` +
        `    $outputRoot = & $Operations.ResolveVolume 'MYSPEEDOUT'\r\n` +
        `    $record = & $Operations.CollectEvidence $seed\r\n` +
        `    $record.activation = & $Operations.ObserveActivation\r\n` +
        `    $record.systemTools = & $Operations.ObserveSystemTools\r\n` +
        `    $successBytes = [Text.UTF8Encoding]::new($false).GetBytes(($record | ConvertTo-Json -Compress -Depth 8))\r\n` +
        `  } catch {\r\n    $bootstrapFailure = $_\r\n  } finally {\r\n    try {\r\n` +
        `      if ($errorModeChanged) {\r\n        try { $null = & $Operations.SetErrorMode $previousErrorMode } ` +
        `catch { $bootstrapFailure = $_ }\r\n      }\r\n` +
        `      if ($null -ne $outputRoot -and $Operations['WriteExclusive'] -is [scriptblock]) {\r\n` +
        `        if ($null -ne $bootstrapFailure) {\r\n          try {\r\n` +
        `            $message = [regex]::Replace([string]$bootstrapFailure.Exception.Message, ` +
        `'[\\x00-\\x1f\\x7f]+', ' ')\r\n` +
        `            if ($message.Length -gt $MAX_FAILURE_MESSAGE_CHARACTERS) { ` +
        `$message = $message.Substring(0,$MAX_FAILURE_MESSAGE_CHARACTERS) }\r\n` +
        `            $failureRecord = [ordered]@{schemaVersion=1;status='failed';nonce=$EXPECTED_NONCE;` +
        `stage='guest-bootstrap';failure=$message}\r\n` +
        `            $failureBytes = [Text.UTF8Encoding]::new($false).GetBytes(($failureRecord | ` +
        `ConvertTo-Json -Compress -Depth 4))\r\n` +
        `            & $Operations.WriteExclusive (Join-Path $outputRoot 'result.json') $failureBytes\r\n` +
        `          } catch { }\r\n        }\r\n      }\r\n` +
        `      if ($null -eq $bootstrapFailure -and $null -ne $successBytes) {\r\n        try { ` +
        `& $Operations.WriteExclusive (Join-Path $outputRoot 'result.json') $successBytes } ` +
        `catch { $bootstrapFailure = $_ }\r\n      }\r\n` +
        /*
         * One marker, written only after the shutdown call has returned or thrown. Nothing new runs
         * before the invocation, so nothing new can delay or prevent reaching it; a call that never
         * returns simply leaves no marker. There is no catch around `& $Shutdown`, so the exception
         * the caller observes is exactly the one it observed before this existed, and the write
         * reuses the receipt write's own guard so an unresolved output root writes nothing.
         */
        `    } finally {\r\n      $outcomeJson = $SHUTDOWN_FAILED_JSON\r\n      try {\r\n` +
        `        & $Shutdown\r\n        $outcomeJson = $SHUTDOWN_RETURNED_JSON\r\n` +
        `      } finally {\r\n` +
        `        if ($null -ne $outputRoot -and $Operations['WriteExclusive'] -is [scriptblock]) {\r\n` +
        `          try { & $Operations.WriteExclusive (Join-Path $outputRoot $SHUTDOWN_OUTCOME_NAME) ` +
        `([Text.UTF8Encoding]::new($false).GetBytes($outcomeJson)) } catch { }\r\n` +
        `        }\r\n      }\r\n    }\r\n  }\r\n` +
        `  if ($null -ne $bootstrapFailure) { throw $bootstrapFailure }\r\n}\r\n` +
        `if (-not $LibraryMode) { Invoke-MyspeedGuestBootstrap }\r\n`;
    return Buffer.from(script, "utf8");
}

function buildSeedSpec(image, context, probes, activation, winpeDiagnostic = undefined) {
    const unattend = renderAutounattend(image, context.nonce);
    const bootstrap = renderGuestBootstrap(context);
    const handoff = createWindowsBaseCalibrationHandoff(activation, {name: "bootstrap.ps1",
        bytes: bootstrap.length, sha256: sha256(bootstrap)});
    const handoffBytes = Buffer.from(JSON.stringify(handoff), "utf8");
    const files = [
        {name: "Autounattend.xml", kind: "inline", bytes: String(unattend.length), sha256: sha256(unattend),
            bytesBase64: unattend.toString("base64")},
        {name: "bootstrap.ps1", kind: "inline", bytes: String(bootstrap.length), sha256: sha256(bootstrap),
            bytesBase64: bootstrap.toString("base64")},
        {name: activation.seedInstaller.name, kind: "activation-installer",
            bytes: String(activation.seedInstaller.bytes), sha256: activation.seedInstaller.sha256,
            bytesBase64: activation.seedInstaller.bytesBase64},
        {name: "myspeed-base-calibration-handoff.json", kind: "activation-handoff",
            bytes: String(handoffBytes.length), sha256: sha256(handoffBytes),
            bytesBase64: handoffBytes.toString("base64")},
        ...Object.values(activation.files).map(file => ({name: path.win32.basename(file.path),
            kind: "activation-inline", bytes: String(file.bytes), sha256: file.sha256,
            bytesBase64: file.bytesBase64})),
        ...probes.files.map(file => ({name: PROBE_SEED_NAME_BY_ROLE.get(file.role), kind: "owned-file",
            bytes: file.bytes, sha256: file.sha256, sourcePath: file.path})),
        /*
         * Only an explicitly authorized diagnostic puts a runnable script and a seed marker on the
         * media. Without the authorization the seed is byte-for-byte what it has always been, so no
         * ordinary calibration run carries anything a console could invoke.
         */
        ...(winpeDiagnostic === undefined ? [] : (() => {
            const script = renderWinpeDiagnosticScript(context.nonce);
            const marker = Buffer.from(`${winpeDiagnosticSeedMarker(context.nonce)}\r\n`, "ascii");
            return [
                {name: winpeDiagnosticScriptName(context.nonce), kind: "inline",
                    bytes: String(script.length), sha256: sha256(script),
                    bytesBase64: script.toString("base64")},
                {name: WINPE_DIAGNOSTIC_SEED_MARKER_NAME, kind: "inline", bytes: String(marker.length),
                    sha256: sha256(marker), bytesBase64: marker.toString("base64")}
            ];
        })())
    ];
    return deepFreeze({schemaVersion: SCHEMA_VERSION, format: "iso9660", volumeLabel: "MYSPEEDSEED", files,
        sha256: canonicalSha256(files)});
}

function validatePreparedMedia(value, pathsValue, seedSpec, toolchain) {
    assertKeys(value, ["outputDisk", "ovmfVars", "seedIso", "systemDisk"], "prepared media");
    assertKeys(value.seedIso, ["bytes", "format", "path", "sha256", "sourceManifestSha256", "volumeLabel"], "seed ISO");
    assertKeys(value.outputDisk, ["bytes", "format", "path", "sha256", "volumeLabel"], "guest output disk");
    assertKeys(value.systemDisk, ["bytes", "format", "path", "sha256", "virtualBytes"], "guest system disk");
    assertKeys(value.ovmfVars, ["path", "sha256"], "OVMF variables copy");
    if (value.seedIso.path !== pathsValue.seedIso || value.seedIso.sourceManifestSha256 !== seedSpec.sha256 ||
        value.seedIso.format !== "iso9660" || value.seedIso.volumeLabel !== "MYSPEEDSEED" ||
        decimal(value.seedIso.bytes, "seed ISO bytes", {positive: true}) > 2_147_483_648n ||
        value.outputDisk.path !== pathsValue.outputDisk || value.outputDisk.bytes !== GUEST_OUTPUT_BYTES ||
        value.outputDisk.format !== "raw-fat" || value.outputDisk.volumeLabel !== "MYSPEEDOUT" ||
        value.systemDisk.path !== pathsValue.systemDisk || decimal(value.systemDisk.bytes, "guest system disk bytes",
            {positive: true}) > decimal(value.systemDisk.virtualBytes, "guest system disk virtual bytes", {positive: true}) ||
        value.systemDisk.virtualBytes !== GUEST_DISK_BYTES ||
        value.systemDisk.format !== "qcow2" || value.ovmfVars.path !== pathsValue.ovmfVars ||
        value.ovmfVars.sha256 !== toolchain.ovmfVarsTemplate.sha256)
        throw new TypeError("prepared media identity is invalid");
    exactString(value.seedIso.sha256, SHA256_PATTERN, "seed ISO hash");
    exactString(value.outputDisk.sha256, SHA256_PATTERN, "empty guest output disk hash");
    exactString(value.systemDisk.sha256, SHA256_PATTERN, "guest system disk hash");
    return deepFreeze(structuredClone(value));
}

export function validateGuestFailure(value, expectedNonce) {
    assertKeys(value, ["failure", "nonce", "schemaVersion", "stage", "status"], "guest failure evidence");
    if (value.schemaVersion !== SCHEMA_VERSION || value.nonce !== expectedNonce ||
        (value.stage !== "guest-bootstrap" && value.stage !== "post-setup-completion") || value.status !== "failed" ||
        typeof value.failure !== "string" || value.failure.length < 1 ||
        value.failure.length > MAX_GUEST_FAILURE_MESSAGE_CHARACTERS ||
        /[\x00-\x1f\x7f]/u.test(value.failure)) throw new TypeError("guest failure evidence is invalid");
    return deepFreeze(structuredClone(value));
}

function validateGuest(value, pathsValue, expectedNonce, activation) {
    if (value?.status === "failed") {
        return validateGuestFailure(value, expectedNonce);
    }
    assertKeys(value, ["activation", "cpu", "instructions", "network", "output", "schemaVersion", "status",
        "systemTools"],
        "guest evidence");
    if (value.schemaVersion !== SCHEMA_VERSION || value.status !== "observed") throw new TypeError("guest header is invalid");
    assertKeys(value.cpu, ["avx", "avx2", "osxsave", "popcnt", "sse42", "xcr0"], "guest CPUID");
    if (value.cpu.sse42 !== true || value.cpu.popcnt !== true || value.cpu.osxsave !== false ||
        value.cpu.avx !== false || value.cpu.avx2 !== false || value.cpu.xcr0 !== null)
        throw new TypeError("guest CPUID does not establish the target floor");
    assertKeys(value.instructions, ["avx", "avx2", "popcnt", "sse42"], "guest instruction probes");
    if (value.instructions.sse42 !== "completed" || value.instructions.popcnt !== "completed" ||
        value.instructions.avx !== "illegal-instruction" || value.instructions.avx2 !== "illegal-instruction")
        throw new TypeError("guest instruction probes do not establish the target floor");
    assertKeys(value.network, ["enabledNonLoopbackInterfaces", "hardwareNics", "nonLoopbackRoutes"], "guest network");
    if (value.network.hardwareNics !== 0 || value.network.enabledNonLoopbackInterfaces !== 0 ||
        value.network.nonLoopbackRoutes !== 0) throw new TypeError("guest network isolation is not proven");
    validateWindowsSystemTools(value.systemTools);
    if (!same(value.activation, activationEvidence(activation)))
        throw new TypeError("guest MSI post-setup activation evidence is invalid");
    assertKeys(value.output, ["bytes", "path", "sha256"], "guest output");
    if (value.output.path !== pathsValue.outputDisk || value.output.bytes !== GUEST_OUTPUT_BYTES)
        throw new TypeError("guest output disk binding is invalid");
    exactString(value.output.sha256, SHA256_PATTERN, "guest output hash");
    return deepFreeze(structuredClone(value));
}

const WINPE_DIAGNOSTIC_COLLECTION_STATUSES = new Set(["capture-complete", "inconclusive", "unsafe",
    "not-attempted"]);
const WINPE_DIAGNOSTIC_MEMBER_STATUSES = new Set(["captured", "absent", "timeout", "tool-error",
    "cleanup-unproven", "unreadable", "budget-exhausted", "withheld-mixed-encoding",
    "withheld-unaccounted", "withheld-unredactable"]);

/*
 * The retained diagnostic payload, bounded member by member. A member is either a base64 body that
 * was decoded and redacted in full before it was cut, or a named reason it is not here - never a
 * raw scratch log, never a cached answer file, never an unredacted error stream.
 */
export function validateWinpeDiagnosticEvidence(value, context, authorization) {
    const checked = validateWinpeDiagnosticAuthorization(authorization);
    if (checked === undefined) throw new TypeError("WinPE diagnostic evidence is not authorized");
    assertKeys(value, ["collection", "confirmation", "input", "kind", "nonce", "schemaVersion"],
        "WinPE diagnostic evidence");
    if (value.schemaVersion !== SCHEMA_VERSION || value.kind !== "winpe-answer-file-diagnostic" ||
        value.nonce !== context.nonce || value.nonce !== checked.nonce ||
        value.confirmation !== checked.confirmation)
        throw new TypeError("WinPE diagnostic evidence binding is invalid");
    if (value.input !== null) validateWinpeDiagnosticInput(value.input, checked);
    assertKeys(value.collection, ["failure", "kind", "members", "outputDiskVerified", "schemaVersion",
        "status"], "WinPE diagnostic collection");
    if (value.collection.schemaVersion !== SCHEMA_VERSION ||
        value.collection.kind !== "winpe-answer-file-diagnostic-collection" ||
        !WINPE_DIAGNOSTIC_COLLECTION_STATUSES.has(value.collection.status) ||
        typeof value.collection.outputDiskVerified !== "boolean" ||
        !Array.isArray(value.collection.members) ||
        value.collection.members.length > WINPE_DIAGNOSTIC_MEMBERS.length ||
        (value.collection.failure !== null && (typeof value.collection.failure !== "string" ||
            value.collection.failure.length < 1 || value.collection.failure.length > 256 ||
            /[\x00-\x1f\x7f]/u.test(value.collection.failure))))
        throw new TypeError("WinPE diagnostic collection is invalid");
    const expected = new Map(WINPE_DIAGNOSTIC_MEMBERS.map(member => [member.name, member.role]));
    const seen = new Set();
    for (const member of value.collection.members) {
        if (!member || typeof member !== "object" || Array.isArray(member) ||
            expected.get(member.name) !== member.role || seen.has(member.name) ||
            !WINPE_DIAGNOSTIC_MEMBER_STATUSES.has(member.status))
            throw new TypeError("WinPE diagnostic member is invalid");
        seen.add(member.name);
        if (member.status !== "captured") continue;
        assertKeys(member, ["acceptedBytes", "bom", "decodeReplacements", "encoding", "name",
            "partialRedactionHits", "publicationTruncated", "publishedBytes", "readCapReached",
            "redactionHits", "role", "sha256", "status", "textBase64", "trailingOddByte"],
        "WinPE diagnostic captured member");
        exactString(member.sha256, SHA256_PATTERN, "WinPE diagnostic member hash");
        if (!["utf-8", "utf-16le"].includes(member.encoding) ||
            !Number.isSafeInteger(member.publishedBytes) || member.publishedBytes < 0 ||
            typeof member.textBase64 !== "string" ||
            member.textBase64.length > MAX_WINPE_DIAGNOSTIC_MEMBER_BASE64_CHARACTERS ||
            !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(member.textBase64))
            throw new TypeError("WinPE diagnostic captured member is invalid");
        const bytes = Buffer.from(member.textBase64, "base64");
        if (bytes.length !== member.publishedBytes || sha256(bytes) !== member.sha256)
            throw new TypeError("WinPE diagnostic member identity differs");
    }
    return deepFreeze(structuredClone(value));
}

/*
 * `diagnosticExit` is the one extra parameter that reaches every validly authorized exit: when a
 * WinPE diagnostic is authorized, no failure on any stage may carry the calibration classification.
 */
function failure(context, stage, error, cleanupProven = true, diagnosticExit = null) {
    const message = (error instanceof Error ? error.message : String(error)).replace(/[\x00-\x1f\x7f]+/g, " ")
        .slice(0, MAX_GUEST_FAILURE_MESSAGE_CHARACTERS);
    const diagnosticFields = stage === "wim-inspection" && error instanceof WimSelectionError ?
        {wimSelection: structuredClone(error.diagnostic)} : stage === "qemu-launch" && (error instanceof QemuLaunchError || error instanceof GuestBootstrapError) ?
            {
                ...(error instanceof QemuLaunchError ? {qemuLaunch: structuredClone(error.diagnostic)} : {}),
                ...(error.earlyBoot === null || error.earlyBoot === undefined ? {} :
                    {qemuEarlyBoot: structuredClone(error.earlyBoot)}),
                ...(error.guestFailure === null || error.guestFailure === undefined ? {} :
                    {guestFailure: structuredClone(error.guestFailure)})
            } : {};
    const baseResult = {schemaVersion: SCHEMA_VERSION, status: "failed", stage,
        classification: diagnosticExit?.classification ?? CLASSIFICATION,
        qualifying: false, releaseGateCleared: false, cpuCalibrationAccepted: false, cleanupProven,
        context: structuredClone(context), failure: message || "unspecified failure", ...diagnosticFields};
    if (stage === "qemu-launch" && (error instanceof QemuLaunchError || error instanceof GuestBootstrapError) &&
        error.lateBoot !== null && error.lateBoot !== undefined) {
        const candidateResult = {...baseResult, qemuLateBoot: structuredClone(error.lateBoot)};
        const serialized = Buffer.byteLength(`${JSON.stringify(candidateResult)}\n`, "utf8");
        if (serialized <= MAX_STAGE2_RESULT_BYTES) {
            return deepFreeze(candidateResult);
        }
    }
    return deepFreeze(baseResult);
}

/*
 * The one result a WinPE diagnostic run produces, on the success path as on every other. It is
 * never `status: "observed"`, never carries `cpuCalibrationAccepted: true`, and always names the
 * diagnostic classification - so a diagnostic run that somehow reached the end of the launcher
 * still cannot be read as a calibration by anything downstream.
 *
 * The payload is attached first and the sampled frames only if the serialized record still fits.
 * The collected guest log is the point of the run; a frame is a picture of a screen.
 */
function winpeDiagnosticResult(context, pathsValue, observation, authorization, bootConfirmation) {
    const allowed = ["argv", "earlyBoot", "guest", "process", "winpeDiagnostic"];
    if (observation?.lateBoot !== undefined) allowed.push("lateBoot");
    if (observation?.failureDiagnostic !== undefined) allowed.push("failureDiagnostic");
    if (observation?.guestFailure !== undefined) allowed.push("guestFailure");
    assertKeys(observation, allowed, "WinPE diagnostic QEMU observation");
    const evidence = validateWinpeDiagnosticEvidence(observation.winpeDiagnostic, context, authorization);
    const cleanupProven = observation.process?.cleanupProven === true &&
        observation.process?.treeGone === true;
    const base = {schemaVersion: SCHEMA_VERSION, status: "diagnostic", stage: WINPE_DIAGNOSTIC_STAGE,
        classification: WINPE_DIAGNOSTIC_CLASSIFICATION, qualifying: false, releaseGateCleared: false,
        cpuCalibrationAccepted: false, cleanupProven, context: structuredClone(context),
        qemuProcess: structuredClone(observation.process), winpeDiagnostic: structuredClone(evidence),
        ...(bootConfirmation === undefined ? {} : {bootConfirmation})};
    let result = base;
    const fits = candidate =>
        Buffer.byteLength(`${JSON.stringify(candidate)}\n`, "utf8") <= MAX_STAGE2_RESULT_BYTES;
    if (!fits(result)) throw new Error("WinPE diagnostic result exceeds its retained bound");
    for (const [key, value] of [["qemuEarlyBoot", observation.earlyBoot],
        ["qemuLateBoot", observation.lateBoot]]) {
        if (value === null || value === undefined) continue;
        const candidate = {...result, [key]: structuredClone(value)};
        if (fits(candidate)) result = candidate;
    }
    return deepFreeze(result);
}

export function validateWindowsSystemTools(value) {
    if (!Array.isArray(value) || value.length !== WINDOWS_SYSTEM_TOOL_PATHS.length)
        throw new TypeError("Windows system tool identities are invalid");
    for (let index = 0; index < WINDOWS_SYSTEM_TOOL_PATHS.length; index += 1) {
        const observed = value[index];
        const expected = WINDOWS_SYSTEM_TOOL_PATHS[index];
        assertKeys(observed, ["bytes", "path", "role", "sha256"], "Windows system tool identity");
        if (observed.role !== expected.role || observed.path !== expected.path ||
            decimal(observed.bytes, "Windows system tool bytes", {positive: true}) > MAX_SYSTEM_TOOL_BYTES)
            throw new TypeError("Windows system tool identity differs");
        exactString(observed.sha256, SHA256_PATTERN, "Windows system tool SHA-256");
    }
    return deepFreeze(structuredClone(value));
}

function validateDiagnosticStream(value, name) {
    assertKeys(value, ["bytes", "bytesBase64", "sha256"], `QEMU ${name} diagnostic`);
    const byteCount = decimal(value.bytes, `QEMU ${name} bytes`);
    exactString(value.sha256, SHA256_PATTERN, `QEMU ${name} hash`);
    if (byteCount > BigInt(MAX_QEMU_DIAGNOSTIC_STREAM_BYTES) || typeof value.bytesBase64 !== "string" ||
        value.bytesBase64.length > MAX_QEMU_DIAGNOSTIC_BASE64_CHARACTERS ||
        !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value.bytesBase64))
        throw new TypeError(`QEMU ${name} diagnostic is invalid`);
    const bytes = Buffer.from(value.bytesBase64, "base64");
    if (bytes.length !== Number(byteCount) || sha256(bytes) !== value.sha256)
        throw new TypeError(`QEMU ${name} diagnostic identity differs`);
}

function validateSerialDiagnostic(value) {
    /* Legacy records predate capture status and retain their original complete-stream shape. */
    if (value?.status === undefined) return validateDiagnosticStream(value, "serial log");
    if (value.status === "unavailable") {
        assertKeys(value, ["status"], "QEMU serial log diagnostic");
        return;
    }
    assertKeys(value, ["bytes", "bytesBase64", "observedBytes", "sha256", "status", "truncated"],
        "QEMU serial log diagnostic");
    if (value.status !== "captured" || typeof value.truncated !== "boolean")
        throw new TypeError("QEMU serial log diagnostic is invalid");
    validateDiagnosticStream({bytes: value.bytes, bytesBase64: value.bytesBase64, sha256: value.sha256}, "serial log");
    const capturedBytes = decimal(value.bytes, "QEMU serial log bytes");
    const observedBytes = decimal(value.observedBytes, "QEMU serial log observed bytes");
    const maximumCapturedBytes = BigInt(MAX_QEMU_DIAGNOSTIC_STREAM_BYTES);
    const expectedCapturedBytes = observedBytes > maximumCapturedBytes ? maximumCapturedBytes : observedBytes;
    if (observedBytes > BigInt(Number.MAX_SAFE_INTEGER) || capturedBytes !== expectedCapturedBytes ||
        value.truncated !== (observedBytes > capturedBytes))
        throw new TypeError("QEMU serial log capture extent is invalid");
}

export const MAX_GUEST_BYTES = 262_144;
export const GUEST_FAILURE_FALLBACK_NAME = "bootstrap-failure.json";
export const RECEIPT_SOURCES = deepFreeze(["result.json", GUEST_FAILURE_FALLBACK_NAME]);
export const RECEIPT_STATUSES = deepFreeze(["valid-failure", "valid-success", "malformed", "unavailable"]);
export const RECEIPT_UNAVAILABLE_REASONS = deepFreeze([
    "cleanup-unproven",
    "output-disk-unverified",
    "disk-identity-mismatch",
    "extraction-timeout",
    "extraction-unsafe",
    "extraction-budget-exhausted",
    "tool-error",
    "receipt-not-retrieved"
]);
/*
 * One fixed code per validation region the guest receipt parsers already contain, so a rejected
 * receipt says WHICH check refused it rather than only that something did. The vocabulary is closed
 * and carries no observed value, no guest text and no exception message: a code is published only
 * when the parser itself marked the rejection, and anything else stays `schema-invalid`. Growing
 * this list never changes the diagnostic's shape, status or key set, so records retained before it
 * existed replay unchanged.
 */
export const RECEIPT_REJECTION_CODES = deepFreeze([
    "result-header-invalid",
    "probe-run-invalid",
    "cpuid-run-failed",
    "cpuid-output-invalid",
    "cpu-floor-unmet",
    "control-probe-mismatch",
    "fault-probe-not-illegal",
    "network-not-isolated",
    "activation-invalid",
    "system-tools-invalid",
    "failure-receipt-invalid"
]);
export const RECEIPT_MALFORMED_REASONS = deepFreeze([
    "json-syntax-error",
    "nonce-mismatch",
    "schema-invalid",
    "partial-read",
    "read-cap-exceeded",
    ...RECEIPT_REJECTION_CODES
]);

/*
 * The receipt diagnostic is the one place a failed run says what it found on the guest's output
 * disk, so every branch of it is bound to the run it belongs to. The expected nonce is threaded in
 * from the retained result rather than read back out of the record: a diagnostic that validates its
 * own nonce proves only that some run wrote something, which is exactly the claim this evidence is
 * not allowed to make.
 *
 * Byte counts are bound to the extraction ceiling the host actually reads with. `read-cap-exceeded`
 * is the capped-prefix case and must carry exactly that cap, because any other extent is one the
 * extraction could not have produced.
 */
export function validateReceiptDiagnostic(value, expectedNonce) {
    exactString(expectedNonce, /^[a-f0-9]{32}$/u, "receipt diagnostic expected nonce");
    if (value === null || typeof value !== "object" || Array.isArray(value))
        throw new TypeError("QEMU receipt diagnostic is invalid");
    if (!RECEIPT_STATUSES.includes(value.status))
        throw new TypeError("QEMU receipt diagnostic is invalid");
    const boundedBytes = (bytesValue, {positive = false} = {}) => {
        const parsed = decimal(bytesValue, "QEMU receipt diagnostic bytes", {positive});
        if (parsed > BigInt(MAX_GUEST_BYTES)) throw new TypeError("QEMU receipt diagnostic bytes is invalid");
        return parsed;
    };

    if (value.status === "valid-failure") {
        assertKeys(value, ["receipt", "schemaVersion", "source", "status"], "QEMU receipt diagnostic");
        if (value.schemaVersion !== SCHEMA_VERSION || !RECEIPT_SOURCES.includes(value.source))
            throw new TypeError("QEMU receipt diagnostic is invalid");
        if (value.receipt === null || typeof value.receipt !== "object" || Array.isArray(value.receipt))
            throw new TypeError("QEMU receipt diagnostic is invalid");
        exactString(value.receipt.nonce, /^[a-f0-9]{32}$/u, "receipt nonce");
        validateGuestFailure(value.receipt, expectedNonce);
        return deepFreeze(structuredClone(value));
    }
    if (value.status === "valid-success") {
        assertKeys(value, ["bytes", "schemaVersion", "sha256", "source", "status"], "QEMU receipt diagnostic");
        if (value.schemaVersion !== SCHEMA_VERSION || value.source !== "result.json")
            throw new TypeError("QEMU receipt diagnostic is invalid");
        boundedBytes(value.bytes, {positive: true});
        exactString(value.sha256, SHA256_PATTERN, "QEMU receipt diagnostic sha256");
        return deepFreeze(structuredClone(value));
    }
    if (value.status === "malformed") {
        assertKeys(value, ["bytes", "reason", "schemaVersion", "sha256", "source", "status"], "QEMU receipt diagnostic");
        if (value.schemaVersion !== SCHEMA_VERSION || !RECEIPT_SOURCES.includes(value.source) ||
            !RECEIPT_MALFORMED_REASONS.includes(value.reason))
            throw new TypeError("QEMU receipt diagnostic is invalid");
        const observed = boundedBytes(value.bytes);
        if (value.reason === "read-cap-exceeded" && observed !== BigInt(MAX_GUEST_BYTES))
            throw new TypeError("QEMU receipt diagnostic bytes is invalid");
        if (value.reason === "partial-read" && observed === 0n)
            throw new TypeError("QEMU receipt diagnostic bytes is invalid");
        exactString(value.sha256, SHA256_PATTERN, "QEMU receipt diagnostic sha256");
        return deepFreeze(structuredClone(value));
    }
    // Fixed reasons preserve the failure category without publishing potentially secret exception text.
    assertKeys(value, ["reason", "schemaVersion", "status"], "QEMU receipt diagnostic");
    if (value.schemaVersion !== SCHEMA_VERSION || !RECEIPT_UNAVAILABLE_REASONS.includes(value.reason))
        throw new TypeError("QEMU receipt diagnostic is invalid");
    return deepFreeze(structuredClone(value));
}

/*
 * The one file the guest writes after its shutdown scriptblock has returned or thrown, and the only
 * evidence in this module permitted to say anything about that invocation. No receipt state - the
 * success receipt, the bootstrap failure receipt, or the worker's own `post-setup-completion`
 * record - locates execution relative to it: `result.json` has two writers on two different code
 * paths, and the worker's writer can fire both before the bootstrap is entered and after the
 * shutdown call has already returned.
 *
 * The marker is bytes, not a shape. Host and guest build it from this one function, so a record is
 * bound to its run by reconstruction rather than by a field the record carries about itself: a
 * marker from another nonce, or an outcome switched after the fact, cannot survive replay.
 */
export const SHUTDOWN_OUTCOME_SOURCE = "shutdown-outcome.json";
export const MAX_GUEST_SHUTDOWN_BYTES = 4_096;
const GUEST_SHUTDOWN_STAGE = "guest-shutdown";
export const SHUTDOWN_OUTCOMES = deepFreeze(["returned", "failed"]);
export const SHUTDOWN_STATUSES = deepFreeze(["observed", "not-retrieved", "malformed", "unavailable"]);
export const SHUTDOWN_MALFORMED_REASONS = deepFreeze([
    "json-syntax-error",
    "nonce-mismatch",
    "schema-invalid",
    "partial-read",
    "read-cap-exceeded"
]);
/*
 * The receipt's own unavailable vocabulary minus `receipt-not-retrieved`, which names the receipt
 * file and is the one outcome after which this read is still authorized. A marker that was not
 * retrieved is a status of its own, never an unavailable reason.
 */
export const SHUTDOWN_UNAVAILABLE_REASONS = deepFreeze(
    RECEIPT_UNAVAILABLE_REASONS.filter(reason => reason !== "receipt-not-retrieved"));

export function canonicalShutdownMarker(nonce, outcome) {
    exactString(nonce, /^[a-f0-9]{32}$/u, "guest shutdown marker nonce");
    if (!SHUTDOWN_OUTCOMES.includes(outcome))
        throw new TypeError("guest shutdown marker outcome is invalid");
    return Buffer.from(JSON.stringify({schemaVersion: SCHEMA_VERSION, nonce, stage: GUEST_SHUTDOWN_STAGE,
        event: outcome}), "utf8");
}

export function validateShutdownDiagnostic(value, expectedNonce) {
    exactString(expectedNonce, /^[a-f0-9]{32}$/u, "QEMU shutdown diagnostic expected nonce");
    if (value === null || typeof value !== "object" || Array.isArray(value) ||
        !SHUTDOWN_STATUSES.includes(value.status) || value.schemaVersion !== SCHEMA_VERSION)
        throw new TypeError("QEMU shutdown diagnostic is invalid");

    if (value.status === "observed") {
        assertKeys(value, ["bytes", "outcome", "schemaVersion", "sha256", "status"], "QEMU shutdown diagnostic");
        if (!SHUTDOWN_OUTCOMES.includes(value.outcome))
            throw new TypeError("QEMU shutdown diagnostic is invalid");
        /* The retained extent and digest are load-bearing: they are re-derived, never trusted. */
        const canonical = canonicalShutdownMarker(expectedNonce, value.outcome);
        if (value.bytes !== String(canonical.length) || value.sha256 !== sha256(canonical))
            throw new TypeError("QEMU shutdown diagnostic identity is invalid");
        return deepFreeze(structuredClone(value));
    }
    if (value.status === "not-retrieved") {
        assertKeys(value, ["schemaVersion", "status"], "QEMU shutdown diagnostic");
        return deepFreeze(structuredClone(value));
    }
    if (value.status === "malformed") {
        assertKeys(value, ["bytes", "reason", "schemaVersion", "sha256", "status"], "QEMU shutdown diagnostic");
        if (!SHUTDOWN_MALFORMED_REASONS.includes(value.reason))
            throw new TypeError("QEMU shutdown diagnostic is invalid");
        const observed = decimal(value.bytes, "QEMU shutdown diagnostic bytes");
        if (observed > BigInt(MAX_GUEST_SHUTDOWN_BYTES) ||
            (value.reason === "read-cap-exceeded" && observed !== BigInt(MAX_GUEST_SHUTDOWN_BYTES)) ||
            (value.reason === "partial-read" && observed === 0n))
            throw new TypeError("QEMU shutdown diagnostic bytes is invalid");
        exactString(value.sha256, SHA256_PATTERN, "QEMU shutdown diagnostic sha256");
        return deepFreeze(structuredClone(value));
    }
    assertKeys(value, ["reason", "schemaVersion", "status"], "QEMU shutdown diagnostic");
    if (!SHUTDOWN_UNAVAILABLE_REASONS.includes(value.reason))
        throw new TypeError("QEMU shutdown diagnostic is invalid");
    return deepFreeze(structuredClone(value));
}

export function validatePredeadlineFrameDiagnostic(value, expectedRoot) {
    if (value === null || typeof value !== "object" || Array.isArray(value))
        throw new TypeError("QEMU predeadline frame diagnostic is invalid");
    if (!PREDEADLINE_FRAME_STATUSES.includes(value.status))
        throw new TypeError("QEMU predeadline frame diagnostic is invalid");
    if (value.schemaVersion !== SCHEMA_VERSION)
        throw new TypeError("QEMU predeadline frame diagnostic is invalid");

    if (value.status === "captured") {
        assertKeys(value, ["offsetMs", "schemaVersion", "screenshot", "status"], "QEMU predeadline frame diagnostic");
        if (!Number.isSafeInteger(value.offsetMs) || value.offsetMs < 0)
            throw new TypeError("QEMU predeadline frame diagnostic offset is invalid");
        assertKeys(value.screenshot, ["bytes", "bytesBase64", "path", "sha256"], "QEMU predeadline frame screenshot");
        if (expectedRoot !== undefined && value.screenshot.path !== `${expectedRoot}/predeadline-frame.png`)
            throw new TypeError("QEMU predeadline frame screenshot path is invalid");
        const byteCount = decimal(value.screenshot.bytes, "QEMU predeadline frame screenshot bytes", {positive: true});
        if (byteCount > BigInt(MAX_PREDEADLINE_FRAME_BYTES))
            throw new TypeError("QEMU predeadline frame screenshot bytes is invalid");
        exactString(value.screenshot.sha256, SHA256_PATTERN, "QEMU predeadline frame screenshot hash");
        if (typeof value.screenshot.bytesBase64 !== "string" ||
            value.screenshot.bytesBase64.length > MAX_PREDEADLINE_FRAME_BASE64_CHARACTERS ||
            !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value.screenshot.bytesBase64))
            throw new TypeError("QEMU predeadline frame screenshot is invalid");
        const bytes = Buffer.from(value.screenshot.bytesBase64, "base64");
        if (bytes.length !== Number(byteCount) || !bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE) ||
            crypto.createHash("sha256").update(bytes).digest("hex") !== value.screenshot.sha256)
            throw new TypeError("QEMU predeadline frame screenshot content is invalid");
        return deepFreeze(structuredClone(value));
    }
    if (value.status === "skipped") {
        assertKeys(value, ["reason", "schemaVersion", "status"], "QEMU predeadline frame diagnostic");
        if (!PREDEADLINE_FRAME_SKIPPED_REASONS.includes(value.reason))
            throw new TypeError("QEMU predeadline frame diagnostic is invalid");
        return deepFreeze(structuredClone(value));
    }
    if (value.status === "unavailable") {
        const allowedKeys = ["reason", "schemaVersion", "status"];
        if (Object.hasOwn(value, "offsetMs")) allowedKeys.push("offsetMs");
        assertKeys(value, allowedKeys, "QEMU predeadline frame diagnostic");
        if (!PREDEADLINE_FRAME_UNAVAILABLE_REASONS.includes(value.reason))
            throw new TypeError("QEMU predeadline frame diagnostic is invalid");
        if (value.offsetMs !== undefined && (!Number.isSafeInteger(value.offsetMs) || value.offsetMs < 0))
            throw new TypeError("QEMU predeadline frame diagnostic offset is invalid");
        return deepFreeze(structuredClone(value));
    }
    assertKeys(value, ["bytes", "reason", "schemaVersion", "sha256", "status"], "QEMU predeadline frame diagnostic");
    if (!PREDEADLINE_FRAME_MALFORMED_REASONS.includes(value.reason))
        throw new TypeError("QEMU predeadline frame diagnostic is invalid");
    const parsedBytes = decimal(value.bytes, "QEMU predeadline frame diagnostic bytes");
    if (parsedBytes > BigInt(MAX_PREDEADLINE_FRAME_BYTES))
        throw new TypeError("QEMU predeadline frame diagnostic bytes is invalid");
    exactString(value.sha256, SHA256_PATTERN, "QEMU predeadline frame diagnostic sha256");
    return deepFreeze(structuredClone(value));
}

function validateMidWindowFrameEntry(value, index, expectedRoot) {
    if (value === null || typeof value !== "object" || Array.isArray(value))
        throw new TypeError("QEMU mid-window frame diagnostic is invalid");
    if (!MID_WINDOW_FRAME_STATUSES.includes(value.status))
        throw new TypeError("QEMU mid-window frame diagnostic is invalid");
    if (value.schemaVersion !== SCHEMA_VERSION)
        throw new TypeError("QEMU mid-window frame diagnostic is invalid");
    if (value.nominalOffsetMs !== MID_WINDOW_SAMPLE_OFFSETS_MILLISECONDS[index])
        throw new TypeError("QEMU mid-window frame diagnostic offset is invalid");
    const expectedFilename = MID_WINDOW_FRAME_FILENAMES[index];

    if (value.status === "captured") {
        assertKeys(value, ["nominalOffsetMs", "offsetMs", "schemaVersion", "screenshot", "status"],
            "QEMU mid-window frame diagnostic");
        if (!Number.isSafeInteger(value.offsetMs) || value.offsetMs < 0)
            throw new TypeError("QEMU mid-window frame diagnostic offset is invalid");
        assertKeys(value.screenshot, ["bytes", "bytesBase64", "path", "sha256"], "QEMU mid-window frame screenshot");
        if (expectedRoot !== undefined && value.screenshot.path !== `${expectedRoot}/${expectedFilename}`)
            throw new TypeError("QEMU mid-window frame screenshot path is invalid");
        const byteCount = decimal(value.screenshot.bytes, "QEMU mid-window frame screenshot bytes", {positive: true});
        if (byteCount > BigInt(MAX_MID_WINDOW_FRAME_BYTES))
            throw new TypeError("QEMU mid-window frame screenshot bytes is invalid");
        exactString(value.screenshot.sha256, SHA256_PATTERN, "QEMU mid-window frame screenshot hash");
        if (typeof value.screenshot.bytesBase64 !== "string" ||
            value.screenshot.bytesBase64.length > MAX_MID_WINDOW_FRAME_BASE64_CHARACTERS ||
            !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value.screenshot.bytesBase64))
            throw new TypeError("QEMU mid-window frame screenshot is invalid");
        const bytes = Buffer.from(value.screenshot.bytesBase64, "base64");
        if (bytes.length !== Number(byteCount) || !bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE) ||
            crypto.createHash("sha256").update(bytes).digest("hex") !== value.screenshot.sha256)
            throw new TypeError("QEMU mid-window frame screenshot content is invalid");
        return structuredClone(value);
    }
    if (value.status === "skipped") {
        assertKeys(value, ["nominalOffsetMs", "reason", "schemaVersion", "status"], "QEMU mid-window frame diagnostic");
        if (!MID_WINDOW_FRAME_SKIPPED_REASONS.includes(value.reason))
            throw new TypeError("QEMU mid-window frame diagnostic is invalid");
        return structuredClone(value);
    }
    if (value.status === "unavailable") {
        const allowedKeys = ["nominalOffsetMs", "reason", "schemaVersion", "status"];
        if (Object.hasOwn(value, "offsetMs")) allowedKeys.push("offsetMs");
        assertKeys(value, allowedKeys, "QEMU mid-window frame diagnostic");
        if (!MID_WINDOW_FRAME_UNAVAILABLE_REASONS.includes(value.reason))
            throw new TypeError("QEMU mid-window frame diagnostic is invalid");
        if (value.offsetMs !== undefined && (!Number.isSafeInteger(value.offsetMs) || value.offsetMs < 0))
            throw new TypeError("QEMU mid-window frame diagnostic offset is invalid");
        return structuredClone(value);
    }
    assertKeys(value, ["bytes", "nominalOffsetMs", "reason", "schemaVersion", "sha256", "status"],
        "QEMU mid-window frame diagnostic");
    if (!MID_WINDOW_FRAME_MALFORMED_REASONS.includes(value.reason))
        throw new TypeError("QEMU mid-window frame diagnostic is invalid");
    const parsedBytes = decimal(value.bytes, "QEMU mid-window frame diagnostic bytes");
    if (parsedBytes > BigInt(MAX_MID_WINDOW_FRAME_BYTES))
        throw new TypeError("QEMU mid-window frame diagnostic bytes is invalid");
    exactString(value.sha256, SHA256_PATTERN, "QEMU mid-window frame diagnostic sha256");
    return structuredClone(value);
}

export function validateMidWindowFramesDiagnostic(value, expectedRoot) {
    if (!Array.isArray(value) || value.length !== MID_WINDOW_SAMPLE_OFFSETS_MILLISECONDS.length)
        throw new TypeError("QEMU mid-window frames diagnostic is invalid");
    return deepFreeze(value.map((entry, index) => validateMidWindowFrameEntry(entry, index, expectedRoot)));
}

/*
 * The one continuous-pump capture this stage retains: at most one validated `SHUTDOWN` event, present
 * only when the pump actually observed one and always attached beside an existing failure diagnostic.
 * Absence means the field is omitted entirely - never a synthetic "absent"/"unavailable" status - so
 * every historical failure diagnostic retained before this capture existed still replays unchanged.
 */
export function validateQmpShutdownEventDiagnostic(value) {
    assertKeys(value, ["guest", "offsetMs", "reason", "schemaVersion", "status"], "QMP shutdown event diagnostic");
    if (value.schemaVersion !== SCHEMA_VERSION || value.status !== "captured" ||
        typeof value.guest !== "boolean" || typeof value.reason !== "string" ||
        !QMP_SHUTDOWN_CAUSES.includes(value.reason) ||
        !Number.isSafeInteger(value.offsetMs) || value.offsetMs < 0)
        throw new TypeError("QMP shutdown event diagnostic is invalid");
    return deepFreeze(structuredClone(value));
}

export function validateQemuLaunchDiagnostic(value, process, expectedNonce) {
    /*
     * New serial records carry a bounded prefix and explicit status; an empty prefix proves only
     * that no text was captured. The field stays optional so records retained before capture existed
     * still replay, and it is read only after launch has already failed.
     */
    const diagnosticKeys = ["kind", "monitorFailure", "process", "processFlags", "schemaVersion", "stderr"];
    if (Object.hasOwn(value ?? {}, "serialLog")) diagnosticKeys.push("serialLog");
    if (Object.hasOwn(value ?? {}, "receipt")) diagnosticKeys.push("receipt");
    if (Object.hasOwn(value ?? {}, "predeadlineFrame")) diagnosticKeys.push("predeadlineFrame");
    if (Object.hasOwn(value ?? {}, "midWindowFrames")) diagnosticKeys.push("midWindowFrames");
    if (Object.hasOwn(value ?? {}, "shutdown")) diagnosticKeys.push("shutdown");
    if (Object.hasOwn(value ?? {}, "qmpShutdownEvent")) diagnosticKeys.push("qmpShutdownEvent");
    assertKeys(value, diagnosticKeys, "QEMU failure diagnostic");
    if (value.schemaVersion !== SCHEMA_VERSION || value.kind !== "qemu-launch-failure-diagnostic" ||
        !same(value.process, process)) throw new TypeError("QEMU failure diagnostic identity is invalid");
    assertKeys(value.processFlags, ["errorObserved", "stderrOverflow", "stdoutOverflow"], "QEMU process flags");
    if (!Object.values(value.processFlags).every(item => typeof item === "boolean"))
        throw new TypeError("QEMU process flags are invalid");
    if (value.monitorFailure !== null) {
        assertKeys(value.monitorFailure, ["identity", "message", "phase"], "QEMU monitor failure");
        if (value.monitorFailure.phase !== "identity-observation" ||
            typeof value.monitorFailure.message !== "string" ||
            !/^[\x20-\x7e]{1,512}$/u.test(value.monitorFailure.message))
            throw new TypeError("QEMU monitor failure is invalid");
        const identity = value.monitorFailure.identity;
        assertKeys(identity, ["expected", "observed", "pid"], "QEMU monitor identity");
        assertKeys(identity.expected, ["executablePath", "processGroupId"], "QEMU expected monitor identity");
        const validPid = candidate => candidate === null || Number.isInteger(candidate) && candidate > 0 &&
            candidate <= 0x7fff_ffff;
        if (!validPid(identity.pid) || !validPid(identity.expected.processGroupId) ||
            typeof identity.expected.executablePath !== "string" ||
            !/^\/[\x20-\x7e]{1,511}$/u.test(identity.expected.executablePath))
            throw new TypeError("QEMU expected monitor identity is invalid");
        if (identity.observed !== null) {
            if (identity.observed.state === "absent") assertKeys(identity.observed, ["state"], "QEMU observed identity");
            else {
                assertKeys(identity.observed, ["executablePath", "pid", "processGroupId", "startTicks", "state"],
                    "QEMU observed identity");
                if (identity.observed.state !== "present" || !validPid(identity.observed.pid) ||
                    !validPid(identity.observed.processGroupId) ||
                    (identity.observed.startTicks !== null &&
                        !/^[1-9][0-9]{0,23}$/u.test(identity.observed.startTicks)) ||
                    (identity.observed.executablePath !== null &&
                        !/^\/[\x20-\x7e]{1,511}$/u.test(identity.observed.executablePath)))
                    throw new TypeError("QEMU observed identity is invalid");
            }
        }
    }
    validateDiagnosticStream(value.stderr, "stderr");
    if (value.serialLog !== undefined) validateSerialDiagnostic(value.serialLog);
    if (value.receipt !== undefined) validateReceiptDiagnostic(value.receipt, expectedNonce);
    if (value.predeadlineFrame !== undefined)
        validatePredeadlineFrameDiagnostic(value.predeadlineFrame, expectedNonce ? `/home/runner/work/_temp/myspeed-windows-cpu-floor-${expectedNonce}` : undefined);
    if (value.midWindowFrames !== undefined)
        validateMidWindowFramesDiagnostic(value.midWindowFrames, expectedNonce ? `/home/runner/work/_temp/myspeed-windows-cpu-floor-${expectedNonce}` : undefined);
    if (value.shutdown !== undefined) validateShutdownDiagnostic(value.shutdown, expectedNonce);
    if (value.qmpShutdownEvent !== undefined) validateQmpShutdownEventDiagnostic(value.qmpShutdownEvent);
    return deepFreeze(structuredClone(value));
}

export function validateEarlyBoot(value, pathsValue, bootConfirmation) {
    assertKeys(value, ["inputSent", "kind", "running", "schemaVersion", "screenshots", "status", "version"],
        "QEMU early-boot observation");
    if (value.schemaVersion !== SCHEMA_VERSION || value.kind !== "qemu-early-boot-observation" ||
        value.running !== true || value.status !== "running")
        throw new TypeError("QEMU early-boot observation is invalid");
    validateInstallerBootInput(value.inputSent, bootConfirmation);
    assertKeys(value.version, ["major", "micro", "minor"], "QEMU early-boot version");
    if (!Object.values(value.version).every(item => Number.isSafeInteger(item) && item >= 0))
        throw new TypeError("QEMU early-boot version is invalid");
    if (!Array.isArray(value.screenshots) || value.screenshots.length !== 2)
        throw new TypeError("QEMU early-boot screenshots are invalid");
    for (const [index, screenshot] of value.screenshots.entries()) {
        assertKeys(screenshot, ["bytes", "bytesBase64", "path", "sha256"], "QEMU early-boot screenshot");
        const expectedPath = `${pathsValue.root}/early-boot-${index + 1}.png`;
        const byteCount = decimal(screenshot.bytes, "QEMU early-boot screenshot bytes", {positive: true});
        exactString(screenshot.sha256, SHA256_PATTERN, "QEMU early-boot screenshot hash");
        if (screenshot.path !== expectedPath || byteCount > BigInt(MAX_EARLY_BOOT_SCREENSHOT_BYTES) ||
            typeof screenshot.bytesBase64 !== "string" ||
            screenshot.bytesBase64.length > MAX_EARLY_BOOT_SCREENSHOT_BASE64_CHARACTERS ||
            !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(screenshot.bytesBase64))
            throw new TypeError("QEMU early-boot screenshot is invalid");
        const bytes = Buffer.from(screenshot.bytesBase64, "base64");
        if (bytes.length !== Number(byteCount) || !bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE) ||
            sha256(bytes) !== screenshot.sha256) throw new TypeError("QEMU early-boot screenshot identity differs");
    }
    return deepFreeze(structuredClone(value));
}

export function validateLateBoot(value, pathsValue) {
    /*
     * displayAdvanced is advisory and optional: it says only that the sampled frames did or did not
     * differ, never that the guest made no progress between or after them, and nothing gates on it.
     * Admitting its absence keeps failure records retained before the field existed replayable.
     */
    const lateBootKeys = ["kind", "milestones", "schemaVersion"];
    if (Object.hasOwn(value ?? {}, "displayAdvanced")) lateBootKeys.push("displayAdvanced");
    assertKeys(value, lateBootKeys, "QEMU late-boot observation");
    if (value.schemaVersion !== SCHEMA_VERSION || value.kind !== "qemu-late-boot-observation" ||
        (value.displayAdvanced !== undefined && value.displayAdvanced !== null &&
            typeof value.displayAdvanced !== "boolean") ||
        !Array.isArray(value.milestones) || value.milestones.length < 1 ||
        value.milestones.length > MAX_LATE_BOOT_MILESTONES)
        throw new TypeError("QEMU late-boot observation is invalid");
    for (const [index, item] of value.milestones.entries()) {
        assertKeys(item, ["milestone", "offsetMs", "running", "screenshot", "status"], "QEMU late-boot milestone");
        const expectedMilestone = index + 1;
        const expectedOffset = LATE_BOOT_OFFSETS[index];
        if (item.milestone !== expectedMilestone || item.offsetMs !== expectedOffset ||
            typeof item.running !== "boolean" || typeof item.status !== "string" || item.status.length < 1)
            throw new TypeError("QEMU late-boot milestone is invalid");
        assertKeys(item.screenshot, ["bytes", "bytesBase64", "path", "sha256"], "QEMU late-boot screenshot");
        const expectedPath = `${pathsValue.root}/late-boot-${expectedMilestone}.png`;
        const byteCount = decimal(item.screenshot.bytes, "QEMU late-boot screenshot bytes", {positive: true});
        exactString(item.screenshot.sha256, SHA256_PATTERN, "QEMU late-boot screenshot hash");
        if (item.screenshot.path !== expectedPath || byteCount > BigInt(MAX_LATE_BOOT_SCREENSHOT_BYTES) ||
            typeof item.screenshot.bytesBase64 !== "string" ||
            item.screenshot.bytesBase64.length > MAX_LATE_BOOT_SCREENSHOT_BASE64_CHARACTERS ||
            !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(item.screenshot.bytesBase64))
            throw new TypeError("QEMU late-boot screenshot is invalid");
        const bytes = Buffer.from(item.screenshot.bytesBase64, "base64");
        if (bytes.length !== Number(byteCount) || !bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE) ||
            sha256(bytes) !== item.screenshot.sha256) throw new TypeError("QEMU late-boot screenshot identity differs");
    }
    return deepFreeze(structuredClone(value));
}

export async function runWindowsCpuFloorStage2({context, admission, paths: inputPaths, probeArtifact,
    bootConfirmation, winpeDiagnostic, admitWinpeDiagnostic, midWindowFrames}, operations) {
    /*
     * Malformed values are refused here rather than silently treated as disabled: a caller that
     * passes a truthy non-`true` value (a string, a `1`) almost certainly meant to opt in and would
     * otherwise get silent, unexplained no-op behavior. Absence alone means disabled.
     */
    if (midWindowFrames !== undefined && midWindowFrames !== true)
        throw new TypeError("Stage 2 mid-window frames flag is invalid");
    validateInstallerBootConfirmation(bootConfirmation);
    const diagnosticAuthorization = validateWinpeDiagnosticAuthorization(winpeDiagnostic);
    if (diagnosticAuthorization !== undefined && (diagnosticAuthorization.nonce !== context.nonce ||
        typeof admitWinpeDiagnostic !== "function"))
        throw new TypeError("WinPE diagnostic authorization is not bound to this run");
    if (midWindowFrames === true && diagnosticAuthorization !== undefined)
        throw new TypeError("Stage 2 mid-window frames cannot combine with a WinPE diagnostic authorization");
    /*
     * One extra argument that reaches every validly authorized exit, so a diagnostic run can never
     * fall back to the calibration classification on any path - including the admission refusal
     * below, which happens before the try block.
     */
    const diagnosticExit = diagnosticAuthorization === undefined ? null :
        {classification: WINPE_DIAGNOSTIC_CLASSIFICATION};
    const required = ["acquirePackages", "acquireProbeClosure", "acquireWindowsIso", "extractInstallWim", "extractPortableTools",
        "inspectInstallWim", "launchOwnedQemu", "prepareOfflineMedia", "resolveSignedPackageClosure"];
    if (!operations || typeof operations !== "object" || required.some(name => typeof operations[name] !== "function"))
        throw new TypeError("Stage 2 operations are incomplete");
    const checkedPaths = validatePaths(inputPaths, context);
    try { validateAdmission(admission, context); }
    catch (error) { return failure(context, "admission", error, true, diagnosticExit); }
    const privilegeMode = selectPrivilegeMode(admission);
    let stage = "package-closure";
    let launchObservation = null;
    try {
        const packageClosure = validatePackageClosure(await operations.resolveSignedPackageClosure({context,
            snapshot: STAGE2_PROVENANCE.ubuntuSnapshot, roots: PACKAGE_ROOTS, paths: checkedPaths}));
        stage = "package-acquisition";
        const acquisition = validatePackageAcquisition(await operations.acquirePackages({context, packageClosure,
            paths: checkedPaths}), packageClosure, checkedPaths);
        stage = "toolchain";
        const toolchain = validateToolchain(await operations.extractPortableTools({context, packageClosure,
            acquisition, paths: checkedPaths, privilegeMode}), checkedPaths.portableRoot);
        if (toolchain.packageClosureSha256 !== canonicalSha256(packageClosure))
            throw new Error("portable toolchain package closure binding is invalid");
        stage = "probe-artifact";
        const checkedProbeArtifact = validateProbeArtifact(probeArtifact, context);
        const probes = validateAcquiredProbes(await operations.acquireProbeClosure({context,
            probeArtifact: checkedProbeArtifact, paths: checkedPaths}), checkedProbeArtifact, checkedPaths);
        stage = "iso";
        const iso = validateIso(await operations.acquireWindowsIso({context,
            provenance: STAGE2_PROVENANCE.windowsIso, paths: checkedPaths}));
        stage = "wim-extraction";
        const installWim = validateInstallWim(await operations.extractInstallWim({context, iso,
            paths: checkedPaths, toolchain}), checkedPaths, iso);
        stage = "wim-inspection";
        const wimInspection = await operations.inspectInstallWim({context, installWim, paths: checkedPaths, toolchain});
        assertKeys(wimInspection, ["images", "removal"], "WIM inspection observation");
        assertKeys(wimInspection.removal, ["path", "removed", "sha256"], "WIM removal observation");
        if (wimInspection.removal.path !== installWim.path || wimInspection.removal.sha256 !== installWim.sha256 ||
            wimInspection.removal.removed !== true) throw new TypeError("install WIM removal proof is invalid");
        const selectedImage = selectWindowsImage(wimInspection.images);
        stage = "offline-media";
        const activation = buildPostSetupActivation(context);
        const seedSpec = buildSeedSpec(selectedImage, context, probes, activation, diagnosticAuthorization);
        const media = validatePreparedMedia(await operations.prepareOfflineMedia({context, paths: checkedPaths,
            toolchain, probes, selectedImage, seedSpec, transfer: STAGE2_PROVENANCE.transfer,
            ...(diagnosticAuthorization === undefined ? {} : {winpeDiagnostic: diagnosticAuthorization})}),
        checkedPaths, seedSpec, toolchain);
        const argv = buildQemuArguments({paths: checkedPaths, toolchain});
        stage = "qemu-launch";
        /*
         * A diagnostic run is launched on its own reservation, never on the CPU diagnostic's fixed
         * 25/5 deadlines: it needs a far shorter guest allowance, and the launcher already refuses
         * to accept both at once. The reservation is taken here, after the downloads and the media
         * preparation this run has already paid for, so their cost is charged to it. If the guest
         * allowance no longer fits, this throws and nothing is launched.
         */
        const admitted = diagnosticAuthorization === undefined ? null : admitWinpeDiagnostic();
        launchObservation = await operations.launchOwnedQemu({context, paths: checkedPaths, toolchain, media, probes,
            argv, selectedImage, privilegeMode,
            ...(diagnosticAuthorization === undefined ? {deadlines: STAGE2_DIAGNOSTIC_DEADLINES,
                ...(midWindowFrames === true ? {midWindowFrames: true} : {})} :
                {winpeDiagnostic: diagnosticAuthorization, reservation: admitted.reservation,
                    winpeDiagnosticCollectionDeadlineMilliseconds: admitted.collectionDeadlineMilliseconds}),
            ...(bootConfirmation === undefined ? {} : {bootConfirmation})});
        if (diagnosticAuthorization !== undefined)
            return winpeDiagnosticResult(context, checkedPaths, launchObservation, diagnosticAuthorization,
                bootConfirmation);
        const allowedObservationKeys = ["argv", "earlyBoot", "process"];
        if (launchObservation?.guest !== undefined) allowedObservationKeys.push("guest");
        if (launchObservation?.guestFailure !== undefined) allowedObservationKeys.push("guestFailure");
        if (!allowedObservationKeys.includes("guest") && !allowedObservationKeys.includes("guestFailure")) {
            allowedObservationKeys.push("guest");
        }
        if (launchObservation?.failureDiagnostic !== undefined) allowedObservationKeys.push("failureDiagnostic");
        if (launchObservation?.lateBoot !== undefined) allowedObservationKeys.push("lateBoot");
        assertKeys(launchObservation, allowedObservationKeys, "QEMU observation");
        if (!same(launchObservation.argv, argv)) throw new TypeError("QEMU observed argv mismatch");
        const earlyBoot = launchObservation.earlyBoot === null ? null : validateEarlyBoot(launchObservation.earlyBoot,
            checkedPaths, bootConfirmation);
        const lateBoot = launchObservation.lateBoot ? validateLateBoot(launchObservation.lateBoot, checkedPaths) : null;
        let guestFailure = null;
        if (launchObservation.guestFailure) {
            guestFailure = validateGuestFailure(launchObservation.guestFailure, context.nonce);
        } else if (launchObservation.guest?.status === "failed") {
            guestFailure = validateGuestFailure(launchObservation.guest, context.nonce);
        }
        assertKeys(launchObservation.process, ["cleanupProven", "exitCode", "launcherExecutablePath", "processGroupId",
            "qemuPid", "qemuPidAbsentAfter", "qemuStartTicks", "signal", "terminationReason", "timedOut", "treeGone"],
            "QEMU process observation");
        if (launchObservation.process.exitCode !== 0 || launchObservation.process.signal !== null ||
            launchObservation.process.timedOut !== false || launchObservation.process.cleanupProven !== true ||
            launchObservation.process.treeGone !== true || !Number.isInteger(launchObservation.process.qemuPid) ||
            launchObservation.process.qemuPid < 1 || launchObservation.process.qemuPid > 0x7fff_ffff ||
            !Number.isInteger(launchObservation.process.processGroupId) || launchObservation.process.processGroupId < 1 ||
            launchObservation.process.processGroupId > 0x7fff_ffff ||
            !/^[1-9][0-9]{0,23}$/u.test(launchObservation.process.qemuStartTicks) ||
            launchObservation.process.launcherExecutablePath !== toolchain.runtime.loader.path ||
            launchObservation.process.terminationReason !== null ||
            launchObservation.process.qemuPidAbsentAfter !== true)
            throw new QemuLaunchError(validateQemuLaunchDiagnostic(launchObservation.failureDiagnostic,
                launchObservation.process, context.nonce), earlyBoot, guestFailure, lateBoot);
        if (earlyBoot === null) throw new QemuLaunchError(validateQemuLaunchDiagnostic(
            launchObservation.failureDiagnostic, launchObservation.process, context.nonce),
        earlyBoot, guestFailure, lateBoot);
        if (guestFailure !== null) {
            throw new GuestBootstrapError(guestFailure, earlyBoot, lateBoot);
        }
        const guest = validateGuest(launchObservation.guest, checkedPaths, context.nonce, activation);
        return deepFreeze({schemaVersion: SCHEMA_VERSION, status: "observed", stage: "complete",
            classification: CLASSIFICATION, qualifying: false, releaseGateCleared: false,
            cpuCalibrationAccepted: true, cleanupProven: true, privilegeMode, context: structuredClone(context),
            packageClosure, probeArtifact: checkedProbeArtifact, probes, iso, installWim,
            installWimRemoval: structuredClone(wimInspection.removal), selectedImage, toolchain,
            media, argv, qemuProcess: structuredClone(launchObservation.process), earlyBoot, guest,
            ...(bootConfirmation === undefined ? {} : {bootConfirmation})});
    } catch (error) {
        const cleanup = stage === "qemu-launch" && launchObservation?.process?.cleanupProven === true &&
            launchObservation?.process?.treeGone === true;
        return failure(context, stage, error, cleanup, diagnosticExit);
    }
}
