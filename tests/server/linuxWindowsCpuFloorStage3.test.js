import assert from "node:assert/strict";
import crypto from "node:crypto";
import {describe, it} from "node:test";

import {
    admitStage3Reservation,
    anchorStage3JobBudget,
    buildBaselineQemuArguments,
    buildStage3LaunchDiagnostic,
    buildStage3LaunchFailure,
    runWindowsCpuFloorStage3,
    validateBaselineGuestResult,
    validateCompletedStage3Result,
    STAGE3_BUDGET_CONSTANTS,
    STAGE3_LAUNCH_CLASSIFICATIONS,
    STAGE3_LAUNCH_DIAGNOSTIC_CONSTANTS
} from "../../scripts/qualification/linux-windows-cpu-floor-stage3.mjs";
import {POST_COMPLETION_TERMINATION_REASON, STAGE3_BASELINE_RESERVATION_LABEL} from
    "../../scripts/qualification/linux-windows-cpu-floor-stage2-hosted.mjs";
import {STAGE3_CONTROLLER_CONSTANTS} from
    "../../scripts/qualification/linux-windows-cpu-floor-stage3-controller.mjs";
import {PACKAGE_ROOTS, STAGE2_PROVENANCE, TOP_LEVEL_PACKAGE_PINS, WINDOWS_SYSTEM_TOOL_PATHS,
    buildQemuArguments as buildStage2QemuArguments,
    validatePackageClosure} from "../../scripts/qualification/linux-windows-cpu-floor-stage2.mjs";
import {createHostedStage2Operations} from "../../scripts/qualification/linux-windows-cpu-floor-stage2-hosted.mjs";
import {buildWindowsMsiSetupCompleteActivation, getCompletedWindowsMsiActivationEvidence} from
    "../../scripts/qualification/windows-msi-post-setup-activation.mjs";

const SHA = character => character.repeat(64);
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
const PNG_HASH = crypto.createHash("sha256").update(PNG).digest("hex");
const SOURCE_SHA = "1".repeat(40);
const CANDIDATE_SOURCE_SHA = "4".repeat(40);
const NONCE = "2".repeat(32);
const ROOT = `/home/runner/work/_temp/myspeed-stage3-${NONCE}`;
const STAGE2_ROOT = `/home/runner/work/_temp/myspeed-windows-cpu-floor-${NONCE}`;
const PORTABLE_ROOT = `/tmp/myspeed-windows-cpu-floor-tools-${NONCE}`;
const OVERSIZED_BASE64_CHARACTERS = 6 * 1024 * 1024;
const context = () => ({schemaVersion: 1, repository: "i7Gamer/MySpeed", sourceSha: SOURCE_SHA,
    eventSha: "3".repeat(40), runId: "123", runAttempt: "1", nonce: NONCE, environment: {
        GITHUB_ACTIONS: "true", CI: "true", RUNNER_OS: "Linux", RUNNER_ARCH: "X64",
        RUNNER_ENVIRONMENT: "github-hosted", ImageOS: "ubuntu24", ImageVersion: "20260901.1"}});
const identity = (name, character = "a", bytes = 4096) =>
    ({path: `${ROOT}/${name}`, bytes: String(bytes), sha256: SHA(character)});

const ownership = () => ({uid: "0", gid: "0", mode: "555", ordinaryUserWritable: false});
const portable = (relative, character = "a", invocation = null) => ({path: `${PORTABLE_ROOT}/${relative}`,
    bytes: "4096", sha256: SHA(character), ownership: ownership(), ...(invocation === null ? {} :
        {invocationPath: `${PORTABLE_ROOT}/${invocation}`})});
const toolchain = () => ({
    capabilities: {accelerator: "kvm", cpuModels: ["Westmere-v2"], machines: ["q35"],
        devices: ["ich9-ahci", "ide-cd", "ide-hd", "isa-serial", "VGA", "qemu-xhci", "usb-kbd"]},
    genisoimage: portable("usr/bin/genisoimage", "1", "usr/bin/genisoimage"),
    installedFilesManifest: {bytes: "8192", sha256: SHA("2")}, licensesManifest: {bytes: "8192", sha256: SHA("3")},
    mcopy: portable("usr/bin/mtools", "4", "usr/bin/mcopy"), mformat: portable("usr/bin/mtools", "4", "usr/bin/mformat"),
    ovmfCode: portable("usr/share/OVMF/OVMF_CODE.fd", "5"),
    ovmfVarsTemplate: portable("usr/share/OVMF/OVMF_VARS.fd", "6"),
    firmware: {searchPath: `${PORTABLE_ROOT}/usr/share/qemu`,
        kvmvapic: portable("usr/share/qemu/kvmvapic.bin", "e"),
        vga: portable("usr/share/seabios/vgabios-stdvga.bin", "e")},
    packageClosureSha256: crypto.createHash("sha256").update(JSON.stringify(validatePackageClosure(packageClosure())))
        .digest("hex"),
    qemu: {...portable("usr/bin/qemu-system-x86_64", "8", "usr/bin/qemu-system-x86_64"),
        version: "QEMU emulator version 8.2.2 (Debian 1:8.2.2+ds-0ubuntu1.18)"},
    qemuImg: portable("usr/bin/qemu-img", "9", "usr/bin/qemu-img"),
    runtime: {loader: portable("usr/lib/x86_64-linux-gnu/ld-linux-x86-64.so.2", "a"),
        libraryPath: [`${PORTABLE_ROOT}/usr/lib/x86_64-linux-gnu`, `${PORTABLE_ROOT}/usr/lib/7-zip`]},
    sevenZip: portable("usr/lib/7-zip/7z.so", "b", "usr/lib/7-zip/7z.so"),
    wiminfo: portable("usr/bin/wimlib-imagex", "c", "usr/bin/wiminfo")
});
const rawPackageClosure = () => ({schemaVersion: 1, snapshot: structuredClone(STAGE2_PROVENANCE.ubuntuSnapshot),
    roots: [...PACKAGE_ROOTS], indexes: [{suite: "noble", component: "main", architecture: "amd64",
        path: "dists/noble/main/binary-amd64/Packages.xz", bytes: "100", sha256: SHA("1"),
        listedSha256: SHA("1"), inReleaseSha256: SHA("3")},
    {suite: "noble-updates", component: "universe", architecture: "amd64",
        path: "dists/noble-updates/universe/binary-amd64/Packages.xz", bytes: "101", sha256: SHA("2"),
        listedSha256: SHA("2"), inReleaseSha256: SHA("4")}], releases: [
        {suite: "noble", inReleasePath: "dists/noble/InRelease", bytes: "200", sha256: SHA("3"),
            signatureVerified: true, signerFingerprint: STAGE2_PROVENANCE.ubuntuArchiveSignerFingerprint},
        {suite: "noble-updates", inReleasePath: "dists/noble-updates/InRelease", bytes: "201", sha256: SHA("4"),
            signatureVerified: true, signerFingerprint: STAGE2_PROVENANCE.ubuntuArchiveSignerFingerprint}],
    packages: TOP_LEVEL_PACKAGE_PINS.map(value => ({...value, dependsOn: []}))});
const packageClosure = () => structuredClone(validatePackageClosure(rawPackageClosure()));
const probeRoles = ["avx", "avx2", "cpuid", "illegal", "known-bad", "known-good", "popcnt", "sse42"];
const probeArtifact = () => ({schemaVersion: 1, repository: "i7Gamer/MySpeed", sourceSha: "9".repeat(40),
    runId: "34763667695", runAttempt: "1", artifactId: "1234567890",
    artifactName: "windows-cpu-readiness-evidence", archive: {bytes: "33554432", sha256: SHA("a")},
    innerManifest: {name: "result.json", bytes: "262144", sha256: SHA("b")}, files: probeRoles.map((role,
    index) => ({role, name: `${role.replaceAll("-", "_")}.exe`, bytes: String(4096 + index),
        sha256: String(index + 1).repeat(64).slice(0, 64)}))});
const acquiredProbes = () => ({archive: probeArtifact().archive, innerManifest: probeArtifact().innerManifest,
    files: probeArtifact().files.map(value => ({...value, path: `${STAGE2_ROOT}/probes/${value.name}`}))});

