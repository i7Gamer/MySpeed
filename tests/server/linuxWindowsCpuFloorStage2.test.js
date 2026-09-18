import assert from "node:assert/strict";
import {spawnSync} from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {describe, it} from "node:test";

import {
    EFI_SHELL_TRUNCATED_ATTRIBUTION,
    GuestBootstrapError,
    MAX_GUEST_FAILURE_MESSAGE_CHARACTERS,
    MAX_STAGE2_RESULT_BYTES,
    PACKAGE_ROOTS,
    QemuLaunchError,
    STAGE2_DIAGNOSTIC_DEADLINES,
    STAGE2_PROVENANCE,
    TOP_LEVEL_PACKAGE_PINS,
    attributeTruncatedSerialFailure,
    buildQemuArguments,
    renderGuestBootstrap,
    runWindowsCpuFloorStage2,
    validateEarlyBoot,
    validateGuestFailure,
    validateLateBoot,
    validatePackageClosure,
    selectWindowsImage
} from "../../scripts/qualification/linux-windows-cpu-floor-stage2.mjs";
import {STAGE2_LIMITS} from "../../scripts/qualification/linux-windows-cpu-floor-admission.mjs";
import {sealSameJobInstalledBase} from "../../scripts/qualification/windows-msi-installed-base.mjs";
import {createHostedStage2Operations} from
    "../../scripts/qualification/linux-windows-cpu-floor-stage2-hosted.mjs";
import {buildWindowsMsiSetupCompleteActivation, getCompletedWindowsMsiActivationEvidence} from
    "../../scripts/qualification/windows-msi-post-setup-activation.mjs";

const NONCE = "0123456789abcdef0123456789abcdef";
const HASH = value => crypto.createHash("sha256").update(value).digest("hex");
const FILE_HASH = "a".repeat(64);
const POWERSHELL_TEST_TIMEOUT_MILLISECONDS = 10_000;
const SYSTEM_TOOLS = [
    {role: "msiexec", path: "C:\\Windows\\System32\\msiexec.exe", bytes: "1024", sha256: "8".repeat(64)},
    {role: "sc", path: "C:\\Windows\\System32\\sc.exe", bytes: "2048", sha256: "9".repeat(64)},
    {role: "powershell", path: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
        bytes: "4096", sha256: "b".repeat(64)}
];
const EXPECTED_GUEST_PROBE_TIMEOUT_MILLISECONDS = 10_000;
const MAX_WIM_SELECTION_DIAGNOSTIC_BYTES = 131_072;
const MAX_QEMU_DIAGNOSTIC_STREAM_BYTES = 65_536;
const MAX_QEMU_DIAGNOSTIC_BASE64_CHARACTERS = Math.ceil(MAX_QEMU_DIAGNOSTIC_STREAM_BYTES / 3) * 4;
const TRUNCATED_SERIAL_PREFIX_BYTE = 0x73;
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
const BOOT_CONFIRMATION = "single-enter-before-setup-v1";
const bootInput = () => ({kind: "installer-boot-confirmation", qcode: "ret", holdMilliseconds: 100,
    requestedOffsetMilliseconds: 2000, sentOffsetMilliseconds: 2001, acknowledged: true});

function context() {
    return {schemaVersion: 1, repository: "i7Gamer/MySpeed", sourceSha: "b".repeat(40),
        eventSha: "c".repeat(40), runId: "123", runAttempt: "1", nonce: NONCE,
        environment: {GITHUB_ACTIONS: "true", CI: "true", RUNNER_OS: "Linux", RUNNER_ARCH: "X64",
            RUNNER_ENVIRONMENT: "github-hosted", ImageOS: "ubuntu24", ImageVersion: "20260907.1"}};
}

const activation = () => {
    const value = context();
    return buildWindowsMsiSetupCompleteActivation({repository: value.repository, sourceSha: value.sourceSha,
        eventSha: value.eventSha, runId: value.runId, runAttempt: value.runAttempt, nonce: value.nonce});
};
const activationReceipt = () => {
    return getCompletedWindowsMsiActivationEvidence(activation());
};

function admission() {
    return {schemaVersion: 1, status: "admitted", admitted: true,
        classification: "github-hosted-windows-cpu-floor-admission-nonqualifying",
        qualifying: false, releaseGateCleared: false, mediaAcquisitionAuthorized: false,
        qemuLaunchAuthorized: false, context: context(), kvm: {ordinary: {bytes: 1, sha256: FILE_HASH,
            capability: "permission-denied"}, combined: {bytes: 1, sha256: "d".repeat(64), capability: "usable",
            retryPerformed: true}}, budget: structuredClone(STAGE2_LIMITS), observations: {}, reasons: []};
}

function packageClosure() {
    const packages = TOP_LEVEL_PACKAGE_PINS.map(value => ({...value, dependsOn: []}));
    packages.push({name: "libfixture", version: "1.0", architecture: "amd64",
        filename: "pool/libfixture_1.0_amd64.deb", bytes: "2048", sha256: "f".repeat(64), dependsOn: []});
    packages[0].dependsOn = ["libfixture:amd64=1.0"];
    packages.sort((left, right) => `${left.name}:${left.architecture}=${left.version}`.localeCompare(
        `${right.name}:${right.architecture}=${right.version}`, "en"));
    return {schemaVersion: 1, snapshot: structuredClone(STAGE2_PROVENANCE.ubuntuSnapshot),
        indexes: [
            {suite: "noble", component: "main", architecture: "amd64", path: "dists/noble/main/binary-amd64/Packages.xz",
                bytes: "100", sha256: "1".repeat(64), listedSha256: "1".repeat(64),
                inReleaseSha256: "3".repeat(64)},
            {suite: "noble-updates", component: "main", architecture: "amd64",
                path: "dists/noble-updates/main/binary-amd64/Packages.xz", bytes: "101", sha256: "2".repeat(64),
                listedSha256: "2".repeat(64), inReleaseSha256: "4".repeat(64)}
        ], releases: [
            {suite: "noble", inReleasePath: "dists/noble/InRelease", bytes: "200", sha256: "3".repeat(64),
                signatureVerified: true, signerFingerprint: STAGE2_PROVENANCE.ubuntuArchiveSignerFingerprint},
            {suite: "noble-updates", inReleasePath: "dists/noble-updates/InRelease", bytes: "201",
                sha256: "4".repeat(64), signatureVerified: true,
                signerFingerprint: STAGE2_PROVENANCE.ubuntuArchiveSignerFingerprint}
        ],
        roots: [...PACKAGE_ROOTS], packages};
}

function imageInventory() {
    return [{index: 1, name: "Windows Server 2025 Standard Evaluation", architecture: "x64",
        editionId: "ServerStandardEval", installationType: "Server Core", totalBytes: "15000000000"},
    {index: 2, name: "Windows Server 2025 SERVERSTANDARD", architecture: "x64",
        editionId: "ServerStandardEval", installationType: "Server", totalBytes: "24699866265"}];
}

function paths() {
    const root = `/home/runner/work/_temp/myspeed-windows-cpu-floor-${NONCE}`;
    return {root, packageRoot: `${root}/packages`,
        portableRoot: `/tmp/myspeed-windows-cpu-floor-tools-${NONCE}`, windowsIso: `${root}/windows.iso`,
        installWim: `${root}/install.wim`, seedIso: `${root}/seed.iso`, outputDisk: `${root}/output.img`,
        systemDisk: `${root}/system.qcow2`, ovmfVars: `${root}/OVMF_VARS.fd`, serialLog: `${root}/serial.log`,
        probeRoot: `${root}/probes`, qemuPid: `${root}/qemu.pid`};
}

const PROBE_ROLES = ["avx", "avx2", "cpuid", "illegal", "known-bad", "known-good", "popcnt", "sse42"];

function probeArtifact() {
    return {schemaVersion: 1, repository: "i7Gamer/MySpeed", sourceSha: "9".repeat(40), runId: "34763667695",
        runAttempt: "1", artifactId: "1234567890", artifactName: "windows-cpu-readiness-evidence",
        archive: {bytes: "33554432", sha256: "a".repeat(64)},
        innerManifest: {name: "result.json", bytes: "262144", sha256: "b".repeat(64)},
        files: PROBE_ROLES.map((role, index) => ({role, name: `${role.replaceAll("-", "_")}.exe`, bytes: `${4096 + index}`,
            sha256: `${index + 1}`.repeat(64).slice(0, 64)}))};
}

function toolchain() {
    const portable = paths().portableRoot;
    const ownership = {uid: "0", gid: "0", mode: "555", ordinaryUserWritable: false};
    return {qemu: {path: `${portable}/usr/bin/qemu-system-x86_64`,
        invocationPath: `${portable}/usr/bin/qemu-system-x86_64`, bytes: "4096", sha256: FILE_HASH, ownership,
        version: "QEMU emulator version 8.2.2 (Debian 1:8.2.2+ds-0ubuntu1.18)"},
    qemuImg: {path: `${portable}/usr/bin/qemu-img`, invocationPath: `${portable}/usr/bin/qemu-img`, bytes: "4096",
        sha256: "b".repeat(64), ownership},
    genisoimage: {path: `${portable}/usr/bin/genisoimage`, invocationPath: `${portable}/usr/bin/genisoimage`,
        bytes: "4096", sha256: "c".repeat(64), ownership},
    mcopy: {path: `${portable}/usr/bin/mcopy`, invocationPath: `${portable}/usr/bin/mcopy`, bytes: "4096",
        sha256: "d".repeat(64), ownership},
    mformat: {path: `${portable}/usr/bin/mformat`, invocationPath: `${portable}/usr/bin/mformat`, bytes: "4096",
        sha256: "9".repeat(64), ownership},
    sevenZip: {path: `${portable}/usr/lib/7zip/7z`, invocationPath: `${portable}/usr/lib/7zip/7z`, bytes: "4096",
        sha256: "e".repeat(64), ownership},
    wiminfo: {path: `${portable}/usr/bin/wiminfo`, invocationPath: `${portable}/usr/bin/wiminfo`, bytes: "4096",
        sha256: "f".repeat(64), ownership},
    ovmfCode: {path: `${portable}/usr/share/OVMF/OVMF_CODE_4M.fd`, bytes: "4096", sha256: "1".repeat(64), ownership},
    ovmfVarsTemplate: {path: `${portable}/usr/share/OVMF/OVMF_VARS_4M.fd`, bytes: "4096", sha256: "2".repeat(64), ownership},
    firmware: {searchPath: `${portable}/usr/share/qemu`,
        kvmvapic: {path: `${portable}/usr/share/qemu/kvmvapic.bin`, bytes: "4096",
            sha256: "3".repeat(64), ownership},
        vga: {path: `${portable}/usr/share/seabios/vgabios-stdvga.bin`, bytes: "4096",
            sha256: "5".repeat(64), ownership}},
    runtime: {loader: {path: `${portable}/usr/lib/x86_64-linux-gnu/ld-linux-x86-64.so.2`,
        bytes: "4096", sha256: "4".repeat(64), ownership}, libraryPath: [`${portable}/usr/lib/x86_64-linux-gnu`,
        `${portable}/usr/lib/7zip`]},
    packageClosureSha256: HASH(Buffer.from(JSON.stringify(validatePackageClosure(packageClosure())))),
    installedFilesManifest: {bytes: "10000", sha256: "6".repeat(64)},
    licensesManifest: {bytes: "2000", sha256: "7".repeat(64)},
    capabilities: {cpuModels: ["Westmere-v2"], machines: ["q35"], devices: ["ich9-ahci", "ide-cd", "ide-hd",
        "isa-serial", "VGA", "qemu-xhci", "usb-kbd"], accelerator: "kvm"}};
}

