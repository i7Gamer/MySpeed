import crypto from "node:crypto";
import path from "node:path";

import {validateHostedContext} from "./linux-kvm-capability.mjs";
import {STAGE2_LIMITS} from "./linux-windows-cpu-floor-admission.mjs";
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
const SEVEN_ZIP_LIBRARY_RELATIVE_PATH = "usr/lib/7zip";
const SEVEN_ZIP_RELATIVE_PATH = `${SEVEN_ZIP_LIBRARY_RELATIVE_PATH}/7z`;
const CLASSIFICATION = "github-hosted-windows-cpu-floor-stage2-calibration-nonqualifying";
const EXPECTED_IMAGE = Object.freeze({name: "Windows Server 2025 SERVERSTANDARD", architecture: "x64",
    editionId: "ServerStandardEval", installationType: "Server"});
const WIM_SELECTION_DIAGNOSTIC_KIND = "windows-server-2025-wim-selection-diagnostic";
export const STAGE2_DIAGNOSTIC_DEADLINES = Object.freeze({executionMinutes: 25, cleanupMinutes: 5});
const MAX_LATE_BOOT_SCREENSHOT_BYTES = 1_048_576;
const MAX_LATE_BOOT_SCREENSHOT_BASE64_CHARACTERS = Math.ceil(MAX_LATE_BOOT_SCREENSHOT_BYTES / 3) * 4;
const MAX_LATE_BOOT_MILESTONES = 2;
const LATE_BOOT_OFFSETS = Object.freeze([120_000, 300_000]);

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

const PROBE_ROLES = Object.freeze(["avx", "avx2", "cpuid", "illegal", "known-bad", "known-good", "popcnt",
    "sse42"]);

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
        "-drive", drive("osdisk", "qcow2", value.systemDisk), "-device", "ide-hd,drive=osdisk,bus=sata.1",
        "-drive", drive("install", "raw", value.windowsIso, true), "-device", "ide-cd,drive=install,bus=sata.2",
        "-drive", drive("seed", "raw", value.seedIso, true), "-device", "ide-cd,drive=seed,bus=sata.3",
        "-drive", drive("output", "raw", value.outputDisk), "-device", "ide-hd,drive=output,bus=sata.4",
        "-chardev", `file,id=serial0,path=${value.serialLog}`, "-device", "isa-serial,chardev=serial0",
        "-pidfile", value.qemuPid, "-boot", "once=d,order=c,strict=on"];
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