const stage2Observation = () => ({
    schemaVersion: 1, status: "observed", stage: "complete",
    classification: "github-hosted-windows-cpu-floor-stage2-calibration-nonqualifying", qualifying: false,
    releaseGateCleared: false, cpuCalibrationAccepted: true, cleanupProven: true, context: context(),
    privilegeMode: "reviewed-sudo-kvm",
    earlyBoot: {
        schemaVersion: 1,
        kind: "qemu-early-boot-observation",
        inputSent: false,
        version: {major: 8, minor: 2, micro: 2},
        status: "running",
        running: true,
        screenshots: [1, 2].map(index => ({
            path: `${STAGE2_ROOT}/early-boot-${index}.png`,
            bytes: String(PNG.length),
            sha256: PNG_HASH,
            bytesBase64: PNG.toString("base64")
        }))
    },
    qemuProcess: {cleanupProven: true, treeGone: true,
        qemuPidAbsentAfter: true, exitCode: 0, signal: null, timedOut: false, qemuPid: 2200,
        qemuStartTicks: "123456", processGroupId: 2200, launcherExecutablePath:
        `${PORTABLE_ROOT}/usr/lib/x86_64-linux-gnu/ld-linux-x86-64.so.2`, terminationReason: null},
    guest: {schemaVersion: 1, status: "observed", cpu: {sse42: true, popcnt: true, avx: false, avx2: false,
        osxsave: false, xcr0: null}, instructions: {sse42: "completed", popcnt: "completed",
        avx: "illegal-instruction", avx2: "illegal-instruction"}, network: {hardwareNics: 0,
        enabledNonLoopbackInterfaces: 0, nonLoopbackRoutes: 0},
        activation: activationEvidence(),
        systemTools: systemTools(),
        output: {path: `${STAGE2_ROOT}/output.img`,
        bytes: "67108864", sha256: SHA("0")}},
    argv: buildStage2QemuArguments({paths: stage2Paths(), toolchain: toolchain()}),
    packageClosure: packageClosure(), probeArtifact: probeArtifact(), probes: acquiredProbes(),
    installWim: {path: `${STAGE2_ROOT}/install.wim`, sourceIsoSha256: SHA("d"), bytes: "5000000000",
        sha256: SHA("5")}, installWimRemoval: {path: `${STAGE2_ROOT}/install.wim`, sha256: SHA("5"), removed: true},
    media: {seedIso: {path: `${STAGE2_ROOT}/seed.iso`, bytes: "1048576", sha256: SHA("8"),
        sourceManifestSha256: SHA("6"), format: "iso9660", volumeLabel: "MYSPEEDSEED"},
    outputDisk: {path: `${STAGE2_ROOT}/output.img`, bytes: "67108864", sha256: SHA("7"), format: "raw-fat",
        volumeLabel: "MYSPEEDOUT"}, systemDisk: {path: `${STAGE2_ROOT}/system.qcow2`, bytes: "196616",
        sha256: SHA("3"), virtualBytes: "51539607552", format: "qcow2"},
    ovmfVars: {path: `${STAGE2_ROOT}/OVMF_VARS.fd`, sha256: toolchain().ovmfVarsTemplate.sha256}},
    iso: {bytes: "8152356864",
        etag: '"0x60A8C190FBB54AF58E40BA049FF290D098101E0EAD343CE912A1DC685219BE85"',
        finalUrl: "https://software-static.download.prss.microsoft.com/dbazure/998969d5-f34g-4e03-ac9d-1f9786c66749/26100.32230.260111-0550.lt_release_svc_refresh_SERVER_EVAL_x64FRE_en-us.iso",
        sha256: SHA("d"), digestProvenance: "windows-official-https-local-digest", publisherDigestMatched: null},
    selectedImage: {architecture: "x64", editionId: "ServerStandardEval", index: 2,
        installationType: "Server", name: "Windows Server 2025 SERVERSTANDARD",
        totalBytes: "15000000000"}, toolchain: toolchain()});
const activationEvidence = () => { const value = context(); return getCompletedWindowsMsiActivationEvidence(
    buildWindowsMsiSetupCompleteActivation({repository: value.repository, sourceSha: value.sourceSha,
        eventSha: value.eventSha, runId: value.runId, runAttempt: value.runAttempt, nonce: value.nonce})); };
const systemTools = () => WINDOWS_SYSTEM_TOOL_PATHS.map((tool, index) => ({...tool, bytes: String(index + 1),
    sha256: String(index + 1).repeat(64)}));

const rawStage2Guest = () => {
    const cpuid = rawCpuid();
    const control = {"known-good": 42, "known-bad": 13, sse42: 2_276_049_685, popcnt: 32};
    const runs = [{role: "cpuid", exitCode: 0,
        stdoutBase64: Buffer.from(`${JSON.stringify(cpuid)}\n`).toString("base64"), stderrBase64: ""},
    ...Object.entries(control).map(([role, result]) => ({role, exitCode: role === "known-bad" ? 19 : 0,
        stdoutBase64: Buffer.from(`${JSON.stringify({schemaVersion: 1, kind: role, result})}\n`).toString("base64"),
        stderrBase64: ""})), ...["illegal", "avx", "avx2"].map(role => ({role, exitCode: 3_221_225_501,
        stdoutBase64: "", stderrBase64: ""}))];
    return {schemaVersion: 1, nonce: NONCE, runs,
        network: {hardwareNics: 0, enabledNonLoopbackInterfaces: 0, nonLoopbackRoutes: 0},
        activation: activationEvidence(), systemTools: systemTools()};
};
const stage2GuestEvidence = () => {
    const encoded = encodedJson(rawStage2Guest());
    return {identity: {path: `/home/runner/work/_temp/myspeed-stage2-transport-${NONCE}/guest-result.json`,
        bytes: String(Buffer.from(encoded.bytesBase64, "base64").length), sha256: encoded.sha256},
    bytesBase64: encoded.bytesBase64};
};
const stage2 = () => ({result: {path: `/home/runner/work/_temp/myspeed-stage2-transport-${NONCE}/stage2-result.json`,
    bytes: "65536", sha256: SHA("b")}, guestResult: stage2GuestEvidence().identity});

const candidate = () => ({
    artifactId: "563103679",
    artifactName: "MySpeed-windows-x64-baseline.exe",
    releaseAssetId: "563103679",
    releaseAssetDigest: `sha256:${SHA("d")}`,
    archive: {bytes: "1048576", sha256: SHA("c")},
    sourceSha: CANDIDATE_SOURCE_SHA,
    runId: "34829932391",
    runAttempt: "1",
    tagName: "v1.6.1",
    file: {name: "MySpeed.exe", bytes: "524288", sha256: SHA("d")},
    qualificationSummary: {name: "qualification-summary.json", bytes: "8192", sha256: SHA("e")},
    manifest: {name: "qualification-manifest.json", bytes: "65536", sha256: SHA("f")}});

const paths = () => ({root: ROOT, systemDisk: `${ROOT}/stage3.qcow2`,
    seedIso: `${ROOT}/baseline-seed.iso`, outputDisk: `${ROOT}/baseline-output.img`,
    ovmfVars: `${ROOT}/OVMF_VARS.fd`, qemuPid: `${ROOT}/baseline-qemu.pid`,
    serialLog: `${ROOT}/baseline-serial.log`});
const stage2Paths = () => ({root: STAGE2_ROOT, packageRoot: `${STAGE2_ROOT}/packages`, portableRoot: PORTABLE_ROOT,
    windowsIso: `${STAGE2_ROOT}/windows.iso`, installWim: `${STAGE2_ROOT}/install.wim`,
    seedIso: `${STAGE2_ROOT}/seed.iso`, outputDisk: `${STAGE2_ROOT}/output.img`,
    systemDisk: `${STAGE2_ROOT}/system.qcow2`, ovmfVars: `${STAGE2_ROOT}/OVMF_VARS.fd`,
    serialLog: `${STAGE2_ROOT}/serial.log`, probeRoot: `${STAGE2_ROOT}/probes`,
    qemuPid: `${STAGE2_ROOT}/qemu.pid`});

const WALL_DEADLINE_MILLISECONDS = Date.parse("2026-09-16T13:20:00Z");
const budget = () => ({label: "cpu-floor-stage3-baseline",
    wallDeadlineUnixMilliseconds: WALL_DEADLINE_MILLISECONDS});
const reservationProof = () => ({label: "cpu-floor-stage3-baseline",
    executionMilliseconds: 55 * 60_000, cleanupMilliseconds: 2 * 60_000});

const request = () => ({schemaVersion: 1, context: context(), profile: "baseline-cpu",
    authorization: {scope: "windows-baseline-cpu-floor-full-runtime", qemu: true, candidate: true,
        confirmation: "RUN-WINDOWS-BASELINE-CPU-FLOOR"}, budget: budget(), stage2: stage2(),
    candidate: candidate(), paths: paths()});

const fullSummary = () => ({status: "passed", exit: 0, mode: "full", sourceSha: CANDIDATE_SOURCE_SHA,
    artifactSha256: SHA("d"), platform: "win32", architecture: "x64",
    command: ["C:\\MyspeedStage3\\candidate\\MySpeed.exe"],
    processes: [{scenario: "populated-first-boot", pid: 100}, {scenario: "populated-restart", pid: 101},
        {scenario: "fresh-no-config-reset", pid: 102}],
    databaseChecks: ["preseeded-input", "after-first-shutdown", "after-second-shutdown"].map(scenario =>
        ({scenario, ping: "123.456", resultId: "qualification-seed-row", passwordValueSha256: SHA("6")}))
        .concat([{scenario: "fresh-no-config-reset", integrity: "ok", configTable: false}]),
    openGraphChecks: [{scenario: "populated-first-boot", elapsedMs: 10},
        {scenario: "populated-restart", elapsedMs: 12}],
    networkIsolation: {kind: "qemu-nic-none-windows-guest", hardwareNics: 0,
        enabledNonLoopbackInterfaces: 0, nonLoopbackRoutes: 0},
    shutdownProofs: ["populated-first-boot", "populated-restart", "fresh-no-config-reset"].map(scenario =>
        ({scenario, controllerLifecyclePassed: true, candidateExited: true,
            candidateExitCode: scenario === "fresh-no-config-reset" ? 113 : 0,
            forced: false, jobActiveProcesses: 0, handlesClosed: true}))});

const encodedJson = value => {
    const bytes = Buffer.from(`${JSON.stringify(value)}\n`, "utf8");
    return {bytesBase64: bytes.toString("base64"), sha256: crypto.createHash("sha256").update(bytes).digest("hex")};
};

const rawCpuid = () => ({schemaVersion: 1, kind: "cpuid", maxBasicLeaf: 7,
    leaf1: {eax: "0x00000000", ebx: "0x00000000", ecx: "0x00900000", edx: "0x00000000"},
    leaf7Subleaf0: {eax: "0x00000000", ebx: "0x00000000", ecx: "0x00000000", edx: "0x00000000"},
    xcr0: null, features: {sse42: true, popcnt: true, osxsave: false, avx: false, avx2: false}});