function guestEvidence() {
    return {schemaVersion: 1, status: "observed", cpu: {sse42: true, popcnt: true, osxsave: false,
        avx: false, avx2: false, xcr0: null}, instructions: {sse42: "completed", popcnt: "completed",
        avx: "illegal-instruction", avx2: "illegal-instruction"}, network: {hardwareNics: 0,
        enabledNonLoopbackInterfaces: 0, nonLoopbackRoutes: 0}, activation: activationReceipt(),
        systemTools: structuredClone(SYSTEM_TOOLS),
        output: {path: paths().outputDisk,
        bytes: "67108864", sha256: "3".repeat(64)}};
}

function earlyBoot() {
    return {schemaVersion: 1, kind: "qemu-early-boot-observation", inputSent: false,
        version: {major: 8, minor: 2, micro: 2}, status: "running", running: true,
        screenshots: [1, 2].map(index => ({path: `${paths().root}/early-boot-${index}.png`,
            bytes: String(PNG.length), sha256: HASH(PNG), bytesBase64: PNG.toString("base64")}))};
}

function operations(overrides = {}) {
    const calls = [];
    const seen = {};
    const op = {
        async resolveSignedPackageClosure() { calls.push("resolve"); return packageClosure(); },
        async acquirePackages(input) { calls.push("acquire-packages"); return {complete: true,
            packages: input.packageClosure.packages.map(value => ({reference:
                `${value.name}:${value.architecture}=${value.version}`, path: `${input.paths.packageRoot}/${value.name}.deb`,
            bytes: value.bytes, sha256: value.sha256}))}; },
        async extractPortableTools() { calls.push("extract-tools"); return toolchain(); },
        async acquireWindowsIso() { calls.push("acquire-iso"); return {finalUrl: STAGE2_PROVENANCE.windowsIso.finalUrl,
            bytes: STAGE2_PROVENANCE.windowsIso.bytes, etag: STAGE2_PROVENANCE.windowsIso.strongEtag,
            observerA: {id: "same-handle-pass-1", sha256: "4".repeat(64)},
            observerB: {id: "same-handle-pass-2", sha256: "4".repeat(64)}}; },
        async acquireProbeClosure(input) { calls.push("acquire-probes"); return {archive: input.probeArtifact.archive,
            innerManifest: input.probeArtifact.innerManifest, files: input.probeArtifact.files.map(value =>
                ({...value, path: `${input.paths.probeRoot}/${value.name}`}))}; },
        async extractInstallWim() { calls.push("extract-wim"); return {path: paths().installWim,
            sourceIsoSha256: "4".repeat(64), bytes: "5000000000", sha256: "5".repeat(64)}; },
        async inspectInstallWim(input) { calls.push("inspect-wim"); return {images: imageInventory(),
            removal: {path: input.installWim.path, sha256: input.installWim.sha256, removed: true}}; },
        async prepareOfflineMedia(input) { calls.push("prepare-media"); seen.seedSpec = input.seedSpec;
            seen.media = input; return {seedIso: {path: input.paths.seedIso,
            bytes: "1048576", sha256: "8".repeat(64), sourceManifestSha256: input.seedSpec.sha256,
            format: "iso9660", volumeLabel: "MYSPEEDSEED"}, outputDisk: {path: input.paths.outputDisk,
            bytes: "67108864", sha256: "0".repeat(64), format: "raw-fat", volumeLabel: "MYSPEEDOUT"}, systemDisk: {path: input.paths.systemDisk,
            bytes: "196616", sha256: "3".repeat(64), virtualBytes: "51539607552", format: "qcow2"}, ovmfVars: {path: input.paths.ovmfVars,
            sha256: toolchain().ovmfVarsTemplate.sha256}}; },
        async launchOwnedQemu(input) { calls.push("launch"); return {process: {exitCode: 0, signal: null,
            timedOut: false, cleanupProven: true, treeGone: true, qemuPid: 2345,
            qemuStartTicks: "77", launcherExecutablePath: toolchain().runtime.loader.path, processGroupId: 2300,
            qemuPidAbsentAfter: true, terminationReason: null}, argv: input.argv, earlyBoot: earlyBoot(),
            guest: guestEvidence()}; },
        ...overrides
    };
    return {op, calls, seen};
}