function renderAutounattend(image, nonce) {
    const password = `Myspeed-Eval-${nonce.slice(0, 16)}!aA1`;
    const xml = `<?xml version="1.0" encoding="utf-8"?>\r\n<unattend xmlns="urn:schemas-microsoft-com:unattend" ` +
        `xmlns:wcm="http://schemas.microsoft.com/WMIConfig/2002/State">\r\n` +
        `<settings pass="windowsPE"><component name="Microsoft-Windows-Setup" processorArchitecture="amd64" ` +
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
    const roles = PROBE_ROLES.map(role => `'${role}'`).join(",");
    const script = `param([switch]$LibraryMode)\r\n$ErrorActionPreference = 'Stop'\r\nSet-StrictMode -Version Latest\r\n` +
        `$EXPECTED_NONCE = '${nonce}'\r\n$MAX_STREAM_BYTES = 4096\r\n$EXPECTED_ILLEGAL_EXIT = 3221225501L\r\n` +
        `$PROBE_TIMEOUT_MILLISECONDS = ${GUEST_PROBE_TIMEOUT_MILLISECONDS}\r\n` +
        `$PROBE_CLEANUP_TIMEOUT_MILLISECONDS = ${GUEST_PROBE_CLEANUP_TIMEOUT_MILLISECONDS}\r\n` +
        `$MAX_FAILURE_MESSAGE_CHARACTERS = ${MAX_GUEST_FAILURE_MESSAGE_CHARACTERS}\r\n` +
        `$MAX_SYSTEM_TOOL_BYTES = ${MAX_SYSTEM_TOOL_BYTES}\r\n` +
        `$EXPECTED_SETUP_COMPLETE_BYTES = ${setupComplete.bytes}\r\n` +
        `$EXPECTED_SETUP_COMPLETE_SHA = '${setupComplete.sha256}'\r\n` +
        `$EXPECTED_DISPATCHER_BYTES = ${dispatcher.bytes}\r\n` +
        `$EXPECTED_DISPATCHER_SHA = '${dispatcher.sha256}'\r\n` +
        `function Get-MyspeedGuestFileSha([IO.Stream]$Stream) {\r\n` +
        `  $sha = [Security.Cryptography.SHA256]::Create()\r\n` +
        `  try { return ([BitConverter]::ToString($sha.ComputeHash($Stream))).Replace('-','').ToLowerInvariant() } ` +
        `finally { $sha.Dispose() }\r\n}\r\n` +
        `function New-MyspeedGuestNativeOperations {\r\n` +
        `  Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class ` +
        `MyspeedErrorMode { [DllImport("kernel32.dll")] public static extern uint SetErrorMode(uint mode); }'\r\n` +
        `  $probeTimeoutMilliseconds = $PROBE_TIMEOUT_MILLISECONDS\r\n` +
        `  $probeCleanupTimeoutMilliseconds = $PROBE_CLEANUP_TIMEOUT_MILLISECONDS\r\n` +
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
        `    $root = Join-Path $env:SystemRoot 'Setup\\Scripts'\r\n` +
        `    $rootItem = Get-Item -LiteralPath $root -Force -ErrorAction Stop\r\n` +
        `    if ($rootItem -isnot [IO.DirectoryInfo] -or ` +
        `($rootItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { ` +
        `throw 'MSI activation target root differs' }\r\n` +
        `    $records = [ordered]@{}\r\n` +
        `    foreach ($expected in @(` +
        `[pscustomobject]@{key='setupComplete';name='SetupComplete.cmd';bytes=$expectedSetupCompleteBytes;` +
        `sha=$expectedSetupCompleteSha},` +
        `[pscustomobject]@{key='dispatcher';name='myspeed-msi-setupcomplete.ps1';` +
        `bytes=$expectedDispatcherBytes;sha=$expectedDispatcherSha})) {\r\n` +
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
        `        $records[$expected.key] = [ordered]@{path=$target;bytes=[int64]$expected.bytes;` +
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
        `    } finally {\r\n      & $Shutdown\r\n    }\r\n  }\r\n` +
        `  if ($null -ne $bootstrapFailure) { throw $bootstrapFailure }\r\n}\r\n` +
        `if (-not $LibraryMode) { Invoke-MyspeedGuestBootstrap }\r\n`;
    return Buffer.from(script, "utf8");
}