const guestResult = () => {
    const cpuid = encodedJson(rawCpuid());
    const summary = fullSummary();
    const summaryEncoding = encodedJson(summary);
    return {schemaVersion: 1, status: "observed", profile: "baseline-cpu", cleanupProven: true,
        context: context(), candidate: {sourceSha: CANDIDATE_SOURCE_SHA, sha256: SHA("d"),
            artifactName: "MySpeed-windows-x64-baseline.exe"},
        cpu: {model: "Westmere-v2", cpuidBytesBase64: cpuid.bytesBase64, cpuidSha256: cpuid.sha256,
            sse42: true, popcnt: true, avx: false, avx2: false, osxsave: false, xcr0: null},
        network: {hardwareNics: 0, enabledNonLoopbackInterfaces: 0, nonLoopbackRoutes: 0},
        verifier: {summary, summaryBytesBase64: summaryEncoding.bytesBase64,
            summarySha256: summaryEncoding.sha256}, releaseGatesCleared: []};
};
const collectedGuestResult = () => {
    const result = guestResult();
    const encoded = encodedJson(result);
    return {identity: {path: `${ROOT}/baseline-result.json`, bytes: String(Buffer.from(encoded.bytesBase64, "base64").length),
        sha256: encoded.sha256}, bytesBase64: encoded.bytesBase64, result,
    sourceOutputDisk: identity("baseline-output.img", "0", 67_108_864)};
};

const earlyBootObservation = () => ({schemaVersion: 1, kind: "qemu-early-boot-observation", inputSent: false,
    version: {major: 8, minor: 2, micro: 2}, status: "running", running: true,
    screenshots: [1, 2].map(index => ({path: `${ROOT}/early-boot-${index}.png`, bytes: String(PNG.length),
        sha256: PNG_HASH, bytesBase64: PNG.toString("base64")}))});

const processProof = () => ({exitCode: 0, signal: null, timedOut: false, cleanupProven: true,
    treeGone: true, qemuPid: 1200, qemuStartTicks: "123456", processGroupId: 1200,
    qemuPidAbsentAfter: true, launcherExecutablePath: toolchain().runtime.loader.path,
    terminationReason: null});

function operations(overrides = {}) {
    const calls = [];
    return {calls, value: {
        async replayStage2(input) { calls.push("stage2"); return {identity: input.identity,
            result: stage2Observation(), guestEvidence: stage2GuestEvidence()}; },
        async acquireCandidate(input) { calls.push("candidate"); return {candidate: input.candidate,
            stagedFile: {...input.candidate.file, path: `${ROOT}/candidate/MySpeed.exe`},
            stagedSummary: {...input.candidate.qualificationSummary,
                path: `${ROOT}/candidate/qualification-summary.json`},
            stagedManifest: {...input.candidate.manifest,
                path: `${ROOT}/candidate/qualification-manifest.json`}}; },
        async prepareBaselineMedia() { calls.push("media"); return {seedIso: identity("baseline-seed.iso", "8"),
            outputDisk: identity("baseline-output.img", "9", 67_108_864),
            systemDisk: {...identity("stage3.qcow2", "a", 8_388_608), virtualBytes: "51539607552"},
            ovmfVars: identity("OVMF_VARS.fd", "b")}; },
        async launchBaselineGuest(input) { calls.push("launch"); return {argv: input.argv,
            process: processProof(), earlyBoot: earlyBootObservation(), reservation: reservationProof(),
            outputDisk: identity("baseline-output.img", "0", 67_108_864)}; },
        async collectBaselineGuestResult() { calls.push("collect"); return collectedGuestResult(); },
        ...overrides
    }};
}