describe("hosted Windows CPU-floor Stage 2 runnable preparation", () => {
    it("requires request-bound permission for installer input and preserves the no-input default", () => {
        assert.deepEqual(validateEarlyBoot(earlyBoot(), paths()), earlyBoot());
        const entered = {...earlyBoot(), inputSent: bootInput()};
        assert.throws(() => validateEarlyBoot(entered, paths()), /input|confirmation/iu);
        assert.deepEqual(validateEarlyBoot(entered, paths(), BOOT_CONFIRMATION), entered);
        assert.throws(() => validateEarlyBoot(earlyBoot(), paths(), BOOT_CONFIRMATION), /input|confirmation/iu);
        assert.throws(() => validateEarlyBoot(entered, paths(), true), /input|confirmation/iu);
    });

    it("passes the installer policy to launch and retains it with accepted Stage 2 evidence", async () => {
        const fixture = operations();
        const originalLaunch = fixture.op.launchOwnedQemu;
        fixture.op.launchOwnedQemu = async input => {
            assert.equal(input.bootConfirmation, BOOT_CONFIRMATION);
            const observation = await originalLaunch(input);
            observation.earlyBoot.inputSent = bootInput();
            return observation;
        };
        const result = await runWindowsCpuFloorStage2({context: context(), admission: admission(), paths: paths(),
            probeArtifact: probeArtifact(), bootConfirmation: BOOT_CONFIRMATION}, fixture.op);
        assert.equal(result.status, "observed", result.failure?.message);
        assert.equal(result.bootConfirmation, BOOT_CONFIRMATION);
        assert.deepEqual(result.earlyBoot.inputSent, bootInput());
    });

    it("rejects a malformed installer policy before any Stage 2 operations", async () => {
        const fixture = operations();
        await assert.rejects(runWindowsCpuFloorStage2({context: context(), admission: admission(), paths: paths(),
            probeArtifact: probeArtifact(), bootConfirmation: true}, fixture.op), /confirmation/iu);
        assert.deepEqual(fixture.calls, []);
    });

    it("pins official sources, snapshot and complete root package set", () => {
        assert.deepEqual(PACKAGE_ROOTS, ["7zip", "genisoimage", "mtools", "ovmf", "qemu-system-x86",
            "qemu-utils", "wimtools"]);
        assert.equal(STAGE2_PROVENANCE.ubuntuSnapshot.id, "20260913T000000Z");
        assert.equal(STAGE2_PROVENANCE.ubuntuSnapshot.baseUrl,
            "https://snapshot.ubuntu.com/ubuntu/20260913T000000Z/");
        assert.equal(STAGE2_PROVENANCE.ubuntuSnapshot.isolatedEmptyDpkgStatus, true);
        assert.equal(STAGE2_PROVENANCE.windowsIso.aliasUrl, "https://aka.ms/WinServ2025iso-enus");
        assert.equal(STAGE2_PROVENANCE.windowsIso.bytes, "8152356864");
        assert.match(STAGE2_PROVENANCE.windowsIso.strongEtag, /^"0x[0-9A-F]+"$/u);
        assert.equal(STAGE2_PROVENANCE.windowsIso.strongEtagIsDigest, false);
    });

    it("accepts only a signed, reachable, exact-hash transitive package closure", () => {
        const valid = validatePackageClosure(packageClosure());
        assert.equal(valid.packages.length, PACKAGE_ROOTS.length + 1);
        assert.equal(Object.isFrozen(valid), true);
        for (const mutate of [
            value => value.releases[0].signatureVerified = false,
            value => value.packages[0].sha256 = "x".repeat(64),
            value => value.packages[0].dependsOn = ["missing:amd64=1"],
            value => value.packages.push({name: "unreachable", version: "1", architecture: "amd64",
                filename: "pool/u.deb", bytes: "1", sha256: FILE_HASH, dependsOn: []}),
            value => value.roots.pop(),
            value => value.indexes[0].path = "../Packages.xz"
        ]) {
            const candidate = packageClosure(); mutate(candidate);
            assert.throws(() => validatePackageClosure(candidate), /package|signature|root|index|reachable|hash/u);
        }
    });

    it("accepts signed Ubuntu tilde-version package paths without permitting unsafe paths", () => {
        // https://packages.ubuntu.com/noble-updates/amd64/libgcc-s1/download
        const dependency = {name: "libgcc-s1", version: "14.2.0-4ubuntu2~24.04.1", architecture: "amd64",
            filename: "pool/main/g/gcc-14/libgcc-s1_14.2.0-4ubuntu2~24.04.1_amd64.deb", bytes: "78392",
            sha256: "aa7fadbe33b78bcf99885318040601c550c208929565b179891d9a3cc2aa68cd", dependsOn: []};
        const candidate = packageClosure();
        const fixtureIndex = candidate.packages.findIndex(record => record.name === "libfixture");
        const previous = candidate.packages[fixtureIndex];
        const oldReference = `${previous.name}:${previous.architecture}=${previous.version}`;
        const newReference = `${dependency.name}:${dependency.architecture}=${dependency.version}`;
        candidate.packages[fixtureIndex] = dependency;
        for (const record of candidate.packages)
            record.dependsOn = record.dependsOn.map(reference => reference === oldReference ? newReference : reference);
        const accepted = validatePackageClosure(candidate);
        assert.deepEqual(accepted.packages.find(record => record.name === dependency.name), dependency);
        for (const filename of [
            "../outside.deb", "pool/../outside.deb", "/pool/outside.deb", "pool//file.deb",
            "pool/./file.deb", "pool/%2e%2e/file.deb", "pool/file%2fother.deb", "pool\\file.deb",
            "https://example.invalid/file.deb", `${dependency.filename}?query=1`, `${dependency.filename}#fragment`,
            `${dependency.filename}\n`, `${dependency.filename}\r\n`, "pool/space name.deb", "pool/file\0.deb"
        ]) {
            const invalid = structuredClone(candidate);
            invalid.packages[fixtureIndex].filename = filename;
            assert.throws(() => validatePackageClosure(invalid), /package filename is invalid/u, filename);
        }
    });

    it("selects the exact unique observed Standard Desktop edition from WIM metadata", () => {
        assert.deepEqual(selectWindowsImage(imageInventory()), imageInventory()[1]);
        assert.throws(() => selectWindowsImage([...imageInventory(), imageInventory()[1]]), /duplicated|unique/u);
        assert.throws(() => selectWindowsImage([...imageInventory(), {...imageInventory()[1], index: 3}]), /unique/u);
        assert.throws(() => selectWindowsImage(imageInventory().map(value => ({...value, architecture: "arm64"}))),
            /unique/u);
    });

    it("retains bounded validated WIM metadata for zero and multiple selection matches", async () => {
        const cases = [
            {matchCount: 0, images: imageInventory().map(image => ({...image, architecture: "arm64"}))},
            {matchCount: 2, images: [...imageInventory(), {...imageInventory()[1], index: 3}]}
        ];
        for (const {matchCount, images} of cases) {
            const fixture = operations({inspectInstallWim: async input => ({images,
                removal: {path: input.installWim.path, sha256: input.installWim.sha256, removed: true}})});
            const result = await runWindowsCpuFloorStage2({context: context(), admission: admission(), paths: paths(),
                probeArtifact: probeArtifact()}, fixture.op);
            assert.equal(result.status, "failed");
            assert.equal(result.stage, "wim-inspection");
            assert.deepEqual(Object.keys(result.wimSelection).sort(),
                ["expected", "inventorySha256", "kind", "matchCount", "observedImages", "schemaVersion"]);
            assert.equal(result.wimSelection.kind, "windows-server-2025-wim-selection-diagnostic");
            assert.deepEqual(result.wimSelection.expected, STAGE2_PROVENANCE.expectedImage);
            assert.equal(result.wimSelection.matchCount, matchCount);
            assert.deepEqual(result.wimSelection.observedImages, images);
            assert.equal(result.wimSelection.inventorySha256, HASH(Buffer.from(JSON.stringify(images))));
            assert.equal(Object.isFrozen(result.wimSelection.observedImages[0]), true);
            assert.ok(Buffer.byteLength(JSON.stringify(result.wimSelection)) <= MAX_WIM_SELECTION_DIAGNOSTIC_BYTES);
            assert.doesNotMatch(JSON.stringify(result.wimSelection), /(?:install\.wim|stdout|stderr|process)/iu);
        }
    });

    it("does not retain unvalidated WIM records or add diagnostics to successful results", async () => {
        const malformed = imageInventory(); malformed[0].extra = true;
        const fixture = operations({inspectInstallWim: async input => ({images: malformed,
            removal: {path: input.installWim.path, sha256: input.installWim.sha256, removed: true}})});
        const failed = await runWindowsCpuFloorStage2({context: context(), admission: admission(), paths: paths(),
            probeArtifact: probeArtifact()}, fixture.op);
        assert.equal(failed.status, "failed");
        assert.equal("wimSelection" in failed, false);

        const successful = await runWindowsCpuFloorStage2({context: context(), admission: admission(), paths: paths(),
            probeArtifact: probeArtifact()}, operations().op);
        assert.equal(successful.status, "observed", successful.failure);
        assert.equal("wimSelection" in successful, false);
    });

    it("builds the fixed offline KVM vector without implicit or network devices", () => {
        const argv = buildQemuArguments({paths: paths(), toolchain: toolchain()});
        assert.deepEqual(argv.slice(0, 20), ["-nodefaults", "-no-user-config", "-display", "none", "-monitor",
            "none", "-qmp", "stdio", "-L", toolchain().firmware.searchPath, "-accel", "kvm", "-machine", "q35",
            "-cpu", "Westmere-v2", "-smp",
            "2,sockets=1,cores=2,threads=1", "-m", "6144M"]);
        assert.equal(argv.includes("-nic"), true);
        assert.equal(argv[argv.indexOf("-nic") + 1], "none");
        assert.equal(argv.includes("-no-reboot"), false);
        const vgaIndex = argv.findIndex(value => value.startsWith("VGA,id=video0,"));
        assert.deepEqual(argv.slice(vgaIndex - 1, argv.indexOf("-nic")),
            ["-device", `VGA,id=video0,romfile=${toolchain().firmware.vga.path}`, "-device", "qemu-xhci,id=usb0",
                "-device", "usb-kbd,bus=usb0.0"]);
        assert.equal(argv[argv.indexOf("-qmp") + 1], "stdio");
        assert.equal(argv[argv.indexOf("-L") + 1], toolchain().firmware.searchPath);
        assert.ok(argv.includes(`VGA,id=video0,romfile=${toolchain().firmware.vga.path}`));
        assert.equal(argv.includes("-boot"), false);
        assert.deepEqual(argv.filter(value => value.includes("bootindex=")),
            ["ide-hd,drive=osdisk,bus=sata.1,bootindex=0", "ide-cd,drive=install,bus=sata.2,bootindex=1"]);
        assert.equal(argv.includes("ide-cd,drive=seed,bus=sata.3"), true);
        assert.equal(argv.includes("ide-hd,drive=output,bus=sata.4"), true);
        assert.equal(argv.some(value => /(?:^|[,=])(?:tap|user|socket|vsock)(?:[,=]|$)|virtfs|9p|fat:|nbd:|ssh:|http:/iu
            .test(value)), false);
        assert.equal(argv.some(value => value.endsWith(`file=${paths().windowsIso}`)), true);
        assert.equal(argv.some(value => value.endsWith(`file=${paths().seedIso}`)), true);
        assert.equal(argv.some(value => value.endsWith(`file=${paths().outputDisk}`)), true);
    });

    it("executes the exact preparation order and accepts only independent guest feature evidence", async () => {
        const {op, calls, seen} = operations();
        const result = await runWindowsCpuFloorStage2({context: context(), admission: admission(), paths: paths(),
            probeArtifact: probeArtifact()}, op);
        assert.deepEqual(calls, ["resolve", "acquire-packages", "extract-tools", "acquire-probes", "acquire-iso", "extract-wim",
            "inspect-wim", "prepare-media", "launch"]);
        assert.equal(result.status, "observed", result.failure);
        assert.equal(result.stage, "complete");
        assert.equal(result.cpuCalibrationAccepted, true);
        assert.equal(result.qualifying, false);
        assert.equal(result.releaseGateCleared, false);
        assert.equal(result.guest.network.hardwareNics, 0);
        assert.deepEqual(result.guest.systemTools, SYSTEM_TOOLS);
        assert.equal(result.selectedImage.index, 2);
        assert.equal(result.privilegeMode, "reviewed-sudo-kvm");
        assert.equal(result.qemuProcess.qemuStartTicks, "77");
        assert.equal(result.qemuProcess.launcherExecutablePath, toolchain().runtime.loader.path);
        assert.deepEqual(result.installWimRemoval, {path: paths().installWim, sha256: "5".repeat(64), removed: true});
        const unattend = Buffer.from(seen.seedSpec.files.find(file => file.name === "Autounattend.xml").bytesBase64,
            "base64").toString("utf8");
        assert.match(unattend, /\/IMAGE\/NAME/u);
        assert.match(unattend, /<Key>\/IMAGE\/NAME<\/Key>/u);
        assert.doesNotMatch(unattend, /wcm:keyValue/u);
        assert.doesNotMatch(unattend, /\/IMAGE\/INDEX/u);
        assert.match(unattend, /<PartitionID>3<\/PartitionID>/u);
        const bootstrap = Buffer.from(seen.seedSpec.files.find(file => file.name === "bootstrap.ps1").bytesBase64,
            "base64").toString("utf8");
        assert.match(bootstrap, /MYSPEEDOUT/u);
        assert.match(bootstrap, /Get-NetAdapter/u);
        assert.match(bootstrap, /SetErrorMode 3/u);
        assert.match(bootstrap, /\$probeTimeoutMilliseconds = \$PROBE_TIMEOUT_MILLISECONDS/u);
        assert.match(bootstrap, /WaitForExit\(\$probeTimeoutMilliseconds\)/u);
        assert.match(bootstrap, /BitConverter\]::ToUInt32/u);
        assert.match(bootstrap, /\$bootstrapFailure = \$null/u);
        assert.match(bootstrap, /\$errorModeChanged = \$false\r\n\s+try \{/u);
        assert.match(bootstrap, /catch \{\r\n\s+\$bootstrapFailure = \$_/u);
        assert.match(bootstrap, /\$expectedNonce = \$EXPECTED_NONCE/u);
        assert.match(bootstrap, /status='failed';nonce=\$EXPECTED_NONCE;stage='guest-bootstrap'/u);
        assert.match(bootstrap, /\$temporaryPath = \$Path \+ '\.tmp'/u);
        assert.match(bootstrap, /StructuralEqualityComparer\.Equals\(\$observed,\$Bytes\)/u);
        assert.match(bootstrap, /ObserveActivation/u);
        for (const tool of SYSTEM_TOOLS) assert.match(bootstrap, new RegExp(tool.path.replaceAll("\\", "\\\\"), "u"));
        assert.match(bootstrap, /FileShare\]::Read/u);
        assert.ok(bootstrap.indexOf("record.systemTools = & $Operations.ObserveSystemTools") <
            bootstrap.indexOf("& $Shutdown"));
        assert.ok(bootstrap.indexOf("ObserveActivation") < bootstrap.indexOf("successBytes"));
        assert.match(bootstrap, /\[IO\.File\]::Move\(\$temporaryPath,\$Path\)/u);
        assert.match(bootstrap, /finally \{\r\n\s+try \{\r\n\s+if \(\$errorModeChanged\)/u);
        /*
         * The shutdown call keeps its own try/finally and no catch, so exception precedence is
         * unchanged; the outcome literal is selected before the call and the marker is written only
         * in the inner finally, after the call has returned or thrown.
         */
        assert.match(bootstrap, /\} finally \{\r\n\s+\$outcomeJson = \$SHUTDOWN_FAILED_JSON\r\n\s+try \{\r\n\s+& \$Shutdown\r\n\s+\$outcomeJson = \$SHUTDOWN_RETURNED_JSON\r\n\s+\} finally \{/u);
        assert.ok(bootstrap.indexOf("& $Shutdown") <
            bootstrap.indexOf("$Operations.WriteExclusive (Join-Path $outputRoot $SHUTDOWN_OUTCOME_NAME)"));
        assert.equal((bootstrap.match(/Stop-Computer -Force/gu) ?? []).length, 1);
        assert.ok(bootstrap.indexOf("Stop-Computer -Force") > bootstrap.indexOf("finally {"));
        assert.ok(bootstrap.indexOf("Operations.SetErrorMode $previousErrorMode") < bootstrap.indexOf("& $Shutdown"));
        assert.doesNotMatch(bootstrap, /Enable-NetAdapter|New-NetIPAddress|Set-Net/u);
        assert.deepEqual(seen.seedSpec.files.filter(file => file.kind === "activation-inline")
            .map(file => file.name), ["SetupComplete.cmd", "myspeed-msi-setupcomplete.ps1"]);
        assert.deepEqual(seen.seedSpec.files.filter(file => file.kind === "activation-installer")
            .map(file => file.name), ["install-activation.ps1"]);
        assert.deepEqual(seen.seedSpec.files.filter(file => file.kind === "activation-handoff")
            .map(file => file.name), ["myspeed-base-calibration-handoff.json"]);
        const unattendXml = Buffer.from(seen.seedSpec.files.find(file => file.name === "Autounattend.xml").bytesBase64,
            "base64").toString("utf8");
        assert.match(unattendXml, /install-activation\.ps1/u);
        assert.doesNotMatch(unattendXml, /bootstrap\.ps1|WillReboot/u);
        assert.deepEqual(result.guest.activation, activationReceipt());
        assert.deepEqual(seen.seedSpec.files.filter(file => file.kind === "owned-file").map(file => file.name),
            PROBE_ROLES.map(role => `${role}.exe`));
        assert.equal(seen.seedSpec.files.find(file => file.name === "known-good.exe").sourcePath,
            `${paths().probeRoot}/known_good.exe`);
    });

    it("answers the Windows Setup language page from the windowsPE pass", async () => {
        const {op, seen} = operations();
        const result = await runWindowsCpuFloorStage2({context: context(), admission: admission(), paths: paths(),
            probeArtifact: probeArtifact()}, op);
        assert.equal(result.status, "observed", result.failure);
        const unattend = Buffer.from(seen.seedSpec.files.find(file => file.name === "Autounattend.xml").bytesBase64,
            "base64").toString("utf8");
        const windowsPe = unattend.match(/<settings pass="windowsPE">([\s\S]*?)<\/settings>/u);
        assert.ok(windowsPe, "answer file has no windowsPE pass");
        assert.match(windowsPe[1], /<component name="Microsoft-Windows-International-Core-WinPE" /u);
        assert.match(windowsPe[1], /<SetupUILanguage><UILanguage>en-US<\/UILanguage><\/SetupUILanguage>/u);
        for (const setting of ["InputLocale", "SystemLocale", "UILanguage", "UserLocale"])
            assert.match(windowsPe[1], new RegExp(`<${setting}>en-US</${setting}>`, "u"));
        assert.doesNotMatch(unattend.replace(/<settings pass="windowsPE">[\s\S]*?<\/settings>/u, ""),
            /International-Core-WinPE/u);
    });

    it("captures native collector constants in its returned detached closure", {skip: process.platform !== "win32"}, () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), "myspeed-stage2-native-closure-"));
        const script = path.join(root, "bootstrap.ps1");
        fs.writeFileSync(script, renderGuestBootstrap(context()));
        const harness = `$ErrorActionPreference='Stop';$global:timeouts=[Collections.Generic.List[int]]::new();` +
            `$global:lifecycle=[Collections.Generic.List[string]]::new();$global:nullExit=$false;` +
            `$global:testRoot='${root.replaceAll("'", "''")}';` +
            `function global:Join-Path{param($Path,$ChildPath)if($ChildPath -like 'Temp\\myspeed-*'){` +
            `[IO.Path]::Combine($global:testRoot,[IO.Path]::GetFileName($ChildPath))}else{` +
            `[IO.Path]::Combine([string]$Path,[string]$ChildPath)}}` +
            `function global:Add-Type{param($TypeDefinition,$Language)}` +
            `function global:Start-Process{param($FilePath,[switch]$NoNewWindow,[switch]$PassThru,` +
            `$RedirectStandardOutput,$RedirectStandardError);[IO.File]::WriteAllBytes($RedirectStandardOutput,[byte[]]@());` +
            `[IO.File]::WriteAllBytes($RedirectStandardError,[byte[]]@());$p=[pscustomobject]@{};` +
            `$p|Add-Member ScriptProperty Handle {$global:lifecycle.Add('handle');1};` +
            `$p|Add-Member ScriptMethod WaitForExit {param([int]$Milliseconds)$global:lifecycle.Add('wait');` +
            `$global:timeouts.Add($Milliseconds);$true};$p|Add-Member ScriptProperty ExitCode {` +
            `$global:lifecycle.Add('exit');if($global:nullExit){return $null};return 0};` +
            `$p|Add-Member ScriptMethod Kill {};` +
            `$p|Add-Member ScriptMethod Dispose {$global:lifecycle.Add('dispose')};return $p}` +
            `function global:Get-CimInstance{param($ClassName) @()}` +
            `function global:Get-NetAdapter{param([switch]$IncludeHidden) @()}` +
            `function global:Get-NetRoute{ @() };` +
            `$ops=& {. '${script.replaceAll("'", "''")}' -LibraryMode;New-MyspeedGuestNativeOperations};` +
            `$result=& $ops.CollectEvidence '${root.replaceAll("'", "''")}';` +
            `$global:nullExit=$true;$rejected=$null;try{& $ops.CollectEvidence '${root.replaceAll("'", "''")}'}catch{` +
            `$rejected=$_.Exception.Message};` +
            `[Console]::Out.Write(([ordered]@{nonce=$result.nonce;runCount=$result.runs.Count;` +
            `timeouts=@($global:timeouts);lifecycle=@($global:lifecycle);rejected=$rejected}|ConvertTo-Json -Compress))`;
        try {
            const result = spawnSync("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
                ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", harness],
                {encoding: "utf8", timeout: POWERSHELL_TEST_TIMEOUT_MILLISECONDS});
            assert.equal(result.status, 0, result.stderr);
            const observed = JSON.parse(result.stdout);
            assert.equal(observed.nonce, NONCE);
            assert.equal(observed.runCount, PROBE_ROLES.length);
            assert.deepEqual(observed.timeouts,
                Array(PROBE_ROLES.length + 1).fill(EXPECTED_GUEST_PROBE_TIMEOUT_MILLISECONDS));
            assert.deepEqual(observed.lifecycle, [...Array(PROBE_ROLES.length).fill(["handle", "wait", "exit", "dispose"])
                .flat(), "handle", "wait", "exit", "dispose"]);
            assert.equal(observed.rejected, "Probe exit code is unavailable");
        } finally { fs.rmSync(root, {recursive: true, force: true}); }
    });

    it("captures activation identities when its native-operation factory is created in a nested scope",
        {skip: process.platform !== "win32"}, () => {
            const root = fs.mkdtempSync(path.join(os.tmpdir(), "myspeed-stage2-activation-closure-"));
            const script = path.join(root, "bootstrap.ps1");
            const setupRoot = path.join(root, "Setup", "Scripts");
            const expected = activation();
            fs.mkdirSync(setupRoot, {recursive: true});
            fs.writeFileSync(script, renderGuestBootstrap(context()));
            fs.writeFileSync(path.join(setupRoot, "SetupComplete.cmd"),
                Buffer.from(expected.files.setupComplete.bytesBase64, "base64"));
            fs.writeFileSync(path.join(setupRoot, "myspeed-msi-setupcomplete.ps1"),
                Buffer.from(expected.files.dispatcher.bytesBase64, "base64"));
            const declaredRoot = path.win32.dirname(expected.files.setupComplete.path).replaceAll("'", "''");
            const harness = `$ErrorActionPreference='Stop';$global:testRoot='${setupRoot.replaceAll("'", "''")}';` +
                `function global:Get-Item{param($LiteralPath,[switch]$Force)` +
                `if([string]$LiteralPath -ceq '${declaredRoot}'){$LiteralPath=$global:testRoot};` +
                `Microsoft.PowerShell.Management\\Get-Item -LiteralPath $LiteralPath -Force}` +
                `function global:Join-Path{param($Path,$ChildPath)if([string]$Path -ceq '${declaredRoot}'){` +
                `[IO.Path]::Combine($global:testRoot,[string]$ChildPath)}` +
                `else{[IO.Path]::Combine([string]$Path,[string]$ChildPath)}}` +
                `function global:Add-Type{param($TypeDefinition,$Language)}` +
                `function global:Get-ScheduledTask{param($TaskName,$TaskPath)[pscustomobject]@{` +
                `Actions=@([pscustomobject]@{Execute='${expected.startupTask.executable.replaceAll("'", "''")}';` +
                `Arguments='${expected.startupTask.arguments.replaceAll("'", "''")}'});` +
                `Triggers=@([pscustomobject]@{Enabled=$true;CimClass=[pscustomobject]@{` +
                `CimClassName='MSFT_TaskBootTrigger'}});Principal=[pscustomobject]@{` +
                `UserId='${expected.startupTask.principal}';RunLevel='${expected.startupTask.runLevel}'}}};` +
                `$ops=& {. '${script.replaceAll("'", "''")}' -LibraryMode;New-MyspeedGuestNativeOperations};` +
                `$observed=& $ops.ObserveActivation;$capturedLimit=` +
                `$ops.ObserveSystemTools.Module.SessionState.PSVariable.GetValue('maximumSystemToolBytes');` +
                `[Console]::Out.Write(([ordered]@{activation=$observed;capturedLimit=$capturedLimit}|` +
                `ConvertTo-Json -Compress -Depth 8))`;
            try {
                const result = spawnSync("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
                    ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", harness],
                    {encoding: "utf8", timeout: POWERSHELL_TEST_TIMEOUT_MILLISECONDS});
                assert.equal(result.status, 0, result.stderr);
                const observed = JSON.parse(result.stdout);
                const receipt = activationReceipt();
                assert.equal(observed.capturedLimit, 268_435_456);
                assert.deepEqual(observed.activation.startupTask, receipt.startupTask);
                /* The reported paths are the host-declared paths, never the observation root's own. */
                assert.equal(observed.activation.files.setupComplete.path, receipt.files.setupComplete.path);
                assert.equal(observed.activation.files.dispatcher.path, receipt.files.dispatcher.path);
                assert.deepEqual(observed.activation.files.setupComplete.bytes, receipt.files.setupComplete.bytes);
                assert.deepEqual(observed.activation.files.setupComplete.sha256, receipt.files.setupComplete.sha256);
                assert.deepEqual(observed.activation.files.dispatcher.bytes, receipt.files.dispatcher.bytes);
                assert.deepEqual(observed.activation.files.dispatcher.sha256, receipt.files.dispatcher.sha256);
            } finally { fs.rmSync(root, {recursive: true, force: true}); }
        });

    it("runs injected bootstrap failure, diagnostic, restoration and shutdown paths", {skip: process.platform !== "win32"}, () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), "myspeed-stage2-bootstrap-"));
        const script = path.join(root, "bootstrap.ps1");
        fs.writeFileSync(script, renderGuestBootstrap(context()));
        const harness = `$ErrorActionPreference='Stop';. '${script.replaceAll("'", "''")}' -LibraryMode;` +
            `$events=[Collections.Generic.List[string]]::new();$resolveCount=0;` +
            `$ops=@{SetErrorMode={param([uint32]$Mode)$events.Add('mode:'+$Mode);if($Mode -eq 3){return [uint32]77}};` +
            `ResolveVolume={param([string]$Label)$script:resolveCount++;$events.Add('resolve:'+$Label);` +
            `if($Label -eq 'MYSPEEDSEED'){'C:\\Seed\\'}else{'C:\\Output\\'}};` +
            `CollectEvidence={param([string]$Seed)$events.Add('collect');[ordered]@{ok=$true}};` +
            `ObserveActivation={$events.Add('activation');'${JSON.stringify(activationReceipt())}'|` +
            `ConvertFrom-Json};` +
            `ObserveSystemTools={$events.Add('system-tools');'${JSON.stringify(SYSTEM_TOOLS)}'|ConvertFrom-Json};` +
            `WriteExclusive={param([string]$Path,[byte[]]$Bytes)$events.Add('write:'+[IO.Path]::GetFileName($Path));` +
            `if([IO.Path]::GetFileName($Path) -eq 'result.json'){throw 'synthetic write failure'}}};` +
            `try{Invoke-MyspeedGuestBootstrap -Operations $ops -Shutdown {$events.Add('shutdown')}}` +
            `catch{$events.Add('caught')};[Console]::Out.Write(($events -join ','))`;
        try {
            const result = spawnSync("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
                ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", harness],
                {encoding: "utf8", timeout: POWERSHELL_TEST_TIMEOUT_MILLISECONDS});
            assert.equal(result.status, 0, result.stderr);
            assert.equal(result.stdout, "mode:3,resolve:MYSPEEDSEED,resolve:MYSPEEDOUT,collect,activation,system-tools,mode:77," +
                "write:result.json,shutdown,write:shutdown-outcome.json,caught");
        } finally { fs.rmSync(root, {recursive: true, force: true}); }
    });

    it("still invokes shutdown when error-mode restoration fails", {skip: process.platform !== "win32"}, () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), "myspeed-stage2-restore-"));
        const script = path.join(root, "bootstrap.ps1");
        fs.writeFileSync(script, renderGuestBootstrap(context()));
        const harness = `$ErrorActionPreference='Stop';. '${script.replaceAll("'", "''")}' -LibraryMode;` +
            `$events=[Collections.Generic.List[string]]::new();$script:writtenBytes=@{};` +
            `$ops=@{SetErrorMode={param([uint32]$Mode)$events.Add('mode:'+$Mode);` +
            `if($Mode -eq 3){return [uint32]77}else{throw 'restore failed'}};` +
            `ResolveVolume={param([string]$Label)$events.Add('resolve:'+$Label);'C:\\Output\\'};` +
            `CollectEvidence={param([string]$Seed)$events.Add('collect');[ordered]@{ok=$true}};` +
            `ObserveActivation={$events.Add('activation');'${JSON.stringify(activationReceipt())}'|` +
            `ConvertFrom-Json};` +
            `ObserveSystemTools={$events.Add('system-tools');'${JSON.stringify(SYSTEM_TOOLS)}'|ConvertFrom-Json};` +
            `WriteExclusive={param([string]$Path,[byte[]]$Bytes)$name=[IO.Path]::GetFileName($Path);` +
            `$events.Add('write:'+$name);$script:writtenBytes[$name]=[byte[]]$Bytes.Clone()}};` +
            `try{Invoke-MyspeedGuestBootstrap -Operations $ops -Shutdown {$events.Add('shutdown')}}` +
            `catch{$events.Add('caught')};` +
            `$outcome=[Text.Encoding]::UTF8.GetString($script:writtenBytes['result.json'])|ConvertFrom-Json;` +
            `$marker=[Text.Encoding]::UTF8.GetString($script:writtenBytes['shutdown-outcome.json'])|ConvertFrom-Json;` +
            `[Console]::Out.Write(([ordered]@{events=($events -join ',');outcome=$outcome;marker=$marker}|` +
            `ConvertTo-Json -Compress))`;
        try {
            const result = spawnSync("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
                ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", harness],
                {encoding: "utf8", timeout: POWERSHELL_TEST_TIMEOUT_MILLISECONDS});
            assert.equal(result.status, 0, result.stderr);
            const observed = JSON.parse(result.stdout);
            assert.equal(observed.events, "mode:3,resolve:MYSPEEDSEED,resolve:MYSPEEDOUT,collect,activation,system-tools,mode:77," +
                "write:result.json,shutdown,write:shutdown-outcome.json,caught");
            assert.deepEqual(observed.outcome, {schemaVersion: 1, status: "failed", nonce: NONCE,
                stage: "guest-bootstrap", failure: "restore failed"});
            assert.deepEqual(observed.marker, {schemaVersion: 1, nonce: NONCE, stage: "guest-shutdown",
                event: "returned"});
        } finally { fs.rmSync(root, {recursive: true, force: true}); }
    });

    it("accepts the exact acquired-probe projection returned by the hosted adapter", async () => {
        const artifact = probeArtifact();
        const hosted = createHostedStage2Operations({context: context(), paths: paths(), dependencies: {
            monotonicMilliseconds: () => 0,
            inspectOwned: target => {
                const expected = artifact.files.find(file => target.endsWith(`/${file.name}`));
                if (target.endsWith("/artifact.zip")) return {path: target, bytes: artifact.archive.bytes,
                    sha256: artifact.archive.sha256,
                    ownership: {uid: "1001", gid: "127", mode: "600", ordinaryUserWritable: false}};
                return {path: target, bytes: expected.bytes, sha256: expected.sha256,
                    ownership: {uid: "1001", gid: "127", mode: "500", ordinaryUserWritable: false}};
            },
            readOwnedVerified: target => ({bytes: Buffer.from("sealed probe result"), identity: {path: target,
                bytes: artifact.innerManifest.bytes, sha256: artifact.innerManifest.sha256}}),
            parseProbeEvidence: (bytes, value) => {
                assert.deepEqual(bytes, Buffer.from("sealed probe result"));
                assert.deepEqual(value, artifact);
            }
        }});
        const fixture = operations({acquireProbeClosure: input => hosted.acquireProbeClosure(input)});
        const result = await runWindowsCpuFloorStage2({context: context(), admission: admission(), paths: paths(),
            probeArtifact: artifact}, fixture.op);
        assert.equal(result.status, "observed", result.failure);
        assert.deepEqual(Object.keys(result.probes.files[0]).sort(), ["bytes", "name", "path", "role", "sha256"]);
    });

    it("stops before acquisition or launch on admission, closure, ISO, WIM, model or guest failures", async () => {
        const rejected = admission(); rejected.admitted = false; rejected.status = "rejected";
        const none = operations();
        const admissionResult = await runWindowsCpuFloorStage2({context: context(), admission: rejected,
            paths: paths(), probeArtifact: probeArtifact()}, none.op);
        assert.equal(admissionResult.stage, "admission");
        assert.deepEqual(none.calls, []);

        const cases = [
            ["package-closure", {resolveSignedPackageClosure: async () => ({})}, "package-closure"],
            ["iso", {acquireWindowsIso: async () => ({finalUrl: STAGE2_PROVENANCE.windowsIso.finalUrl,
                bytes: STAGE2_PROVENANCE.windowsIso.bytes, etag: STAGE2_PROVENANCE.windowsIso.strongEtag,
                observerA: {id: "same", sha256: FILE_HASH}, observerB: {id: "same", sha256: FILE_HASH}})},
            "iso"],
            ["wim", {inspectInstallWim: async () => []}, "wim-inspection"],
            ["toolchain", {extractPortableTools: async () => ({...toolchain(), capabilities: {...toolchain().capabilities,
                cpuModels: []}})}, "toolchain"],
            ...["VGA", "qemu-xhci", "usb-kbd"].map(device => [`toolchain missing ${device}`,
                {extractPortableTools: async () => { const changed = toolchain();
                    changed.capabilities.devices = changed.capabilities.devices.filter(value => value !== device);
                    return changed; }}, "toolchain"]),
            ["toolchain missing firmware", {extractPortableTools: async () => {
                const changed = toolchain(); delete changed.firmware.kvmvapic; return changed;
            }}, "toolchain"],
            ["toolchain firmware alias", {extractPortableTools: async () => {
                const changed = toolchain(); changed.firmware.vga.path = `${paths().portableRoot}/usr/share/qemu/vga.bin`;
                return changed;
            }}, "toolchain"],
            ["toolchain alias", {extractPortableTools: async () => {
                const changed = toolchain(); changed.wiminfo.invocationPath = `${paths().portableRoot}/usr/bin/wimlib-imagex`;
                return changed;
            }}, "toolchain"],
            ["legacy sevenZip path", {extractPortableTools: async () => {
                const changed = toolchain();
                changed.sevenZip.path = `${paths().portableRoot}/usr/bin/7zz`;
                changed.sevenZip.invocationPath = changed.sevenZip.path;
                return changed;
            }}, "toolchain"],
            ["sevenZip module path absent", {extractPortableTools: async () => {
                const changed = toolchain(); changed.runtime.libraryPath.pop(); return changed;
            }}, "toolchain"],
            ["guest", {launchOwnedQemu: async input => ({process: {exitCode: 0, signal: null, timedOut: false,
                cleanupProven: true, treeGone: true}, argv: input.argv, guest: {...guestEvidence(), cpu: {
                ...guestEvidence().cpu, avx: true}}})}, "qemu-launch"]
        ];
        for (const [label, override, lastCall] of cases) {
            const fixture = operations(override);
            const result = await runWindowsCpuFloorStage2({context: context(), admission: admission(), paths: paths(),
                probeArtifact: probeArtifact()},
                fixture.op);
            assert.equal(result.status, "failed", label);
            assert.equal(result.qualifying, false, label);
            assert.equal(result.releaseGateCleared, false, label);
            assert.equal(result.stage, lastCall, label);
        }

        const bootstrap = operations({launchOwnedQemu: async input => ({process: {exitCode: 0, signal: null,
            timedOut: false, cleanupProven: true, treeGone: true, qemuPid: 2345, qemuStartTicks: "77",
            launcherExecutablePath: toolchain().runtime.loader.path, processGroupId: 2300,
            qemuPidAbsentAfter: true, terminationReason: null}, argv: input.argv, earlyBoot: earlyBoot(), guest: {schemaVersion: 1,
            status: "failed", nonce: context().nonce, stage: "guest-bootstrap", failure: "probe execution failed"}})});
        const bootstrapResult = await runWindowsCpuFloorStage2({context: context(), admission: admission(), paths: paths(),
            probeArtifact: probeArtifact()}, bootstrap.op);
        assert.equal(bootstrapResult.status, "failed");
        assert.match(bootstrapResult.failure, /probe execution failed/u);
    });

    it("records failure and cleanup truth without treating a QEMU CPU name as calibration", async () => {
        const stderr = Buffer.from("qemu-system-x86_64: synthetic launch failure\n");
        const process = {exitCode: 1, signal: null, timedOut: false, cleanupProven: false, treeGone: false,
            qemuPid: 2345, qemuStartTicks: "77", launcherExecutablePath: toolchain().runtime.loader.path,
            processGroupId: 2300, qemuPidAbsentAfter: true, terminationReason: null};
        const diagnostic = {schemaVersion: 1, kind: "qemu-launch-failure-diagnostic", process: structuredClone(process),
            processFlags: {errorObserved: false, stdoutOverflow: false, stderrOverflow: false},
            monitorFailure: {phase: "identity-observation", message: "QEMU live process identity differs",
                identity: {pid: 2345, expected: {processGroupId: 2300,
                    executablePath: toolchain().runtime.loader.path}, observed: {state: "present", pid: 2345,
                    processGroupId: 999, startTicks: "77", executablePath: "/unexpected/qemu"}}},
            stderr: {bytes: String(stderr.length), sha256: HASH(stderr), bytesBase64: stderr.toString("base64")}};
        const fixture = operations({launchOwnedQemu: async input => ({process, argv: input.argv,
            earlyBoot: earlyBoot(), guest: null, failureDiagnostic: diagnostic})});
        const result = await runWindowsCpuFloorStage2({context: context(), admission: admission(), paths: paths(),
            probeArtifact: probeArtifact()},
            fixture.op);
        assert.equal(result.status, "failed");
        assert.equal(result.stage, "qemu-launch");
        assert.equal(result.cpuCalibrationAccepted, false);
        assert.equal(result.cleanupProven, false);
        assert.equal(result.qualifying, false);
        assert.deepEqual(result.qemuLaunch, diagnostic);
        assert.equal(Object.isFrozen(result.qemuLaunch), true);
        const cleanProcess = {...process, exitCode: 0, cleanupProven: true, treeGone: true};
        const cleanDiagnostic = {...diagnostic, process: structuredClone(cleanProcess)};
        const missingEarlyBoot = operations({launchOwnedQemu: async input => ({process: cleanProcess,
            argv: input.argv, earlyBoot: null, guest: null, failureDiagnostic: cleanDiagnostic})});
        const missingEarlyBootResult = await runWindowsCpuFloorStage2({context: context(), admission: admission(),
            paths: paths(), probeArtifact: probeArtifact()}, missingEarlyBoot.op);
        assert.equal(missingEarlyBootResult.status, "failed");
        assert.deepEqual(missingEarlyBootResult.qemuLaunch, cleanDiagnostic);
        // Serial capture is optional for legacy replay. New captures distinguish complete, bounded
        // and unavailable evidence; empty serial text does not prove the firmware showed nothing.
        const serial = Buffer.from("BdsDxe: loading Boot0001 UEFI QEMU DVD-ROM\r\n");
        const withSerial = {...structuredClone(diagnostic), serialLog: {status: "captured",
            bytes: String(serial.length), sha256: HASH(serial), bytesBase64: serial.toString("base64"),
            observedBytes: String(serial.length), truncated: false}};
        const serialFixture = operations({launchOwnedQemu: async input => ({process, argv: input.argv,
            earlyBoot: earlyBoot(), guest: null, failureDiagnostic: withSerial})});
        const serialResult = await runWindowsCpuFloorStage2({context: context(), admission: admission(),
            paths: paths(), probeArtifact: probeArtifact()}, serialFixture.op);
        assert.deepEqual(serialResult.qemuLaunch, withSerial);
        const truncatedPrefix = Buffer.alloc(MAX_QEMU_DIAGNOSTIC_STREAM_BYTES, TRUNCATED_SERIAL_PREFIX_BYTE);
        const truncatedSerial = {...structuredClone(diagnostic), serialLog: {status: "captured",
            bytes: String(truncatedPrefix.length), sha256: HASH(truncatedPrefix),
            bytesBase64: truncatedPrefix.toString("base64"), observedBytes: String(truncatedPrefix.length + 1),
            truncated: true}};
        const truncatedSerialFixture = operations({launchOwnedQemu: async input => ({process, argv: input.argv,
            earlyBoot: earlyBoot(), guest: null, failureDiagnostic: truncatedSerial})});
        const truncatedSerialResult = await runWindowsCpuFloorStage2({context: context(), admission: admission(),
            paths: paths(), probeArtifact: probeArtifact()}, truncatedSerialFixture.op);
        assert.deepEqual(truncatedSerialResult.qemuLaunch, truncatedSerial);
        // A truncated capture may have cut off the UEFI-shell banner, so a non-matching truncated serial must flag
        // that the boot-failure detection was incomplete rather than silently reporting only the generic message.
        assert.ok(truncatedSerialResult.failure.includes(EFI_SHELL_TRUNCATED_ATTRIBUTION),
            truncatedSerialResult.failure);
        assert.doesNotMatch(serialResult.failure, /truncated/u);
        const legacySerial = structuredClone(withSerial);
        legacySerial.serialLog = {bytes: String(serial.length), sha256: HASH(serial),
            bytesBase64: serial.toString("base64")};
        const legacySerialFixture = operations({launchOwnedQemu: async input => ({process, argv: input.argv,
            earlyBoot: earlyBoot(), guest: null, failureDiagnostic: legacySerial})});
        const legacySerialResult = await runWindowsCpuFloorStage2({context: context(), admission: admission(),
            paths: paths(), probeArtifact: probeArtifact()}, legacySerialFixture.op);
        assert.deepEqual(legacySerialResult.qemuLaunch, legacySerial);
        const unavailableSerial = {...structuredClone(diagnostic), serialLog: {status: "unavailable"}};
        const unavailableSerialFixture = operations({launchOwnedQemu: async input => ({process, argv: input.argv,
            earlyBoot: earlyBoot(), guest: null, failureDiagnostic: unavailableSerial})});
        const unavailableSerialResult = await runWindowsCpuFloorStage2({context: context(), admission: admission(),
            paths: paths(), probeArtifact: probeArtifact()}, unavailableSerialFixture.op);
        assert.deepEqual(unavailableSerialResult.qemuLaunch, unavailableSerial);
        for (const broken of [{...withSerial.serialLog, sha256: "0".repeat(64)},
            {...withSerial.serialLog, observedBytes: "0"}, {...withSerial.serialLog, truncated: true},
            {...withSerial.serialLog, bytesBase64: "A".repeat(MAX_QEMU_DIAGNOSTIC_BASE64_CHARACTERS + 1)},
            {status: "unavailable", bytes: String(serial.length)},
            {bytes: String(serial.length), sha256: HASH(serial)}]) {
            const rejectedSerial = operations({launchOwnedQemu: async input => ({process, argv: input.argv,
                earlyBoot: earlyBoot(), guest: null,
                failureDiagnostic: {...structuredClone(diagnostic), serialLog: broken}})});
            const outcome = await runWindowsCpuFloorStage2({context: context(), admission: admission(),
                paths: paths(), probeArtifact: probeArtifact()}, rejectedSerial.op);
            assert.equal("qemuLaunch" in outcome, false);
        }

        const oversized = structuredClone(diagnostic);
        oversized.stderr.bytesBase64 = "A".repeat(MAX_QEMU_DIAGNOSTIC_BASE64_CHARACTERS + 1);
        const rejected = operations({launchOwnedQemu: async input => ({process, argv: input.argv,
            earlyBoot: earlyBoot(), guest: null, failureDiagnostic: oversized})});
        const rejectedResult = await runWindowsCpuFloorStage2({context: context(), admission: admission(), paths: paths(),
            probeArtifact: probeArtifact()}, rejected.op);
        assert.equal("qemuLaunch" in rejectedResult, false);
    });

    it("attributes a UEFI-shell boot failure instead of the generic QEMU message", async () => {
        const stderr = Buffer.from("qemu-system-x86_64: warning: host feature\n");
        const process = {exitCode: 137, signal: null, timedOut: false, cleanupProven: false, treeGone: false,
            qemuPid: 2345, qemuStartTicks: "77", launcherExecutablePath: toolchain().runtime.loader.path,
            processGroupId: 2300, qemuPidAbsentAfter: true, terminationReason: null};
        const base = {schemaVersion: 1, kind: "qemu-launch-failure-diagnostic", process: structuredClone(process),
            processFlags: {errorObserved: false, stdoutOverflow: false, stderrOverflow: false}, monitorFailure: null,
            stderr: {bytes: String(stderr.length), sha256: HASH(stderr), bytesBase64: stderr.toString("base64")}};
        const withSerial = (bytes) => ({...structuredClone(base), serialLog: {status: "captured",
            bytes: String(bytes.length), sha256: HASH(bytes), bytesBase64: bytes.toString("base64"),
            observedBytes: String(bytes.length), truncated: false}});
        // The guest fell to the UEFI shell (Windows never booted): the top-line names it.
        const shellSerial = Buffer.from('BdsDxe: loading Boot0003 "EFI Internal Shell"\r\n\x1b[0mUEFI Interactive Shell v2.2\r\nShell> ');
        const shellDiagnostic = withSerial(shellSerial);
        const shellFixture = operations({launchOwnedQemu: async input => ({process, argv: input.argv,
            earlyBoot: earlyBoot(), guest: null, failureDiagnostic: shellDiagnostic})});
        const shellResult = await runWindowsCpuFloorStage2({context: context(), admission: admission(),
            paths: paths(), probeArtifact: probeArtifact()}, shellFixture.op);
        assert.equal(shellResult.status, "failed");
        assert.equal(shellResult.stage, "qemu-launch");
        assert.equal(shellResult.failure, "guest did not boot Windows (dropped to UEFI shell)");
        // The classifier reads the serial evidence but never mutates it.
        assert.deepEqual(shellResult.qemuLaunch, shellDiagnostic);
        // A benign serial capture (ordinary boot line) keeps the generic message.
        const benignDiagnostic = withSerial(Buffer.from("BdsDxe: loading Boot0001 UEFI QEMU DVD-ROM\r\n"));
        const benignFixture = operations({launchOwnedQemu: async input => ({process, argv: input.argv,
            earlyBoot: earlyBoot(), guest: null, failureDiagnostic: benignDiagnostic})});
        const benignResult = await runWindowsCpuFloorStage2({context: context(), admission: admission(),
            paths: paths(), probeArtifact: probeArtifact()}, benignFixture.op);
        assert.equal(benignResult.failure, "QEMU process did not complete cleanly");
    });

    it("rejects changed package bodies and an unbound probe artifact before media acquisition", async () => {
        const changedPackage = operations({acquirePackages: async input => {
            const result = {complete: true, packages: input.packageClosure.packages.map(value => ({reference:
                `${value.name}:${value.architecture}=${value.version}`, path: `${input.paths.packageRoot}/${value.name}.deb`,
            bytes: value.bytes, sha256: value.sha256}))};
            result.packages[0].sha256 = "0".repeat(64);
            return result;
        }});
        const changedResult = await runWindowsCpuFloorStage2({context: context(), admission: admission(), paths: paths(),
            probeArtifact: probeArtifact()}, changedPackage.op);
        assert.equal(changedResult.stage, "package-acquisition");
        assert.equal(changedResult.cleanupProven, false);
        assert.equal(changedPackage.calls.includes("acquire-iso"), false);

        const alteredArtifact = probeArtifact();
        alteredArtifact.artifactId = "0";
        const artifactFixture = operations();
        const artifactResult = await runWindowsCpuFloorStage2({context: context(), admission: admission(), paths: paths(),
            probeArtifact: alteredArtifact}, artifactFixture.op);
        assert.equal(artifactResult.stage, "probe-artifact");
        assert.equal(artifactFixture.calls.includes("acquire-probes"), false);
        assert.equal(artifactFixture.calls.includes("acquire-iso"), false);
    });

    it("validates guest failure evidence and rejects forged, observed or malformed receipts", () => {
        const valid = {schemaVersion: 1, status: "failed", nonce: NONCE,
            stage: "guest-bootstrap", failure: "probe execution failed"};
        const result = validateGuestFailure(valid, NONCE);
        assert.deepEqual(result, valid);
        assert.equal(Object.isFrozen(result), true);

        // Wrong nonce
        assert.throws(() => validateGuestFailure(valid, "wrong-nonce".padEnd(32, "0")), /guest failure/u);
        // Status observed is rejected on failed receipt
        assert.throws(() => validateGuestFailure({...valid, status: "observed"}, NONCE), /guest failure/u);
        // Wrong stage
        assert.throws(() => validateGuestFailure({...valid, stage: "guest-probe"}, NONCE), /guest failure/u);
        // Wrong schema version
        assert.throws(() => validateGuestFailure({...valid, schemaVersion: 2}, NONCE), /guest failure/u);
        // Control characters in failure message
        assert.throws(() => validateGuestFailure({...valid, failure: "bad\x00message"}, NONCE), /guest failure/u);
        // Extra keys
        assert.throws(() => validateGuestFailure({...valid, extra: "unauthorized"}, NONCE), /guest failure/u);
        // Missing failure message
        assert.throws(() => validateGuestFailure({...valid, failure: ""}, NONCE), /guest failure/u);
    });

    it("validates late-boot observations with bounded milestones and screenshots", () => {
        const lateScreenshots = [`${paths().root}/late-boot-1.png`, `${paths().root}/late-boot-2.png`];
        const valid = {
            schemaVersion: 1,
            kind: "qemu-late-boot-observation",
            displayAdvanced: false,
            milestones: [
                {
                    milestone: 1,
                    offsetMs: 120_000,
                    status: "running",
                    running: true,
                    screenshot: {
                        path: lateScreenshots[0],
                        bytes: String(PNG.length),
                        sha256: HASH(PNG),
                        bytesBase64: PNG.toString("base64")
                    }
                }
            ]
        };
        const validated = validateLateBoot(valid, paths());
        assert.deepEqual(validated, valid);
        assert.equal(Object.isFrozen(validated), true);

        // Invalid kind
        assert.throws(() => validateLateBoot({...valid, kind: "unknown"}, paths()), /late-boot/u);
        // Missing milestones
        assert.throws(() => validateLateBoot({...valid, milestones: []}, paths()), /late-boot/u);
        // Wrong screenshot path
        const badPath = structuredClone(valid);
        badPath.milestones[0].screenshot.path = "/tmp/late-boot-1.png";
        assert.throws(() => validateLateBoot(badPath, paths()), /late-boot/u);

        // The display-progress verdict is advisory and explicitly three-valued: a run whose sampled
        // frames never differed has to be readable as such, and a verdict that could not be formed
        // must stay null rather than borrow "did not advance". It is optional, so a failure record
        // retained before the field existed still replays; a malformed one is still rejected.
        const advanced = {...valid, displayAdvanced: true};
        assert.deepEqual(validateLateBoot(advanced, paths()), advanced);
        const undetermined = {...valid, displayAdvanced: null};
        assert.deepEqual(validateLateBoot(undetermined, paths()), undetermined);
        const missingVerdict = structuredClone(valid);
        delete missingVerdict.displayAdvanced;
        assert.deepEqual(validateLateBoot(missingVerdict, paths()), missingVerdict);
        assert.throws(() => validateLateBoot({...valid, displayAdvanced: "false"}, paths()), /late-boot/u);
    });

    it("instantiates typed GuestBootstrapError and QemuLaunchError with failure diagnostics", () => {
        const failureEvidence = {schemaVersion: 1, status: "failed", nonce: NONCE,
            stage: "guest-bootstrap", failure: "synthetic probe crash"};
        const early = earlyBoot();

        const guestErr = new GuestBootstrapError(failureEvidence, early);
        assert.equal(guestErr instanceof Error, true);
        assert.equal(guestErr.message, "guest bootstrap failed: synthetic probe crash");
        assert.deepEqual(guestErr.guestFailure, failureEvidence);
        assert.deepEqual(guestErr.earlyBoot, early);

        const diagnostic = {schemaVersion: 1, kind: "qemu-launch-failure-diagnostic", process: {exitCode: 1}};
        const launchErr = new QemuLaunchError(diagnostic, early, failureEvidence);
        assert.equal(launchErr instanceof Error, true);
        assert.equal(launchErr.message, "QEMU process did not complete cleanly");
        assert.deepEqual(launchErr.diagnostic, diagnostic);
        assert.deepEqual(launchErr.earlyBoot, early);
        assert.deepEqual(launchErr.guestFailure, failureEvidence);
    });

    it("enforces 25-minute diagnostic deadline contract in Stage 2 launch request", async () => {
        assert.deepEqual(STAGE2_DIAGNOSTIC_DEADLINES, {executionMinutes: 25, cleanupMinutes: 5});
        assert.equal(Object.isFrozen(STAGE2_DIAGNOSTIC_DEADLINES), true);

        let capturedDeadlines = null;
        const fixture = operations({
            launchOwnedQemu: async input => {
                capturedDeadlines = input.deadlines;
                return {
                    process: {
                        exitCode: 0, signal: null, timedOut: false, cleanupProven: true,
                        treeGone: true, qemuPid: 2345, qemuStartTicks: "77",
                        launcherExecutablePath: toolchain().runtime.loader.path,
                        processGroupId: 2300, qemuPidAbsentAfter: true, terminationReason: null
                    },
                    argv: input.argv,
                    earlyBoot: earlyBoot(),
                    guest: guestEvidence()
                };
            }
        });

        const result = await runWindowsCpuFloorStage2({
            context: context(), admission: admission(), paths: paths(),
            probeArtifact: probeArtifact()
        }, fixture.op);

        assert.equal(result.status, "observed");
        assert.deepEqual(capturedDeadlines, STAGE2_DIAGNOSTIC_DEADLINES);
    });

    it("propagates guest failure on clean QEMU exit without qemuLaunch", async () => {
        const failureEvidence = {schemaVersion: 1, status: "failed", nonce: NONCE,
            stage: "guest-bootstrap", failure: "probe execution failed"};
        const bootstrap = operations({
            launchOwnedQemu: async input => ({
                process: {
                    exitCode: 0, signal: null, timedOut: false, cleanupProven: true,
                    treeGone: true, qemuPid: 2345, qemuStartTicks: "77",
                    launcherExecutablePath: toolchain().runtime.loader.path,
                    processGroupId: 2300, qemuPidAbsentAfter: true, terminationReason: null
                },
                argv: input.argv,
                earlyBoot: earlyBoot(),
                guest: failureEvidence
            })
        });

        const result = await runWindowsCpuFloorStage2({
            context: context(), admission: admission(), paths: paths(),
            probeArtifact: probeArtifact()
        }, bootstrap.op);

        assert.equal(result.status, "failed");
        assert.equal(result.stage, "qemu-launch");
        assert.equal(result.cleanupProven, true);
        assert.equal(result.failure, "guest bootstrap failed: probe execution failed");
        assert.deepEqual(result.guestFailure, failureEvidence);
        assert.deepEqual(result.qemuEarlyBoot, earlyBoot());
        assert.equal("qemuLaunch" in result, false);
    });

    it("propagates guest failure on non-clean QEMU exit while preserving primary QEMU error", async () => {
        const failureEvidence = {schemaVersion: 1, status: "failed", nonce: NONCE,
            stage: "guest-bootstrap", failure: "bootstrap script timed out"};
        const stderr = Buffer.from("qemu error output\n");
        const process = {
            exitCode: 1, signal: null, timedOut: false, cleanupProven: true, treeGone: true,
            qemuPid: 2345, qemuStartTicks: "77", launcherExecutablePath: toolchain().runtime.loader.path,
            processGroupId: 2300, qemuPidAbsentAfter: true, terminationReason: null
        };
        const diagnostic = {
            schemaVersion: 1, kind: "qemu-launch-failure-diagnostic", process: structuredClone(process),
            processFlags: {errorObserved: false, stdoutOverflow: false, stderrOverflow: false},
            monitorFailure: null,
            stderr: {bytes: String(stderr.length), sha256: HASH(stderr), bytesBase64: stderr.toString("base64")}
        };

        const fixture = operations({
            launchOwnedQemu: async input => ({
                process,
                argv: input.argv,
                earlyBoot: earlyBoot(),
                guestFailure: failureEvidence,
                failureDiagnostic: diagnostic
            })
        });

        const result = await runWindowsCpuFloorStage2({
            context: context(), admission: admission(), paths: paths(),
            probeArtifact: probeArtifact()
        }, fixture.op);

        assert.equal(result.status, "failed");
        assert.equal(result.stage, "qemu-launch");
        assert.equal(result.cleanupProven, true);
        // Primary QEMU error preserved!
        assert.equal(result.failure, "QEMU process did not complete cleanly");
        assert.deepEqual(result.qemuLaunch, diagnostic);
        assert.deepEqual(result.guestFailure, failureEvidence);
        assert.deepEqual(result.qemuEarlyBoot, earlyBoot());
    });

    it("omits late boot diagnostic if candidate result exceeds aggregate 4MB envelope limit", async () => {
        const failureEvidence = {schemaVersion: 1, status: "failed", nonce: NONCE,
            stage: "guest-bootstrap", failure: "bootstrap script timed out"};
        const stderr = Buffer.from("qemu error output\n");
        const process = {
            exitCode: 1, signal: null, timedOut: false, cleanupProven: true, treeGone: true,
            qemuPid: 2345, qemuStartTicks: "77", launcherExecutablePath: toolchain().runtime.loader.path,
            processGroupId: 2300, qemuPidAbsentAfter: true, terminationReason: null
        };
        const diagnostic = {
            schemaVersion: 1, kind: "qemu-launch-failure-diagnostic", process: structuredClone(process),
            processFlags: {errorObserved: false, stdoutOverflow: false, stderrOverflow: false},
            monitorFailure: null,
            stderr: {bytes: String(stderr.length), sha256: HASH(stderr), bytesBase64: stderr.toString("base64")}
        };

        const largePng = Buffer.concat([PNG, Buffer.alloc(1_048_576 - PNG.length)]);
        const largePngBase64 = largePng.toString("base64");
        const largeEarly = {
            schemaVersion: 1,
            kind: "qemu-early-boot-observation",
            inputSent: false,
            version: {major: 8, minor: 2, micro: 2},
            status: "running",
            running: true,
            screenshots: [1, 2].map(index => ({
                path: `${paths().root}/early-boot-${index}.png`,
                bytes: String(largePng.length),
                sha256: HASH(largePng),
                bytesBase64: largePngBase64
            }))
        };
        const largeLate = {
            schemaVersion: 1,
            kind: "qemu-late-boot-observation",
            displayAdvanced: false,
            milestones: [
                {
                    milestone: 1,
                    offsetMs: 120_000,
                    status: "running",
                    running: true,
                    screenshot: {
                        path: `${paths().root}/late-boot-1.png`,
                        bytes: String(largePng.length),
                        sha256: HASH(largePng),
                        bytesBase64: largePngBase64
                    }
                },
                {
                    milestone: 2,
                    offsetMs: 300_000,
                    status: "running",
                    running: true,
                    screenshot: {
                        path: `${paths().root}/late-boot-2.png`,
                        bytes: String(largePng.length),
                        sha256: HASH(largePng),
                        bytesBase64: largePngBase64
                    }
                }
            ]
        };

        const fixture = operations({
            launchOwnedQemu: async input => ({
                process,
                argv: input.argv,
                earlyBoot: largeEarly,
                guestFailure: failureEvidence,
                failureDiagnostic: diagnostic,
                lateBoot: largeLate
            })
        });

        const result = await runWindowsCpuFloorStage2({
            context: context(), admission: admission(), paths: paths(),
            probeArtifact: probeArtifact()
        }, fixture.op);

        assert.equal(result.status, "failed");
        assert.equal(result.stage, "qemu-launch");
        assert.equal(result.cleanupProven, true);
        assert.equal(result.failure, "QEMU process did not complete cleanly");
        assert.deepEqual(result.qemuLaunch, diagnostic);
        assert.deepEqual(result.guestFailure, failureEvidence);
        assert.deepEqual(result.qemuEarlyBoot, largeEarly);
        // Omitted because aggregate candidate result exceeds 4MB
        assert.equal("qemuLateBoot" in result, false);
        const resultBytes = Buffer.byteLength(`${JSON.stringify(result)}\n`, "utf8");
        assert.equal(resultBytes <= MAX_STAGE2_RESULT_BYTES, true);
    });

    it("includes late boot diagnostic when candidate result fits within aggregate 4MB envelope limit", async () => {
        const failureEvidence = {schemaVersion: 1, status: "failed", nonce: NONCE,
            stage: "guest-bootstrap", failure: "bootstrap script timed out"};
        const stderr = Buffer.from("qemu error output\n");
        const process = {
            exitCode: 1, signal: null, timedOut: false, cleanupProven: true, treeGone: true,
            qemuPid: 2345, qemuStartTicks: "77", launcherExecutablePath: toolchain().runtime.loader.path,
            processGroupId: 2300, qemuPidAbsentAfter: true, terminationReason: null
        };
        const diagnostic = {
            schemaVersion: 1, kind: "qemu-launch-failure-diagnostic", process: structuredClone(process),
            processFlags: {errorObserved: false, stdoutOverflow: false, stderrOverflow: false},
            monitorFailure: null,
            stderr: {bytes: String(stderr.length), sha256: HASH(stderr), bytesBase64: stderr.toString("base64")}
        };

        const smallLate = {
            schemaVersion: 1,
            kind: "qemu-late-boot-observation",
            displayAdvanced: false,
            milestones: [
                {
                    milestone: 1,
                    offsetMs: 120_000,
                    status: "running",
                    running: true,
                    screenshot: {
                        path: `${paths().root}/late-boot-1.png`,
                        bytes: String(PNG.length),
                        sha256: HASH(PNG),
                        bytesBase64: PNG.toString("base64")
                    }
                }
            ]
        };

        const fixture = operations({
            launchOwnedQemu: async input => ({
                process,
                argv: input.argv,
                earlyBoot: earlyBoot(),
                guestFailure: failureEvidence,
                failureDiagnostic: diagnostic,
                lateBoot: smallLate
            })
        });

        const result = await runWindowsCpuFloorStage2({
            context: context(), admission: admission(), paths: paths(),
            probeArtifact: probeArtifact()
        }, fixture.op);

        assert.equal(result.status, "failed");
        assert.equal(result.stage, "qemu-launch");
        assert.equal(result.cleanupProven, true);
        assert.equal(result.failure, "QEMU process did not complete cleanly");
        assert.deepEqual(result.qemuLaunch, diagnostic);
        assert.deepEqual(result.guestFailure, failureEvidence);
        assert.deepEqual(result.qemuEarlyBoot, earlyBoot());
        // Attached because candidate result fits within 4MB
        assert.equal("qemuLateBoot" in result, true);
        assert.deepEqual(result.qemuLateBoot, smallLate);
        const resultBytes = Buffer.byteLength(`${JSON.stringify(result)}\n`, "utf8");
        assert.equal(resultBytes <= MAX_STAGE2_RESULT_BYTES, true);
    });

    it("ensures successful Stage 2 result keys match exact baseline schema without extra diagnostic keys", async () => {
        const fixture = operations();
        const result = await runWindowsCpuFloorStage2({
            context: context(), admission: admission(), paths: paths(),
            probeArtifact: probeArtifact()
        }, fixture.op);

        assert.equal(result.status, "observed");
        assert.equal(result.cpuCalibrationAccepted, true);
        assert.equal("guestFailure" in result, false);
        assert.equal("qemuLateBoot" in result, false);
        assert.equal("failureDiagnostic" in result, false);
        assert.equal("qemuLaunch" in result, false);

        const actualKeys = Object.keys(result).sort();
        for (const forbidden of ["guestFailure", "qemuLateBoot", "failureDiagnostic", "qemuLaunch"]) {
            assert.equal(actualKeys.includes(forbidden), false);
        }
    });
});