function buildSeedSpec(image, context, probes, activation) {
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
        ...probes.files.map(file => ({name: `${file.role}.exe`, kind: "owned-file", bytes: file.bytes, sha256: file.sha256,
            sourcePath: file.path}))
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
        value.stage !== "guest-bootstrap" || value.status !== "failed" ||
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

function failure(context, stage, error, cleanupProven = true) {
    const message = (error instanceof Error ? error.message : String(error)).replace(/[\x00-\x1f\x7f]+/g, " ")
        .slice(0, MAX_GUEST_FAILURE_MESSAGE_CHARACTERS);
    const diagnostic = stage === "wim-inspection" && error instanceof WimSelectionError ?
        {wimSelection: structuredClone(error.diagnostic)} : stage === "qemu-launch" && (error instanceof QemuLaunchError || error instanceof GuestBootstrapError) ?
            {
                ...(error instanceof QemuLaunchError ? {qemuLaunch: structuredClone(error.diagnostic)} : {}),
                ...(error.earlyBoot === null || error.earlyBoot === undefined ? {} :
                    {qemuEarlyBoot: structuredClone(error.earlyBoot)}),
                ...(error.guestFailure === null || error.guestFailure === undefined ? {} :
                    {guestFailure: structuredClone(error.guestFailure)})
            } : {};
    const baseResult = {schemaVersion: SCHEMA_VERSION, status: "failed", stage, classification: CLASSIFICATION,
        qualifying: false, releaseGateCleared: false, cpuCalibrationAccepted: false, cleanupProven,
        context: structuredClone(context), failure: message || "unspecified failure", ...diagnostic};
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

function validateQemuLaunchDiagnostic(value, process) {
    assertKeys(value, ["kind", "monitorFailure", "process", "processFlags", "schemaVersion", "stderr"],
        "QEMU failure diagnostic");
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
    assertKeys(value.stderr, ["bytes", "bytesBase64", "sha256"], "QEMU stderr diagnostic");
    const byteCount = decimal(value.stderr.bytes, "QEMU stderr bytes");
    exactString(value.stderr.sha256, SHA256_PATTERN, "QEMU stderr hash");
    if (byteCount > BigInt(MAX_QEMU_DIAGNOSTIC_STREAM_BYTES) || typeof value.stderr.bytesBase64 !== "string" ||
        value.stderr.bytesBase64.length > MAX_QEMU_DIAGNOSTIC_BASE64_CHARACTERS ||
        !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value.stderr.bytesBase64))
        throw new TypeError("QEMU stderr diagnostic is invalid");
    const bytes = Buffer.from(value.stderr.bytesBase64, "base64");
    if (bytes.length !== Number(byteCount) || sha256(bytes) !== value.stderr.sha256)
        throw new TypeError("QEMU stderr diagnostic identity differs");
    return deepFreeze(structuredClone(value));
}

export function validateEarlyBoot(value, pathsValue) {
    assertKeys(value, ["inputSent", "kind", "running", "schemaVersion", "screenshots", "status", "version"],
        "QEMU early-boot observation");
    if (value.schemaVersion !== SCHEMA_VERSION || value.kind !== "qemu-early-boot-observation" ||
        value.inputSent !== false || value.running !== true || value.status !== "running")
        throw new TypeError("QEMU early-boot observation is invalid");
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
    assertKeys(value, ["kind", "milestones", "schemaVersion"], "QEMU late-boot observation");
    if (value.schemaVersion !== SCHEMA_VERSION || value.kind !== "qemu-late-boot-observation" ||
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

export async function runWindowsCpuFloorStage2({context, admission, paths: inputPaths, probeArtifact}, operations) {
    const required = ["acquirePackages", "acquireProbeClosure", "acquireWindowsIso", "extractInstallWim", "extractPortableTools",
        "inspectInstallWim", "launchOwnedQemu", "prepareOfflineMedia", "resolveSignedPackageClosure"];
    if (!operations || typeof operations !== "object" || required.some(name => typeof operations[name] !== "function"))
        throw new TypeError("Stage 2 operations are incomplete");
    const checkedPaths = validatePaths(inputPaths, context);
    try { validateAdmission(admission, context); }
    catch (error) { return failure(context, "admission", error); }
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
        const seedSpec = buildSeedSpec(selectedImage, context, probes, activation);
        const media = validatePreparedMedia(await operations.prepareOfflineMedia({context, paths: checkedPaths,
            toolchain, probes, selectedImage, seedSpec, transfer: STAGE2_PROVENANCE.transfer}), checkedPaths,
        seedSpec, toolchain);
        const argv = buildQemuArguments({paths: checkedPaths, toolchain});
        stage = "qemu-launch";
        launchObservation = await operations.launchOwnedQemu({context, paths: checkedPaths, toolchain, media, probes,
            argv, selectedImage, privilegeMode, deadlines: STAGE2_DIAGNOSTIC_DEADLINES});
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
            checkedPaths);
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
                launchObservation.process), earlyBoot, guestFailure, lateBoot);
        if (earlyBoot === null) throw new QemuLaunchError(validateQemuLaunchDiagnostic(
            launchObservation.failureDiagnostic, launchObservation.process), earlyBoot, guestFailure, lateBoot);
        if (guestFailure !== null) {
            throw new GuestBootstrapError(guestFailure, earlyBoot, lateBoot);
        }
        const guest = validateGuest(launchObservation.guest, checkedPaths, context.nonce, activation);
        return deepFreeze({schemaVersion: SCHEMA_VERSION, status: "observed", stage: "complete",
            classification: CLASSIFICATION, qualifying: false, releaseGateCleared: false,
            cpuCalibrationAccepted: true, cleanupProven: true, privilegeMode, context: structuredClone(context),
            packageClosure, probeArtifact: checkedProbeArtifact, probes, iso, installWim,
            installWimRemoval: structuredClone(wimInspection.removal), selectedImage, toolchain,
            media, argv, qemuProcess: structuredClone(launchObservation.process), earlyBoot, guest});
    } catch (error) {
        const cleanup = stage === "qemu-launch" && launchObservation?.process?.cleanupProven === true &&
            launchObservation?.process?.treeGone === true;
        return failure(context, stage, error, cleanup);
    }
}