describe("Windows CPU-floor Stage 3 baseline qualification core", () => {
    it("renders one explicit NIC-free Westmere-v2 vector with AVX disabled", () => {
        const argv = buildBaselineQemuArguments({paths: paths(), toolchain: toolchain(),
            windowsIso: {path: `${STAGE2_ROOT}/windows.iso`, bytes: "8152356864", sha256: SHA("d")}});
        assert.deepEqual(argv.slice(0, 8), ["-nodefaults", "-no-user-config", "-display", "none", "-qmp",
            "stdio", "-L", toolchain().firmware.searchPath]);
        assert.equal(argv.includes("--argv0"), false);
        assert.equal(argv.includes("Westmere-v2,avx=off,avx2=off"), true);
        assert.deepEqual(argv.slice(argv.indexOf("-nic"), argv.indexOf("-nic") + 2), ["-nic", "none"]);
        assert.equal(argv.some(value => /(?:^|[,=])(?:user|tap|socket|vsock)(?:[,=]|$)|https?:|virtio-9p/iu
            .test(value)), false);
    });

    it("accepts the exact portable toolchain returned by the Stage 2 hosted factory", async () => {
        const closure = packageClosure();
        const packageIdentities = new Map();
        for (const value of closure.packages) {
            const reference = `${value.name}:${value.architecture}=${value.version}`;
            packageIdentities.set(`${stage2Paths().packageRoot}/${value.name}.deb`, value);
            const digest = crypto.createHash("sha256").update(reference).digest("hex").slice(0, 16);
            packageIdentities.set(`${PORTABLE_ROOT}/.packages/${digest}.deb`, value);
        }
        const process = {exitCode: 0, signal: null, timedOut: false, stdoutOverflow: false, stderrOverflow: false,
            cleanupProven: true, errorObserved: false};
        const adapter = createHostedStage2Operations({context: context(), paths: stage2Paths(), dependencies: {
            mkdirExclusive: () => undefined, writeExclusive: () => undefined, pathExists: () => false,
            inspectDirectory: target => target === "/tmp" ? {path: "/tmp", uid: "0", gid: "0", mode: "1777",
                sticky: true, ordinaryUserWritable: true} : {path: target, uid: "0", gid: "0", mode: "755",
                sticky: false, ordinaryUserWritable: false},
            inspectOwned: target => ({path: target.endsWith("/usr/bin/wiminfo") ? `${PORTABLE_ROOT}/usr/bin/wimlib-imagex` :
                target.endsWith("/usr/bin/mcopy") || target.endsWith("/usr/bin/mformat") ?
                    `${PORTABLE_ROOT}/usr/bin/mtools` : target, bytes: packageIdentities.get(target)?.bytes ?? "4096",
                sha256: packageIdentities.get(target)?.sha256 ?? SHA("f"), ownership: {uid: "0", gid: "0",
                    mode: packageIdentities.has(target) ? "444" : "555", ordinaryUserWritable: false}}),
            inventoryOwnedTree: (_target, selector) => ({bytes: selector ? "128" : "512",
                sha256: SHA(selector ? "d" : "e")}),
            runOwned: async (_command, argv) => ({process, stdout: Buffer.from(argv.includes("--version") ?
                "QEMU emulator version 8.2.2 (Debian 1:8.2.2+ds-0ubuntu1.18)\n" :
                argv.includes("-cpu") ? "Westmere-v2\n" : argv.includes("-machine") ? "q35\n" :
                    argv.includes("-device") ? "ich9-ahci ide-cd ide-hd isa-serial VGA qemu-xhci usb-kbd\n" :
                    argv.includes("i") ? `Libs:\n 0 : 23.01 : ${PORTABLE_ROOT}/usr/lib/7zip/7z.so\n\nFormats:\n 0  ED       m  Iso      iso img        CD001\n` : ""), stderr: Buffer.alloc(0)})
        }});
        const actualToolchain = await adapter.extractPortableTools({packageClosure: closure,
            acquisition: {packages: closure.packages.map(value => ({
                reference: `${value.name}:${value.architecture}=${value.version}`,
                path: `${stage2Paths().packageRoot}/${value.name}.deb`, bytes: value.bytes, sha256: value.sha256}))},
            paths: stage2Paths(), privilegeMode: "reviewed-sudo-kvm"});
        const fixture = operations({async replayStage2(input) { fixture.calls.push("stage2");
            const observed = stage2Observation();
            return {identity: input.identity, guestEvidence: stage2GuestEvidence(),
                result: {...observed, toolchain: actualToolchain,
                media: {...observed.media, ovmfVars: {...observed.media.ovmfVars,
                    sha256: actualToolchain.ovmfVarsTemplate.sha256}},
                argv: buildStage2QemuArguments({paths: stage2Paths(), toolchain: actualToolchain})}}; }});
        const result = await runWindowsCpuFloorStage3(request(), fixture.value);
        assert.equal(result.status, "observed", result.failure);
        assert.equal(result.argv[0], "-nodefaults");
        assert.equal(result.argv.includes("--argv0"), false);
        assert.equal(result.qemuProcess.launcherExecutablePath, actualToolchain.runtime.loader.path);
    });

    it("runs acquisition, fresh media, guest teardown, then output collection", async () => {
        const fixture = operations();
        const result = await runWindowsCpuFloorStage3(request(), fixture.value);
        assert.deepEqual(fixture.calls, ["stage2", "candidate", "media", "launch", "collect"]);
        assert.equal(result.status, "observed", result.failure);
        assert.equal(result.baselineFullRuntimeAccepted, true);
        assert.equal(result.cpuFloorAccepted, true);
        assert.equal(result.qualifying, false);
        assert.equal(result.releaseGateCleared, false);
        assert.equal(result.qemuProcess.treeGone, true);
        assert.deepEqual(result.outputDisk, identity("baseline-output.img", "0", 67_108_864));
        assert.deepEqual(result.guestEvidence, collectedGuestResult());
    });

    it("strictly separates candidate authority from harness context authority", async () => {
        // Substituting candidate SHA into harness context fails closed
        const inputHarnessSubstituted = request();
        inputHarnessSubstituted.context.sourceSha = CANDIDATE_SOURCE_SHA;
        const fixture1 = operations();
        const result1 = await runWindowsCpuFloorStage3(inputHarnessSubstituted, fixture1.value);
        assert.equal(result1.status, "failed");

        // Substituting harness SHA into candidate fails closed
        const inputCandidateSubstituted = request();
        inputCandidateSubstituted.candidate.sourceSha = SOURCE_SHA;
        const fixture2 = operations();
        const result2 = await runWindowsCpuFloorStage3(inputCandidateSubstituted, fixture2.value);
        assert.equal(result2.status, "failed");

        // Preseal field presence fails closed (rejected in post-release schema)
        const inputWithPreseal = request();
        inputWithPreseal.candidate.preseal = {archive: {bytes: "100", sha256: SHA("1")}};
        const fixture3 = operations();
        const result3 = await runWindowsCpuFloorStage3(inputWithPreseal, fixture3.value);
        assert.equal(result3.status, "failed");
    });

    it("never reads guest output before exact QEMU cleanup is proven", async () => {
        let collected = false;
        const fixture = operations({async launchBaselineGuest(input) { return {argv: input.argv,
            process: {...processProof(), treeGone: false, cleanupProven: false},
            outputDisk: identity("baseline-output.img", "0", 67_108_864)}; },
        async collectBaselineGuestResult() { collected = true; return collectedGuestResult(); }});
        const result = await runWindowsCpuFloorStage3(request(), fixture.value);
        assert.equal(result.status, "failed");
        assert.equal(result.cleanupProven, false);
        assert.equal(collected, false);
    });

    it("marks cleanup unproven when launch throws or returns an unvalidated envelope", async () => {
        for (const launchBaselineGuest of [
            async () => { throw new Error("post-launch adapter failure"); },
            async input => ({argv: input.argv, outputDisk: identity("baseline-output.img", "0", 67_108_864)})
        ]) {
            const fixture = operations({launchBaselineGuest});
            const result = await runWindowsCpuFloorStage3(request(), fixture.value);
            assert.equal(result.status, "failed");
            assert.equal(result.stage, "qemu-launch");
            assert.equal(result.cleanupProven, false);
        }
    });

    it("rejects reduced verifier, wrong candidate, and AVX-capable guest evidence", () => {
        const cases = [
            value => { value.verifier.summary.mode = "listener-free-reset"; },
            value => { delete value.verifier.summary.processes[0].pid; },
            value => { delete value.verifier.summary.databaseChecks[0].ping; },
            value => { delete value.verifier.summary.openGraphChecks[0].elapsedMs; },
            value => { value.candidate.sha256 = SHA("e"); },
            value => { value.candidate.sourceSha = SOURCE_SHA; }, // harness SHA instead of candidate SHA
            value => { value.cpu.avx = true; },
            value => { value.cpu.cpuidSha256 = SHA("9"); },
            value => { const changed = encodedJson({...rawCpuid(), features: {...rawCpuid().features, avx: true}});
                value.cpu.cpuidBytesBase64 = changed.bytesBase64; value.cpu.cpuidSha256 = changed.sha256; },
            value => { value.network.hardwareNics = 1; },
            value => { value.verifier.summary.shutdownProofs[1].forced = true; },
            value => { value.verifier.summary.shutdownProofs[2].candidateExitCode = 0; },
            value => { value.verifier.summarySha256 = SHA("9"); },
            value => { value.verifier.summaryBytesBase64 = "A".repeat(OVERSIZED_BASE64_CHARACTERS); },
            value => { const changed = encodedJson({...fullSummary(), status: "failed"});
                value.verifier.summaryBytesBase64 = changed.bytesBase64; value.verifier.summarySha256 = changed.sha256; }
        ];
        for (const mutate of cases) {
            const value = guestResult();
            mutate(value);
            assert.throws(() => validateBaselineGuestResult(value, request()), /invalid|differ|prove|full|shutdown|network|CPU/i);
        }
    });

    it("rejects a resealed verifier summary containing only scenario labels", () => {
        const value = guestResult();
        value.verifier.summary.processes = value.verifier.summary.processes.map(({scenario}) => ({scenario}));
        value.verifier.summary.databaseChecks = value.verifier.summary.databaseChecks.map(({scenario}) => ({scenario}));
        value.verifier.summary.openGraphChecks = value.verifier.summary.openGraphChecks.map(({scenario}) => ({scenario}));
        const encoded = encodedJson(value.verifier.summary);
        value.verifier.summaryBytesBase64 = encoded.bytesBase64;
        value.verifier.summarySha256 = encoded.sha256;
        assert.throws(() => validateBaselineGuestResult(value, request()), /receipt|process|database|OpenGraph/u);
    });

    it("rejects a guest result whose retained envelope bytes or path differ", async () => {
        for (const collectBaselineGuestResult of [
            async () => ({...collectedGuestResult(), bytesBase64: Buffer.from("{}").toString("base64")}),
            async () => ({...collectedGuestResult(), identity: {...collectedGuestResult().identity,
                path: `${ROOT}/other.json`}})
        ]) {
            const fixture = operations({collectBaselineGuestResult});
            const result = await runWindowsCpuFloorStage3(request(), fixture.value);
            assert.equal(result.status, "failed");
            assert.equal(result.stage, "guest-output");
        }
    });

    it("rejects a modern MSI profile and an unclean Stage 2 prerequisite before acquisition", async () => {
        for (const mutate of [
            value => { value.profile = "modern-msi"; },
            value => { value.authorization.scope = "modern-msi"; },
            value => { value.candidate.archive.sha256 = `${SHA("a")}\n`; }
        ]) {
            const value = request();
            mutate(value);
            const fixture = operations();
            const result = await runWindowsCpuFloorStage3(value, fixture.value);
            assert.equal(result.status, "failed");
            assert.deepEqual(fixture.calls, []);
        }
        const fixture = operations({async replayStage2(input) { fixture.calls.push("stage2");
            return {identity: input.identity, guestEvidence: stage2GuestEvidence(),
                result: {...stage2Observation(), qemuProcess: {cleanupProven: true,
                treeGone: false, qemuPidAbsentAfter: true}}}; }});
        const result = await runWindowsCpuFloorStage3(request(), fixture.value);
        assert.equal(result.status, "failed");
        assert.deepEqual(fixture.calls, ["stage2"]);
    });

    it("rejects a projected Stage 2 result without its exact closure and launch evidence", async () => {
        for (const mutate of [
            value => { value.argv = []; },
            value => { value.packageClosure = {}; },
            value => { value.probeArtifact = {}; },
            value => { value.probes = {}; },
            value => { value.installWim = {}; },
            value => { value.media = {}; }
        ]) {
            const observed = stage2Observation();
            mutate(observed);
            const fixture = operations({async replayStage2(input) { return {identity: input.identity,
                result: observed, guestEvidence: stage2GuestEvidence()}; }});
            const result = await runWindowsCpuFloorStage3(request(), fixture.value);
            assert.equal(result.status, "failed");
            assert.equal(result.stage, "stage2-replay");
        }
    });

    it("rejects a WinPE answer-file diagnostic record wherever a Stage 2 calibration is expected", async () => {
        /*
         * A diagnostic record is refused three independent ways by this consumer: its extra
         * `winpeDiagnostic` key, its distinct classification and `cpuCalibrationAccepted: false`.
         * Each is asserted on its own, so removing any one of them would still fail the run.
         */
        const diagnosticClassification =
            "github-hosted-windows-cpu-floor-winpe-answer-file-diagnostic-nonqualifying";
        for (const mutate of [
            value => { value.winpeDiagnostic = {schemaVersion: 1, kind: "winpe-answer-file-diagnostic"}; },
            value => { value.classification = diagnosticClassification; },
            value => { value.cpuCalibrationAccepted = false; },
            value => { value.status = "diagnostic"; value.stage = "winpe-answer-file-diagnostic"; }
        ]) {
            const observed = stage2Observation();
            mutate(observed);
            const fixture = operations({async replayStage2(input) { return {identity: input.identity,
                result: observed, guestEvidence: stage2GuestEvidence()}; }});
            const result = await runWindowsCpuFloorStage3(request(), fixture.value);
            assert.equal(result.status, "failed");
            assert.equal(result.stage, "stage2-replay");
        }
    });

    it("replays the retained raw Stage 2 CPUID and all eight instruction runs", async () => {
        const raw = rawStage2Guest();
        raw.runs.find(run => run.role === "avx").exitCode = 0;
        const encoded = encodedJson(raw);
        const evidence = {identity: {...stage2GuestEvidence().identity,
            bytes: String(Buffer.from(encoded.bytesBase64, "base64").length), sha256: encoded.sha256},
        bytesBase64: encoded.bytesBase64};
        const input = request();
        input.stage2.guestResult = evidence.identity;
        const fixture = operations({async replayStage2(value) { return {identity: value.identity,
            result: stage2Observation(), guestEvidence: evidence}; }});
        const result = await runWindowsCpuFloorStage3(input, fixture.value);
        assert.equal(result.status, "failed");
        assert.equal(result.stage, "stage2-replay");
        assert.match(result.failure, /AVX|illegal/u);
    });

    it("independently replays a completed result against retained Stage 2 bytes", async () => {
        const retainedStage2Bytes = Buffer.from(JSON.stringify(stage2Observation()), "utf8");
        const input = request();
        input.stage2.result = {...input.stage2.result, bytes: String(retainedStage2Bytes.length),
            sha256: crypto.createHash("sha256").update(retainedStage2Bytes).digest("hex")};
        const fixture = operations();
        const result = await runWindowsCpuFloorStage3(input, fixture.value);
        assert.equal(result.status, "observed", result.failure);
        assert.equal(validateCompletedStage3Result(result, input, retainedStage2Bytes).accepted, true);
        for (const [changedResult, changedBytes] of [
            [{...result, cpuFloorAccepted: false}, retainedStage2Bytes],
            [result, Buffer.from(JSON.stringify({...stage2Observation(), cpuCalibrationAccepted: false}))],
            [{...result, argv: [...result.argv, "-net", "user"]}, retainedStage2Bytes],
            [{...result, outputDisk: {...result.outputDisk, bytes: "1"}}, retainedStage2Bytes],
            [{...result, outputDisk: {...result.outputDisk, sha256: SHA("9")}}, retainedStage2Bytes],
            [{...result, guestEvidence: {...result.guestEvidence,
                bytesBase64: Buffer.from("{}\n").toString("base64")}}, retainedStage2Bytes]
        ]) assert.throws(() => validateCompletedStage3Result(changedResult, input, changedBytes),
            /Stage 2|result|vector|accepted|differ|invalid/i);
        for (const mutate of [
            value => { value.argv = []; },
            value => { value.probes = {}; },
            value => { value.packageClosure = {}; }
        ]) {
            const changedStage2 = stage2Observation();
            mutate(changedStage2);
            const changedStage2Bytes = Buffer.from(JSON.stringify(changedStage2), "utf8");
            const changedIdentity = {...input.stage2.result, bytes: String(changedStage2Bytes.length),
                sha256: crypto.createHash("sha256").update(changedStage2Bytes).digest("hex")};
            const changedInput = structuredClone(input);
            changedInput.stage2.result = changedIdentity;
            assert.throws(() => validateCompletedStage3Result({...result, stage2Result: changedIdentity}, changedInput,
                changedStage2Bytes), /Stage 2|package|probe|vector/i);
        }
        const invalidRaw = rawStage2Guest();
        invalidRaw.runs.find(run => run.role === "known-good").exitCode = 19;
        const encodedInvalidRaw = encodedJson(invalidRaw);
        const invalidEvidence = {identity: {...input.stage2.guestResult,
            bytes: String(Buffer.from(encodedInvalidRaw.bytesBase64, "base64").length),
            sha256: encodedInvalidRaw.sha256}, bytesBase64: encodedInvalidRaw.bytesBase64};
        const invalidRawInput = structuredClone(input);
        invalidRawInput.stage2.guestResult = invalidEvidence.identity;
        assert.throws(() => validateCompletedStage3Result({...result, stage2GuestEvidence: invalidEvidence},
            invalidRawInput, retainedStage2Bytes), /known-good|control/u);
    });
});