describe("hosted Windows CPU-floor Stage 2 WinPE answer-file diagnostic", () => {
    const DIAGNOSTIC_AUTHORIZATION = {confirmation: "winpe-answer-file-diagnostic-v1", nonce: NONCE};
    const DIAGNOSTIC_CLASSIFICATION =
        "github-hosted-windows-cpu-floor-winpe-answer-file-diagnostic-nonqualifying";
    const ADMITTED = {reservation: {label: "winpe-answer-file-diagnostic",
        executionMilliseconds: 360_000, cleanupMilliseconds: 300_000},
    collectionDeadlineMilliseconds: 720_000};
    const diagnosticEvidence = () => ({schemaVersion: 1, kind: "winpe-answer-file-diagnostic",
        nonce: NONCE, confirmation: "winpe-answer-file-diagnostic-v1", input: null,
        collection: {schemaVersion: 1, kind: "winpe-answer-file-diagnostic-collection",
            status: "capture-complete", outputDiskVerified: true, failure: null, members: []}});

    function diagnosticOperations() {
        const fixture = operations();
        fixture.op.launchOwnedQemu = async input => {
            fixture.calls.push("launch");
            fixture.seen.launch = input;
            return {process: {exitCode: null, signal: "SIGKILL", timedOut: true, cleanupProven: true,
                treeGone: true, qemuPid: 2345, qemuStartTicks: "77",
                launcherExecutablePath: toolchain().runtime.loader.path, processGroupId: 2300,
                qemuPidAbsentAfter: true, terminationReason: "deadline"},
            argv: input.argv, earlyBoot: earlyBoot(), guest: null,
            winpeDiagnostic: diagnosticEvidence()};
        };
        return fixture;
    }

    it("launches on a reservation rather than the CPU diagnostic deadlines, and returns a diagnostic record", async () => {
        const fixture = diagnosticOperations();
        const result = await runWindowsCpuFloorStage2({context: context(), admission: admission(),
            paths: paths(), probeArtifact: probeArtifact(), winpeDiagnostic: DIAGNOSTIC_AUTHORIZATION,
            admitWinpeDiagnostic: () => ADMITTED}, fixture.op);
        /* The two budget mechanisms never travel together. */
        assert.equal(fixture.seen.launch.deadlines, undefined);
        assert.deepEqual(fixture.seen.launch.reservation, {label: "winpe-answer-file-diagnostic",
            executionMilliseconds: 360_000, cleanupMilliseconds: 300_000});
        assert.deepEqual(fixture.seen.launch.winpeDiagnostic, DIAGNOSTIC_AUTHORIZATION);
        assert.equal(result.status, "diagnostic");
        assert.equal(result.stage, "winpe-answer-file-diagnostic");
        assert.equal(result.classification, DIAGNOSTIC_CLASSIFICATION);
        assert.equal(result.qualifying, false);
        assert.equal(result.releaseGateCleared, false);
        assert.equal(result.cpuCalibrationAccepted, false);
        assert.equal(result.cleanupProven, true);
        assert.deepEqual(result.context, context());
        assert.deepEqual(result.winpeDiagnostic, diagnosticEvidence());
        /* No guest receipt exists on this path and none is invented. */
        assert.equal("guest" in result, false);
        assert.equal("installWim" in result, false);
        assert.equal("media" in result, false);
    });

    it("seeds the diagnostic script and its marker only when the diagnostic is authorized", async () => {
        const plain = operations();
        await runWindowsCpuFloorStage2({context: context(), admission: admission(), paths: paths(),
            probeArtifact: probeArtifact()}, plain.op);
        const plainNames = plain.seen.seedSpec.files.map(file => file.name);
        assert.equal(plainNames.includes("seed.tag"), false);
        assert.equal(plainNames.some(name => /^[a-f0-9]{8}\.cmd$/u.test(name)), false);
        assert.equal(plain.seen.media.winpeDiagnostic, undefined);

        const fixture = diagnosticOperations();
        await runWindowsCpuFloorStage2({context: context(), admission: admission(), paths: paths(),
            probeArtifact: probeArtifact(), winpeDiagnostic: DIAGNOSTIC_AUTHORIZATION,
            admitWinpeDiagnostic: () => ADMITTED}, fixture.op);
        const names = fixture.seen.seedSpec.files.map(file => file.name);
        assert.equal(names.includes("seed.tag"), true);
        assert.equal(names.filter(name => /^[a-f0-9]{8}\.cmd$/u.test(name)).length, 1);
        assert.deepEqual(fixture.seen.media.winpeDiagnostic, DIAGNOSTIC_AUTHORIZATION);
        /* Everything the ordinary seed carried is still there, in the same order. */
        assert.deepEqual(names.slice(0, plainNames.length), plainNames);
        const script = fixture.seen.seedSpec.files.find(file => /^[a-f0-9]{8}\.cmd$/u.test(file.name));
        const body = Buffer.from(script.bytesBase64, "base64").toString("ascii");
        assert.ok(body.includes(`MYSPEEDSEED ${NONCE}`));
        assert.ok(body.includes("setlocal EnableExtensions DisableDelayedExpansion"));
        assert.equal(script.sha256, HASH(Buffer.from(script.bytesBase64, "base64")));
    });

    it("keeps a diagnostic result inside the retained bound by dropping frames before evidence", async () => {
        const huge = {...diagnosticEvidence(), collection: {...diagnosticEvidence().collection,
            members: [{name: "MSACT.LOG", role: "setup-action-log", status: "captured",
                acceptedBytes: 131_072, readCapReached: false, encoding: "utf-8", bom: false,
                trailingOddByte: false, decodeReplacements: 0, redactionHits: 0, partialRedactionHits: 0,
                publishedBytes: 131_072, publicationTruncated: false,
                sha256: HASH(Buffer.alloc(131_072, 0x41)),
                textBase64: Buffer.alloc(131_072, 0x41).toString("base64")}]}};
        const oversizedFrame = Buffer.concat([PNG, Buffer.alloc(1_048_576 - PNG.length, 0x42)]);
        const fixture = diagnosticOperations();
        const inner = fixture.op.launchOwnedQemu;
        fixture.op.launchOwnedQemu = async input => {
            const observation = await inner(input);
            observation.winpeDiagnostic = huge;
            observation.earlyBoot = {...earlyBoot(), screenshots: earlyBoot().screenshots.map(shot => ({
                ...shot, bytes: String(oversizedFrame.length), sha256: HASH(oversizedFrame),
                bytesBase64: oversizedFrame.toString("base64")}))};
            return observation;
        };
        const result = await runWindowsCpuFloorStage2({context: context(), admission: admission(),
            paths: paths(), probeArtifact: probeArtifact(), winpeDiagnostic: DIAGNOSTIC_AUTHORIZATION,
            admitWinpeDiagnostic: () => ADMITTED}, fixture.op);
        assert.equal(result.status, "diagnostic");
        assert.equal(result.winpeDiagnostic.collection.members.length, 1,
            "the collected guest log is the point of the run and is never the thing dropped");
        assert.ok(Buffer.byteLength(`${JSON.stringify(result)}\n`, "utf8") <= MAX_STAGE2_RESULT_BYTES);
    });
});