describe("Windows CPU-floor Stage 3 boot policy", () => {
    const windowsIso = () => ({path: `${STAGE2_ROOT}/windows.iso`, bytes: "8152356864", sha256: SHA("d")});
    const argv = () => buildBaselineQemuArguments({paths: paths(), toolchain: toolchain(),
        windowsIso: windowsIso()});

    it("selects the boot device the way OVMF actually reads it and opens the QMP the launcher requires", () => {
        const vector = argv();
        assert.equal(vector.includes("-boot"), false);
        assert.deepEqual(vector.slice(vector.indexOf("-qmp"), vector.indexOf("-qmp") + 2), ["-qmp", "stdio"]);
        assert.equal(vector.includes("-monitor"), false);
        assert.deepEqual(vector.slice(vector.indexOf("-L"), vector.indexOf("-L") + 2),
            ["-L", toolchain().firmware.searchPath]);
        assert.ok(vector.includes(`VGA,id=video0,romfile=${toolchain().firmware.vga.path}`));
        assert.ok(vector.includes("qemu-xhci,id=usb0"));
        assert.ok(vector.includes("usb-kbd,bus=usb0.0"));
        assert.ok(vector.includes("ide-hd,drive=osdisk,bus=sata.1,bootindex=0"));
        assert.ok(vector.includes("ide-cd,drive=install,bus=sata.2,bootindex=1"));
        assert.equal(vector.filter(value => value.includes("bootindex=")).length, 2);
        assert.deepEqual(vector.slice(vector.indexOf("-nic"), vector.indexOf("-nic") + 2), ["-nic", "none"]);
    });

    it("refuses a toolchain whose capability set cannot render the console it now opens", () => {
        for (const missing of ["VGA", "qemu-xhci", "usb-kbd"]) {
            const reduced = stage2Observation();
            reduced.toolchain.capabilities.devices = reduced.toolchain.capabilities.devices
                .filter(name => name !== missing);
            const fixture = operations({async replayStage2(input) { return {identity: input.identity,
                result: reduced, guestEvidence: stage2GuestEvidence()}; }});
            assert.rejects(async () => {
                const result = await runWindowsCpuFloorStage3(request(), fixture.value);
                if (result.status !== "observed") throw new TypeError(result.failure);
            }, /QEMU capability set is invalid/u);
        }
    });

    it("binds both early frames to its own root and carries them into the accepted result", async () => {
        const fixture = operations();
        const result = await runWindowsCpuFloorStage3(request(), fixture.value);
        assert.equal(result.status, "observed", result.failure);
        assert.equal(result.earlyBoot.kind, "qemu-early-boot-observation");
        assert.equal(result.earlyBoot.inputSent, false);
        assert.deepEqual(result.earlyBoot.screenshots.map(value => value.path),
            [`${ROOT}/early-boot-1.png`, `${ROOT}/early-boot-2.png`]);
        for (const screenshot of result.earlyBoot.screenshots) {
            assert.equal(screenshot.sha256, PNG_HASH);
            assert.equal(screenshot.bytes, String(PNG.length));
        }
    });

    it("refuses early frames outside its own root, with foreign bytes, or with a forged digest", async () => {
        const foreign = `${STAGE2_ROOT}/early-boot-1.png`;
        const cases = [
            value => { value.screenshots[0].path = foreign; },
            value => { value.screenshots[0].bytesBase64 = Buffer.from("not-a-png").toString("base64"); },
            value => { value.screenshots[1].sha256 = SHA("1"); },
            value => { value.screenshots[1].bytes = "99"; },
            value => { value.screenshots.pop(); }
        ];
        for (const mutate of cases) {
            const fixture = operations({async launchBaselineGuest(input) {
                const observation = earlyBootObservation();
                mutate(observation);
                return {argv: input.argv, process: processProof(), earlyBoot: observation,
                    reservation: reservationProof(),
                    outputDisk: identity("baseline-output.img", "0", 67_108_864)}; }});
            const result = await runWindowsCpuFloorStage3(request(), fixture.value);
            assert.equal(result.status, "failed");
            assert.match(result.failure, /early-boot screenshot/u);
        }
    });

    it("denies installer boot input by explicit statement, not by inheritance", async () => {
        const stage2Confirmation = {kind: "installer-boot-confirmation", qcode: "ret", holdMilliseconds: 100,
            requestedOffsetMilliseconds: 2_000, sentOffsetMilliseconds: 2_100, acknowledged: true};
        for (const inputSent of [stage2Confirmation, true, null, undefined]) {
            const fixture = operations({async launchBaselineGuest(input) {
                return {argv: input.argv, process: processProof(), reservation: reservationProof(),
                    earlyBoot: {...earlyBootObservation(), inputSent},
                    outputDisk: identity("baseline-output.img", "0", 67_108_864)}; }});
            const result = await runWindowsCpuFloorStage3(request(), fixture.value);
            assert.equal(result.status, "failed");
        }
    });

    it("admits one acknowledged key only when the request itself binds a Stage 3 confirmation", async () => {
        const authorized = request();
        authorized.authorization.bootConfirmation = "single-enter-before-setup-v1";
        const inputSent = {kind: "installer-boot-confirmation", qcode: "ret", holdMilliseconds: 100,
            requestedOffsetMilliseconds: 2_000, sentOffsetMilliseconds: 2_100, acknowledged: true};
        const fixture = operations({async launchBaselineGuest(input) {
            return {argv: input.argv, process: processProof(), earlyBoot: {...earlyBootObservation(), inputSent},
                reservation: reservationProof(),
                outputDisk: identity("baseline-output.img", "0", 67_108_864)}; }});
        const result = await runWindowsCpuFloorStage3(authorized, fixture.value);
        assert.equal(result.status, "observed", result.failure);
        assert.deepEqual(result.earlyBoot.inputSent, inputSent);
        const unauthorized = await runWindowsCpuFloorStage3(request(), fixture.value);
        assert.equal(unauthorized.status, "failed");
        const forged = request();
        forged.authorization.bootConfirmation = "any-key-v9";
        const refused = await runWindowsCpuFloorStage3(forged, fixture.value);
        assert.equal(refused.status, "failed");
    });

    it("requires the early-boot member when replaying a completed Stage 3 result", async () => {
        const retained = Buffer.from(JSON.stringify(stage2Observation()), "utf8");
        const binding = request();
        binding.stage2.result = {...binding.stage2.result, bytes: String(retained.length),
            sha256: crypto.createHash("sha256").update(retained).digest("hex")};
        const fixture = operations();
        const result = await runWindowsCpuFloorStage3(binding, fixture.value);
        assert.equal(result.status, "observed", result.failure);
        assert.deepEqual(validateCompletedStage3Result(result, binding, retained).accepted, true);
        const {earlyBoot: _removed, ...withoutEarlyBoot} = result;
        assert.throws(() => validateCompletedStage3Result(withoutEarlyBoot, binding, retained),
            /completed Stage 3 result keys are invalid/u);
        const mutated = structuredClone(result);
        mutated.earlyBoot.screenshots[0].path = `${STAGE2_ROOT}/early-boot-1.png`;
        assert.throws(() => validateCompletedStage3Result(mutated, binding, retained),
            /early-boot screenshot is invalid/u);
    });
});

/*
 * The job anchor. The workflow's own first shell step cannot say when the job started - runner and
 * job setup happen before it - so the ceiling is anchored to the authenticated start of this job,
 * and a delayed start is charged rather than refunded.
 */
describe("Windows CPU-floor Stage 3 job budget anchor", () => {
    const MINUTE = 60_000;
    const START = Date.parse("2026-09-16T12:00:00Z");
    const clock = value => () => value;
    const job = (overrides = {}) => ({name: "Execute Stage 3 sequence under KVM", run_id: 42, run_attempt: 3,
        runner_name: "GitHub Actions 7", status: "in_progress", started_at: "2026-09-16T12:00:00Z", ...overrides});
    const request = (overrides = {}) => ({jobs: [job()], totalCount: 1,
        jobName: "Execute Stage 3 sequence under KVM", runId: "42", runAttempt: "3",
        runnerName: "GitHub Actions 7", ...overrides});

    it("anchors the ceiling to the authenticated job start rather than to the step that reads it", () => {
        const delayed = START + 9 * MINUTE;
        const anchor = anchorStage3JobBudget(request(), clock(delayed));

        assert.equal(anchor.startedAtUnixMilliseconds, START);
        assert.equal(anchor.hardStopUnixMilliseconds,
            START + STAGE3_BUDGET_CONSTANTS.JOB_CEILING_MILLISECONDS
            - STAGE3_BUDGET_CONSTANTS.RETENTION_RESERVE_MILLISECONDS);
        // A fresh clock would have handed the sequence those nine minutes back.
        assert.equal(anchor.remainingMilliseconds,
            anchor.wallDeadlineUnixMilliseconds - delayed);
        assert.ok(anchor.remainingMilliseconds < STAGE3_BUDGET_CONSTANTS.JOB_CEILING_MILLISECONDS
            - STAGE3_BUDGET_CONSTANTS.RETENTION_RESERVE_MILLISECONDS
            - STAGE3_BUDGET_CONSTANTS.SEQUENCE_KILL_GRACE_MILLISECONDS);
    });

    it("leaves the kill grace inside the deadline so escalation ends before the retention reserve", () => {
        const anchor = anchorStage3JobBudget(request(), clock(START));

        assert.equal(anchor.hardStopUnixMilliseconds - anchor.wallDeadlineUnixMilliseconds,
            STAGE3_BUDGET_CONSTANTS.SEQUENCE_KILL_GRACE_MILLISECONDS);
        // TERM at the wall deadline, KILL one grace later, and the full retention reserve still
        // stands between that hard stop and the ceiling GitHub cancels the job at.
        assert.equal(START + STAGE3_BUDGET_CONSTANTS.JOB_CEILING_MILLISECONDS
            - anchor.hardStopUnixMilliseconds, STAGE3_BUDGET_CONSTANTS.RETENTION_RESERVE_MILLISECONDS);
        assert.equal(anchor.wallDeadlineUnixMilliseconds, START
            + STAGE3_BUDGET_CONSTANTS.JOB_CEILING_MILLISECONDS
            - STAGE3_BUDGET_CONSTANTS.RETENTION_RESERVE_MILLISECONDS
            - STAGE3_BUDGET_CONSTANTS.SEQUENCE_KILL_GRACE_MILLISECONDS);
    });

    it("admits exactly down to the minimum a sequence needs and refuses the millisecond below it", () => {
        const deadline = START + STAGE3_BUDGET_CONSTANTS.JOB_CEILING_MILLISECONDS
            - STAGE3_BUDGET_CONSTANTS.RETENTION_RESERVE_MILLISECONDS
            - STAGE3_BUDGET_CONSTANTS.SEQUENCE_KILL_GRACE_MILLISECONDS;
        const latest = deadline - STAGE3_BUDGET_CONSTANTS.MINIMUM_SEQUENCE_MILLISECONDS;

        assert.equal(anchorStage3JobBudget(request(), clock(latest)).remainingMilliseconds,
            STAGE3_BUDGET_CONSTANTS.MINIMUM_SEQUENCE_MILLISECONDS);
        assert.throws(() => anchorStage3JobBudget(request(), clock(latest + 1)),
            /Stage 3 job budget leaves/u);
    });

    it("refuses an expired anchor rather than opening a budget the job cannot hold", () => {
        for (const spent of [STAGE3_BUDGET_CONSTANTS.JOB_CEILING_MILLISECONDS
            - STAGE3_BUDGET_CONSTANTS.RETENTION_RESERVE_MILLISECONDS, 80 * MINUTE]) {
            assert.throws(() => anchorStage3JobBudget(request(), clock(START + spent)),
                /Stage 3 job budget leaves/u);
        }
    });

    it("refuses metadata that is not unambiguously this job, this run and this attempt", () => {
        for (const [broken, pattern] of [
            [{jobs: [], totalCount: 0}, /ambiguous or absent/u],
            [{jobs: [job(), job()], totalCount: 2}, /ambiguous or absent/u],
            [{jobs: [job({name: "Prepare exact Windows inputs in this run"})]}, /ambiguous or absent/u],
            [{jobs: [job({run_id: 43})]}, /ambiguous or absent/u],
            [{jobs: [job({run_attempt: 2})]}, /ambiguous or absent/u],
            [{jobs: [job({runner_name: "GitHub Actions 8"})]}, /ambiguous or absent/u],
            [{jobs: [job({status: "completed"})]}, /ambiguous or absent/u],
            [{jobs: [job(), null], totalCount: 2}, /job metadata is invalid/u],
            [{totalCount: 2}, /job metadata is incomplete/u],
            [{jobs: {}}, /job metadata is invalid/u],
            [{jobs: new Array(101).fill(job()), totalCount: 101}, /job metadata is invalid/u],
            [{runnerName: ""}, /job anchor request is invalid/u],
            [{runId: "042"}, /job anchor request is invalid/u],
            [{runAttempt: 3}, /job anchor request is invalid/u],
            [{extra: true}, /job anchor request keys are invalid/u]]) {
            assert.throws(() => anchorStage3JobBudget({...request(), ...broken}, clock(START + MINUTE)), pattern,
                JSON.stringify(Object.keys(broken)));
        }
    });

    it("refuses an unusable start timestamp instead of substituting a fresh clock", () => {
        for (const started_at of [undefined, null, 17, "", "not-a-timestamp",
            "2026-09-16T12:02:00Z", "2026-09-16T10:00:00Z"]) {
            assert.throws(() => anchorStage3JobBudget({...request(), jobs: [job({started_at})]},
                clock(START + MINUTE)), /Stage 3 job start is invalid/u);
        }
        for (const broken of [Number.NaN, -1, 1.5, "now"]) {
            assert.throws(() => anchorStage3JobBudget(request(), clock(broken)),
                /Stage 3 budget clock is invalid/u);
        }
    });

    it("hands the sequence a deadline the launch admission can still tighten but never widen", () => {
        const anchor = anchorStage3JobBudget(request(), clock(START + MINUTE));
        const reservation = admitStage3Reservation({label: STAGE3_BUDGET_CONSTANTS.RESERVATION_LABEL,
            wallDeadlineUnixMilliseconds: anchor.wallDeadlineUnixMilliseconds}, clock(START + 10 * MINUTE));

        assert.equal(reservation.executionMilliseconds,
            STAGE3_BUDGET_CONSTANTS.EXECUTION_CEILING_MILLISECONDS);
        assert.ok(START + 10 * MINUTE + reservation.executionMilliseconds + reservation.cleanupMilliseconds
            < anchor.wallDeadlineUnixMilliseconds);
        assert.ok(anchor.hardStopUnixMilliseconds
            < START + STAGE3_BUDGET_CONSTANTS.JOB_CEILING_MILLISECONDS);
    });
});