describe("hosted Windows CPU-floor Stage 2 diagnostic record reaches no calibration consumer", () => {
    const ADMITTED = {reservation: {label: "winpe-answer-file-diagnostic",
        executionMilliseconds: 360_000, cleanupMilliseconds: 300_000},
    collectionDeadlineMilliseconds: 720_000};

    it("is refused by the real MSI installed-base sealer before any sealing operation runs", async () => {
        const fixture = operations();
        fixture.op.launchOwnedQemu = async input => ({
            process: {exitCode: null, signal: "SIGKILL", timedOut: true, cleanupProven: true,
                treeGone: true, qemuPid: 2345, qemuStartTicks: "77",
                launcherExecutablePath: toolchain().runtime.loader.path, processGroupId: 2300,
                qemuPidAbsentAfter: true, terminationReason: "deadline"},
            argv: input.argv, earlyBoot: earlyBoot(), guest: null,
            winpeDiagnostic: {schemaVersion: 1, kind: "winpe-answer-file-diagnostic", nonce: NONCE,
                confirmation: "winpe-answer-file-diagnostic-v1", input: null,
                collection: {schemaVersion: 1, kind: "winpe-answer-file-diagnostic-collection",
                    status: "inconclusive", outputDiskVerified: true,
                    failure: "the guest completion marker was not collected", members: []}}});
        const diagnosticResult = await runWindowsCpuFloorStage2({context: context(),
            admission: admission(), paths: paths(), probeArtifact: probeArtifact(),
            winpeDiagnostic: {confirmation: "winpe-answer-file-diagnostic-v1", nonce: NONCE},
            admitWinpeDiagnostic: () => ADMITTED}, fixture.op);
        assert.equal(diagnosticResult.status, "diagnostic");
        const calls = [];
        const sealOperations = Object.fromEntries(
            ["inspectFile", "inspectQcow2", "observeQemuGroup", "sealExact"]
                .map(name => [name, async () => { calls.push(name); return {}; }]));
        await assert.rejects(sealSameJobInstalledBase({expectedContext: context(), paths: paths(),
            stage2Result: diagnosticResult}, sealOperations));
        assert.deepEqual(calls, [], "no sealing operation may run for a diagnostic record");
    });

    it("keeps the truncated-serial attribution within the failure-message length contract", () => {
        const shortResult = attributeTruncatedSerialFailure("boom");
        assert.equal(shortResult, `boom (${EFI_SHELL_TRUNCATED_ATTRIBUTION})`);
        // A message already at the cap must not push the attributed failure past the 512-character contract that
        // validateGuestFailure enforces; the message is trimmed to reserve room for the suffix.
        const longResult = attributeTruncatedSerialFailure("x".repeat(MAX_GUEST_FAILURE_MESSAGE_CHARACTERS + 100));
        assert.ok(longResult.length <= MAX_GUEST_FAILURE_MESSAGE_CHARACTERS, `length ${longResult.length}`);
        assert.ok(longResult.endsWith(`(${EFI_SHELL_TRUNCATED_ATTRIBUTION})`));
    });
});