describe("Windows CPU-floor Stage 3 execution budget", () => {
    const MINUTE = 60_000;
    const clock = value => () => value;

    it("sizes one bounded reservation from the wall deadline instead of the generic launcher allowance", () => {
        const now = Date.parse("2026-09-16T12:00:00Z");
        const admitted = admitStage3Reservation({label: STAGE3_BUDGET_CONSTANTS.RESERVATION_LABEL,
            wallDeadlineUnixMilliseconds: now + 80 * MINUTE}, clock(now));
        assert.equal(admitted.label, STAGE3_BUDGET_CONSTANTS.RESERVATION_LABEL);
        assert.equal(admitted.executionMilliseconds, STAGE3_BUDGET_CONSTANTS.EXECUTION_CEILING_MILLISECONDS);
        assert.equal(admitted.cleanupMilliseconds, STAGE3_BUDGET_CONSTANTS.LAUNCH_CLEANUP_MILLISECONDS);
        assert.ok(admitted.executionMilliseconds < 16_200_000);
    });

    it("charges the time already spent and keeps cleanup and collection out of the execution bound", () => {
        const now = Date.parse("2026-09-16T12:00:00Z");
        const remaining = 40 * MINUTE;
        const admitted = admitStage3Reservation({label: STAGE3_BUDGET_CONSTANTS.RESERVATION_LABEL,
            wallDeadlineUnixMilliseconds: now + remaining}, clock(now));
        assert.equal(admitted.executionMilliseconds, remaining
            - STAGE3_BUDGET_CONSTANTS.LAUNCH_CLEANUP_MILLISECONDS
            - STAGE3_BUDGET_CONSTANTS.COLLECTION_RESERVE_MILLISECONDS);
        const later = admitStage3Reservation({label: STAGE3_BUDGET_CONSTANTS.RESERVATION_LABEL,
            wallDeadlineUnixMilliseconds: now + remaining}, clock(now + 10 * MINUTE));
        assert.equal(later.executionMilliseconds, admitted.executionMilliseconds - 10 * MINUTE);
    });

    it("refuses to start a guest that cannot finish instead of launching one the deadline will kill", () => {
        const now = Date.parse("2026-09-16T12:00:00Z");
        const short = STAGE3_BUDGET_CONSTANTS.MINIMUM_EXECUTION_MILLISECONDS
            + STAGE3_BUDGET_CONSTANTS.LAUNCH_CLEANUP_MILLISECONDS
            + STAGE3_BUDGET_CONSTANTS.COLLECTION_RESERVE_MILLISECONDS;
        assert.doesNotThrow(() => admitStage3Reservation({label: STAGE3_BUDGET_CONSTANTS.RESERVATION_LABEL,
            wallDeadlineUnixMilliseconds: now + short}, clock(now)));
        assert.throws(() => admitStage3Reservation({label: STAGE3_BUDGET_CONSTANTS.RESERVATION_LABEL,
            wallDeadlineUnixMilliseconds: now + short - 1}, clock(now)), /Stage 3 execution budget/u);
        assert.throws(() => admitStage3Reservation({label: STAGE3_BUDGET_CONSTANTS.RESERVATION_LABEL,
            wallDeadlineUnixMilliseconds: now - 1}, clock(now)), /Stage 3 execution budget/u);
    });

    it("refuses a budget or a clock that could hand back time that was already spent", () => {
        const now = Date.parse("2026-09-16T12:00:00Z");
        const valid = {label: STAGE3_BUDGET_CONSTANTS.RESERVATION_LABEL,
            wallDeadlineUnixMilliseconds: now + 80 * MINUTE};
        assert.throws(() => admitStage3Reservation({...valid, label: "generic"}, clock(now)),
            /Stage 3 budget is invalid/u);
        assert.throws(() => admitStage3Reservation({...valid, extra: 1}, clock(now)),
            /Stage 3 budget keys are invalid/u);
        assert.throws(() => admitStage3Reservation({...valid, wallDeadlineUnixMilliseconds: "later"}, clock(now)),
            /Stage 3 budget is invalid/u);
        assert.throws(() => admitStage3Reservation({...valid, wallDeadlineUnixMilliseconds: 0}, clock(now)),
            /Stage 3 budget is invalid/u);
        for (const broken of [Number.NaN, -1, 1.5, "now"]) {
            assert.throws(() => admitStage3Reservation(valid, clock(broken)), /Stage 3 budget clock is invalid/u);
        }
    });

    it("hands the request budget to the launch and records what the launcher was actually given", async () => {
        const observed = [];
        const fixture = operations({async launchBaselineGuest(input) {
            observed.push(input.budget);
            return {argv: input.argv, process: processProof(), earlyBoot: earlyBootObservation(),
                reservation: reservationProof(), outputDisk: identity("baseline-output.img", "0", 67_108_864)}; }});
        const result = await runWindowsCpuFloorStage3(request(), fixture.value);
        assert.equal(result.status, "observed", result.failure);
        assert.deepEqual(observed, [budget()]);
        assert.deepEqual(result.reservation, reservationProof());
    });

    it("refuses a launch that ignored the bound and took a wider allowance than Stage 3 may spend", async () => {
        const cases = [
            {...reservationProof(), executionMilliseconds: 16_200_000},
            {...reservationProof(),
                executionMilliseconds: STAGE3_BUDGET_CONSTANTS.EXECUTION_CEILING_MILLISECONDS + 1},
            {...reservationProof(),
                executionMilliseconds: STAGE3_BUDGET_CONSTANTS.MINIMUM_EXECUTION_MILLISECONDS - 1},
            {...reservationProof(), cleanupMilliseconds: 40 * MINUTE},
            {...reservationProof(), label: "generic"},
            {...reservationProof(), extra: true},
            undefined
        ];
        for (const reservation of cases) {
            const fixture = operations({async launchBaselineGuest(input) {
                return {argv: input.argv, process: processProof(), earlyBoot: earlyBootObservation(),
                    reservation, outputDisk: identity("baseline-output.img", "0", 67_108_864)}; }});
            const result = await runWindowsCpuFloorStage3(request(), fixture.value);
            assert.equal(result.status, "failed");
            assert.match(result.failure, /Stage 3 (?:reservation|launch observation)/u);
        }
    });

    it("refuses a Stage 3 request that declares no budget at all", async () => {
        const {budget: _removed, ...unbounded} = request();
        const fixture = operations();
        const result = await runWindowsCpuFloorStage3(unbounded, fixture.value);
        assert.equal(result.status, "failed");
        assert.match(result.failure, /Stage 3 request keys are invalid/u);
    });

    it("revalidates the reservation when replaying a completed Stage 3 result", async () => {
        const retained = Buffer.from(JSON.stringify(stage2Observation()), "utf8");
        const binding = request();
        binding.stage2.result = {...binding.stage2.result, bytes: String(retained.length),
            sha256: crypto.createHash("sha256").update(retained).digest("hex")};
        const fixture = operations({async launchBaselineGuest(input) {
            return {argv: input.argv, process: processProof(), earlyBoot: earlyBootObservation(),
                reservation: reservationProof(), outputDisk: identity("baseline-output.img", "0", 67_108_864)}; }});
        const result = await runWindowsCpuFloorStage3(binding, fixture.value);
        assert.equal(result.status, "observed", result.failure);
        assert.equal(validateCompletedStage3Result(result, binding, retained).accepted, true);
        const {reservation: _dropped, ...without} = result;
        assert.throws(() => validateCompletedStage3Result(without, binding, retained),
            /completed Stage 3 result keys are invalid/u);
        assert.throws(() => validateCompletedStage3Result({...result,
            reservation: {...reservationProof(), executionMilliseconds: 16_200_000}}, binding, retained),
        /Stage 3 reservation is invalid/u);
    });
});

describe("Windows CPU-floor Stage 3 launch failure diagnostics", () => {
    const serialText = "UEFI Interactive Shell";
    const serialLog = () => ({status: "captured", bytes: String(serialText.length),
        sha256: crypto.createHash("sha256").update(Buffer.from(serialText, "utf8")).digest("hex"),
        bytesBase64: Buffer.from(serialText, "utf8").toString("base64"),
        observedBytes: String(serialText.length), truncated: false});
    const deadlineDiagnostic = () => ({schemaVersion: 1, kind: "qemu-launch-failure-diagnostic",
        process: {...processProof(), exitCode: null, signal: "SIGKILL", timedOut: true,
            cleanupProven: false, treeGone: false, terminationReason: "deadline"},
        processFlags: {errorObserved: false, stdoutOverflow: false, stderrOverflow: false},
        monitorFailure: null,
        stderr: {bytes: "11", sha256: SHA("e"),
            bytesBase64: Buffer.from("qemu stderr", "utf8").toString("base64")},
        serialLog: serialLog()});
    const launchFailure = (overrides = {}) => ({argv: ["-nic", "none"],
        process: {...processProof(), exitCode: null, signal: "SIGKILL", timedOut: true,
            cleanupProven: false, treeGone: false, terminationReason: "deadline"},
        earlyBoot: earlyBootObservation(), guest: null, failureDiagnostic: deadlineDiagnostic(), ...overrides});
    const guestReceipt = () => ({schemaVersion: 1, status: "failed", nonce: NONCE,
        stage: "guest-bootstrap", failure: "executor-invocation"});

    it("projects a retained launch diagnostic into the failed Stage 3 result", async () => {
        const fixture = operations({async launchBaselineGuest(input) {
            throw buildStage3LaunchFailure("baseline guest did not return the CPU calibration envelope",
                buildStage3LaunchDiagnostic({...launchFailure(), argv: input.argv}));
        }});
        const result = await runWindowsCpuFloorStage3(request(), fixture.value);
        assert.equal(result.status, "failed");
        assert.equal(result.stage, "qemu-launch");
        assert.equal(result.failure, "baseline guest did not return the CPU calibration envelope");
        assert.equal(result.qemuLaunch.kind, "stage3-qemu-launch-diagnostic");
        assert.equal(result.qemuLaunch.classification, STAGE3_LAUNCH_CLASSIFICATIONS.hostExecutionDeadline);
        assert.equal(result.qemuLaunch.terminationReason, "deadline");
        assert.equal(result.qemuLaunch.guestFailureObserved, false);
        assert.equal(result.qemuLaunch.serialLog.bytesBase64, serialLog().bytesBase64);
        assert.equal(result.qemuLaunch.process.signal, "SIGKILL");
        // The keystroke proof is the only evidence that answers a missed boot confirmation.
        assert.equal(result.qemuLaunch.earlyBoot.inputSent, false);
        // A retained diagnostic must never make a failed result look accepted.
        assert.equal(result.qualifying, false);
        assert.equal(result.releaseGateCleared, false);
        assert.equal(result.baselineFullRuntimeAccepted, false);
        assert.equal(result.cpuFloorAccepted, false);
        assert.equal(result.cleanupProven, false);
    });

    it("sizes the retained diagnostic against the controller's own result cap", () => {
        assert.equal(STAGE3_LAUNCH_DIAGNOSTIC_CONSTANTS.MAX_RESULT_CHARACTERS,
            STAGE3_CONTROLLER_CONSTANTS.MAX_EVIDENCE_BYTES);
        assert.ok(STAGE3_LAUNCH_DIAGNOSTIC_CONSTANTS.MAX_DIAGNOSTIC_CHARACTERS <
            STAGE3_LAUNCH_DIAGNOSTIC_CONSTANTS.MAX_RESULT_CHARACTERS);
    });

    it("omits the launch member for failures that carry no launch diagnostic", async () => {
        const fixture = operations({async launchBaselineGuest() { throw new Error("adapter failure"); }});
        const result = await runWindowsCpuFloorStage3(request(), fixture.value);
        assert.equal(result.status, "failed");
        assert.equal(Object.hasOwn(result, "qemuLaunch"), false);
    });

    it("classifies the observed termination reason without inferring one from the signal", () => {
        const classificationOf = terminationReason => buildStage3LaunchDiagnostic({...launchFailure(),
            failureDiagnostic: {...deadlineDiagnostic(),
                process: {...deadlineDiagnostic().process, terminationReason}}}).classification;
        assert.equal(classificationOf("deadline"), STAGE3_LAUNCH_CLASSIFICATIONS.hostExecutionDeadline);
        assert.equal(classificationOf("efi-shell-fallback"),
            STAGE3_LAUNCH_CLASSIFICATIONS.firmwareShellFallback);
        assert.equal(classificationOf(null), STAGE3_LAUNCH_CLASSIFICATIONS.guestResultUnavailable);
        // A SIGKILL alone never proves the execution deadline: the outer timeout wrapper races it.
        assert.equal(classificationOf("qmp-failed"), STAGE3_LAUNCH_CLASSIFICATIONS.guestResultUnavailable);
        const reported = buildStage3LaunchDiagnostic({...launchFailure(), guestFailure: guestReceipt(),
            failureDiagnostic: {...deadlineDiagnostic(),
                process: {...deadlineDiagnostic().process, terminationReason: null}}});
        assert.equal(reported.classification, STAGE3_LAUNCH_CLASSIFICATIONS.guestReportedFailure);
        assert.equal(reported.guestFailureObserved, true);
        assert.equal(reported.guestFailure.failure, "executor-invocation");
        // A host deadline and a guest receipt coexist: the host observation classifies, both survive.
        const both = buildStage3LaunchDiagnostic({...launchFailure(), guestFailure: guestReceipt()});
        assert.equal(both.classification, STAGE3_LAUNCH_CLASSIFICATIONS.hostExecutionDeadline);
        assert.equal(both.guestFailureObserved, true);
        assert.equal(both.guestFailure.failure, "executor-invocation");
    });

    it("builds a diagnostic for a clean process whose guest reported its own failure", () => {
        const diagnostic = buildStage3LaunchDiagnostic({argv: ["-nic", "none"], process: processProof(),
            earlyBoot: earlyBootObservation(), guest: guestReceipt(), guestFailure: guestReceipt()});
        assert.equal(diagnostic.kind, "stage3-qemu-launch-diagnostic");
        assert.equal(diagnostic.classification, STAGE3_LAUNCH_CLASSIFICATIONS.guestReportedFailure);
        assert.equal(diagnostic.process.exitCode, 0);
        assert.equal(diagnostic.terminationReason, null);
        assert.equal(diagnostic.guestFailure.failure, "executor-invocation");
    });

    it("strips oversized frame payloads and never exceeds the retained diagnostic budget", async () => {
        const frame = () => ({path: `${ROOT}/predeadline-frame.png`, bytes: "1048576", sha256: SHA("f"),
            bytesBase64: "A".repeat(OVERSIZED_BASE64_CHARACTERS)});
        const diagnostic = buildStage3LaunchDiagnostic({...launchFailure(),
            failureDiagnostic: {...deadlineDiagnostic(),
                predeadlineFrame: {status: "captured", screenshot: frame()},
                midWindowFrames: [{offsetMs: 600_000, screenshot: frame()}]}});
        assert.equal(diagnostic.predeadlineFrame.screenshot.bytesBase64,
            STAGE3_LAUNCH_DIAGNOSTIC_CONSTANTS.OMITTED_PAYLOAD_MARKER);
        // The identity of a dropped frame stays: its bytes live on in the evidence bundle.
        assert.equal(diagnostic.predeadlineFrame.screenshot.sha256, SHA("f"));
        assert.equal(diagnostic.midWindowFrames[0].screenshot.bytesBase64,
            STAGE3_LAUNCH_DIAGNOSTIC_CONSTANTS.OMITTED_PAYLOAD_MARKER);
        // The bounded serial and stderr streams are exactly the evidence that must survive.
        assert.equal(diagnostic.serialLog.bytesBase64, serialLog().bytesBase64);
        assert.ok(JSON.stringify(diagnostic).length <
            STAGE3_LAUNCH_DIAGNOSTIC_CONSTANTS.MAX_DIAGNOSTIC_CHARACTERS);
        const fixture = operations({async launchBaselineGuest() {
            throw buildStage3LaunchFailure("baseline guest did not return the CPU calibration envelope",
                diagnostic);
        }});
        const result = await runWindowsCpuFloorStage3(request(), fixture.value);
        assert.equal(result.qemuLaunch.predeadlineFrame.screenshot.bytesBase64,
            STAGE3_LAUNCH_DIAGNOSTIC_CONSTANTS.OMITTED_PAYLOAD_MARKER);
        assert.ok(JSON.stringify(result).length < STAGE3_LAUNCH_DIAGNOSTIC_CONSTANTS.MAX_RESULT_CHARACTERS);
    });

    it("replaces a diagnostic that still exceeds the budget with its bounded summary", async () => {
        const wide = Object.fromEntries(Array.from({length: 4096}, (_value, index) =>
            [`member-${index}`, "b".repeat(512)]));
        const fixture = operations({async launchBaselineGuest() {
            throw buildStage3LaunchFailure("baseline guest did not return the CPU calibration envelope",
                buildStage3LaunchDiagnostic({...launchFailure(),
                    failureDiagnostic: {...deadlineDiagnostic(), wide}}));
        }});
        const result = await runWindowsCpuFloorStage3(request(), fixture.value);
        assert.equal(result.status, "failed");
        assert.equal(result.qemuLaunch.omitted, STAGE3_LAUNCH_DIAGNOSTIC_CONSTANTS.OMITTED_DIAGNOSTIC_MARKER);
        assert.equal(result.qemuLaunch.classification, STAGE3_LAUNCH_CLASSIFICATIONS.hostExecutionDeadline);
        assert.equal(result.qemuLaunch.terminationReason, "deadline");
        assert.equal(Object.hasOwn(result.qemuLaunch, "wide"), false);
        assert.ok(JSON.stringify(result).length < STAGE3_LAUNCH_DIAGNOSTIC_CONSTANTS.MAX_RESULT_CHARACTERS);
    });

    it("keeps the guest receipt in the bounded summary that announces it", async () => {
        const wide = Object.fromEntries(Array.from({length: 4096}, (_value, index) =>
            [`member-${index}`, "b".repeat(512)]));
        const fixture = operations({async launchBaselineGuest() {
            throw buildStage3LaunchFailure("baseline guest did not return the CPU calibration envelope",
                buildStage3LaunchDiagnostic({...launchFailure(), guestFailure: guestReceipt(),
                    failureDiagnostic: {...deadlineDiagnostic(), wide}}));
        }});
        const result = await runWindowsCpuFloorStage3(request(), fixture.value);
        assert.equal(result.qemuLaunch.omitted, STAGE3_LAUNCH_DIAGNOSTIC_CONSTANTS.OMITTED_DIAGNOSTIC_MARKER);
        // A summary that says a receipt was observed must still carry it.
        assert.equal(result.qemuLaunch.guestFailureObserved, true);
        assert.equal(result.qemuLaunch.guestFailure.failure, "executor-invocation");
        assert.ok(JSON.stringify(result.qemuLaunch).length <
            STAGE3_LAUNCH_DIAGNOSTIC_CONSTANTS.MAX_DIAGNOSTIC_CHARACTERS);
    });

    it("drops a receipt that would put the bounded summary back over budget", async () => {
        // Wide rather than deep: a single oversized string would be dropped by the payload
        // transform long before the budget guard below ever sees it.
        const oversizedReceipt = {...guestReceipt(), ...Object.fromEntries(
            Array.from({length: 4096}, (_value, index) => [`detail-${index}`, "c".repeat(512)]))};
        const diagnostic = buildStage3LaunchDiagnostic({...launchFailure(), guestFailure: oversizedReceipt,
            failureDiagnostic: {...deadlineDiagnostic(), wide: Object.fromEntries(
                Array.from({length: 4096}, (_value, index) => [`member-${index}`, "b".repeat(512)]))}});
        const fixture = operations({async launchBaselineGuest() {
            throw buildStage3LaunchFailure("baseline guest did not return the CPU calibration envelope",
                diagnostic);
        }});
        const result = await runWindowsCpuFloorStage3(request(), fixture.value);
        // The flag survives where the receipt cannot; the budget is what the result file depends on.
        assert.equal(result.qemuLaunch.guestFailureObserved, true);
        assert.equal(Object.hasOwn(result.qemuLaunch, "guestFailure"), false);
        assert.ok(JSON.stringify(result.qemuLaunch).length <
            STAGE3_LAUNCH_DIAGNOSTIC_CONSTANTS.MAX_DIAGNOSTIC_CHARACTERS);
    });

    it("accepts a baseline launch torn down after a completion record, and nothing else killed", async () => {
        const retainedStage2Bytes = Buffer.from(JSON.stringify(stage2Observation()), "utf8");
        const input = request();
        input.stage2.result = {...input.stage2.result, bytes: String(retainedStage2Bytes.length),
            sha256: crypto.createHash("sha256").update(retainedStage2Bytes).digest("hex")};
        const result = await runWindowsCpuFloorStage3(input, operations().value);
        assert.equal(result.status, "observed", result.failure);

        /* The shape the host produces when the guest published and Windows then refused to go down. */
        const forced = {...result, qemuProcess: {...result.qemuProcess, exitCode: null, signal: null,
            terminationReason: "post-completion-teardown-timeout"}};
        const accepted = validateCompletedStage3Result(forced, input, retainedStage2Bytes);
        assert.equal(accepted.accepted, true);
        /* Waiving the exit status must not have waived what the run claims about itself. */
        assert.equal(forced.qualifying, false);
        assert.equal(forced.releaseGateCleared, false);
        assert.equal(forced.qemuProcess.cleanupProven, true);

        /*
         * Every neighbouring shape stays refused: an ordinary deadline kill, an unknown reason, and
         * the same forced teardown with any cleanup proof missing.
         */
        for (const qemuProcess of [
            {...forced.qemuProcess, terminationReason: "deadline"},
            {...forced.qemuProcess, terminationReason: "efi-shell-fallback"},
            {...forced.qemuProcess, terminationReason: "post-completion-teardown"},
            {...forced.qemuProcess, cleanupProven: false},
            {...forced.qemuProcess, treeGone: false},
            {...forced.qemuProcess, qemuPidAbsentAfter: false},
            {...forced.qemuProcess, timedOut: true},
            {...result.qemuProcess, exitCode: 1},
            {...result.qemuProcess, signal: "SIGKILL"}
        ]) assert.throws(() => validateCompletedStage3Result({...result, qemuProcess}, input, retainedStage2Bytes),
            /Stage 3 QEMU cleanup is not proven|invalid|differs/u, JSON.stringify(qemuProcess.terminationReason));
    });

    it("never accepts a forced post-completion teardown for the replayed Stage 2 guest", async () => {
        const fixture = operations({async replayStage2(input) { fixture.calls.push("stage2");
            return {identity: input.identity, guestEvidence: stage2GuestEvidence(),
                result: {...stage2Observation(), qemuProcess: {...stage2Observation().qemuProcess,
                    exitCode: null, terminationReason: "post-completion-teardown-timeout"}}}; }});
        const result = await runWindowsCpuFloorStage3(request(), fixture.value);
        assert.equal(result.status, "failed");
        assert.equal(result.stage, "stage2-replay");
    });

    it("pins the completion contract shared with the hosted monitor", () => {
        assert.equal(STAGE3_BUDGET_CONSTANTS.RESERVATION_LABEL, STAGE3_BASELINE_RESERVATION_LABEL);
        assert.equal(STAGE3_BUDGET_CONSTANTS.POST_COMPLETION_TERMINATION_REASON, POST_COMPLETION_TERMINATION_REASON);
    });

});
