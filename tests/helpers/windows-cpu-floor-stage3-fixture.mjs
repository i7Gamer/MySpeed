import crypto from "node:crypto";

import {runWindowsCpuFloorStage3, validateCompletedStage3Result} from "../../scripts/qualification/linux-windows-cpu-floor-stage3.mjs";
import {PACKAGE_ROOTS, STAGE2_PROVENANCE, TOP_LEVEL_PACKAGE_PINS, WINDOWS_SYSTEM_TOOL_PATHS,
    buildQemuArguments as buildStage2QemuArguments, validatePackageClosure} from
    "../../scripts/qualification/linux-windows-cpu-floor-stage2.mjs";
import {buildWindowsMsiSetupCompleteActivation, getCompletedWindowsMsiActivationEvidence} from
    "../../scripts/qualification/windows-msi-post-setup-activation.mjs";

const DEFAULT_SOURCE_SHA = "1".repeat(40);
const DEFAULT_CANDIDATE_SOURCE_SHA = "4".repeat(40);
const DEFAULT_EVENT_SHA = "3".repeat(40);
const DEFAULT_NONCE = "2".repeat(32);
const OUTPUT_DISK_BYTES = 67_108_864;
const SHA = character => character.repeat(64);
const encode = value => {
    const bytes = Buffer.from(`${JSON.stringify(value)}\n`, "utf8");
    return {bytes, bytesBase64: bytes.toString("base64"), sha256: crypto.createHash("sha256").update(bytes).digest("hex")};
};
const rootOwnership = () => ({uid: "0", gid: "0", mode: "555", ordinaryUserWritable: false});

export async function buildAcceptedStage3Fixture(overrides = {}) {
    const sourceSha = overrides.sourceSha ?? DEFAULT_SOURCE_SHA;
    const candidateSourceSha = overrides.candidateSourceSha ?? DEFAULT_CANDIDATE_SOURCE_SHA;
    const eventSha = overrides.eventSha ?? DEFAULT_EVENT_SHA;
    const runId = overrides.runId ?? "123";
    const runAttempt = overrides.runAttempt ?? "1";
    const nonce = overrides.nonce ?? DEFAULT_NONCE;
    const root = `/home/runner/work/_temp/myspeed-stage3-${nonce}`;
    const stage2Root = `/home/runner/work/_temp/myspeed-windows-cpu-floor-${nonce}`;
    const portableRoot = `/tmp/myspeed-windows-cpu-floor-tools-${nonce}`;
    const context = {schemaVersion: 1, repository: "i7Gamer/MySpeed", sourceSha, eventSha, runId, runAttempt, nonce,
        environment: {GITHUB_ACTIONS: "true", CI: "true", RUNNER_OS: "Linux", RUNNER_ARCH: "X64",
            RUNNER_ENVIRONMENT: "github-hosted", ImageOS: "ubuntu24", ImageVersion: "20260901.1"}};
    const stage3Paths = {root, systemDisk: `${root}/stage3.qcow2`, seedIso: `${root}/baseline-seed.iso`,
        outputDisk: `${root}/baseline-output.img`, ovmfVars: `${root}/OVMF_VARS.fd`,
        qemuPid: `${root}/baseline-qemu.pid`, serialLog: `${root}/baseline-serial.log`};
    const stage2Paths = {root: stage2Root, packageRoot: `${stage2Root}/packages`, portableRoot,
        windowsIso: `${stage2Root}/windows.iso`, installWim: `${stage2Root}/install.wim`,
        seedIso: `${stage2Root}/seed.iso`, outputDisk: `${stage2Root}/output.img`,
        systemDisk: `${stage2Root}/system.qcow2`, ovmfVars: `${stage2Root}/OVMF_VARS.fd`,
        serialLog: `${stage2Root}/serial.log`, probeRoot: `${stage2Root}/probes`, qemuPid: `${stage2Root}/qemu.pid`};
    const portable = (relative, character, invocation = null) => ({path: `${portableRoot}/${relative}`, bytes: "4096",
        sha256: SHA(character), ownership: rootOwnership(), ...(invocation === null ? {} :
            {invocationPath: `${portableRoot}/${invocation}`})});
    const rawClosure = {schemaVersion: 1, snapshot: structuredClone(STAGE2_PROVENANCE.ubuntuSnapshot),
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
        packages: TOP_LEVEL_PACKAGE_PINS.map(value => ({...value, dependsOn: []}))};
    const packageClosure = validatePackageClosure(rawClosure);
    const toolchain = {capabilities: {accelerator: "kvm", cpuModels: ["Westmere-v2"], machines: ["q35"],
        devices: ["ich9-ahci", "ide-cd", "ide-hd", "isa-serial"]},
    genisoimage: portable("usr/bin/genisoimage", "1", "usr/bin/genisoimage"),
    installedFilesManifest: {bytes: "8192", sha256: SHA("2")},
    licensesManifest: {bytes: "8192", sha256: SHA("3")},
    mcopy: portable("usr/bin/mtools", "4", "usr/bin/mcopy"),
    mformat: portable("usr/bin/mtools", "4", "usr/bin/mformat"),
    ovmfCode: portable("usr/share/OVMF/OVMF_CODE.fd", "5"),
    ovmfVarsTemplate: portable("usr/share/OVMF/OVMF_VARS.fd", "6"),
    firmware: {searchPath: `${portableRoot}/usr/share/qemu`,
        kvmvapic: portable("usr/share/qemu/kvmvapic.bin", "e"),
        vga: portable("usr/share/seabios/vgabios-stdvga.bin", "e")},
    packageClosureSha256: crypto.createHash("sha256").update(JSON.stringify(packageClosure)).digest("hex"),
    qemu: {...portable("usr/bin/qemu-system-x86_64", "8", "usr/bin/qemu-system-x86_64"),
        version: "QEMU emulator version 8.2.2 (Debian 1:8.2.2+ds-0ubuntu1.18)"},
    qemuImg: portable("usr/bin/qemu-img", "9", "usr/bin/qemu-img"),
    runtime: {loader: portable("usr/lib/x86_64-linux-gnu/ld-linux-x86-64.so.2", "a"),
        libraryPath: [`${portableRoot}/usr/lib/x86_64-linux-gnu`, `${portableRoot}/usr/lib/7-zip`]},
    sevenZip: portable("usr/lib/7-zip/7z.so", "b", "usr/lib/7-zip/7z.so"),
    wiminfo: portable("usr/bin/wimlib-imagex", "c", "usr/bin/wiminfo")};
    const roles = ["avx", "avx2", "cpuid", "illegal", "known-bad", "known-good", "popcnt", "sse42"];
    const defaultProbeArtifact = {schemaVersion: 1, repository: context.repository, sourceSha, runId, runAttempt,
        artifactId: overrides.probeArtifactId ?? "1234567890", artifactName: "windows-cpu-readiness-evidence",
        archive: {bytes: "33554432", sha256: SHA("a")},
        innerManifest: {name: "result.json", bytes: "262144", sha256: SHA("b")},
        files: roles.map((role, index) => ({role, name: `${role.replaceAll("-", "_")}.exe`,
            bytes: String(4096 + index), sha256: String(index + 1).repeat(64).slice(0, 64)}))};
    const probeArtifact = structuredClone(overrides.probeArtifact ?? defaultProbeArtifact);
    const probes = {archive: probeArtifact.archive, innerManifest: probeArtifact.innerManifest,
        files: probeArtifact.files.map(value => ({...value, path: `${stage2Root}/probes/${value.name}`}))};
    const rawCpuid = {schemaVersion: 1, kind: "cpuid", maxBasicLeaf: 7,
        leaf1: {eax: "0x00000000", ebx: "0x00000000", ecx: "0x00900000", edx: "0x00000000"},
        leaf7Subleaf0: {eax: "0x00000000", ebx: "0x00000000", ecx: "0x00000000", edx: "0x00000000"},
        xcr0: null, features: {sse42: true, popcnt: true, osxsave: false, avx: false, avx2: false}};
    const controls = {"known-good": 42, "known-bad": 13, sse42: 2_276_049_685, popcnt: 32};
    const activation = getCompletedWindowsMsiActivationEvidence(
        buildWindowsMsiSetupCompleteActivation({repository: context.repository, sourceSha: context.sourceSha,
            eventSha: context.eventSha, runId: context.runId, runAttempt: context.runAttempt, nonce: context.nonce}));
    const systemTools = WINDOWS_SYSTEM_TOOL_PATHS.map((tool, index) => ({...tool, bytes: String(index + 1),
        sha256: String(index + 1).repeat(64)}));
    const rawGuest = {schemaVersion: 1, nonce, runs: [{role: "cpuid", exitCode: 0,
        stdoutBase64: Buffer.from(`${JSON.stringify(rawCpuid)}\n`).toString("base64"), stderrBase64: ""},
    ...Object.entries(controls).map(([role, result]) => ({role, exitCode: role === "known-bad" ? 19 : 0,
        stdoutBase64: Buffer.from(`${JSON.stringify({schemaVersion: 1, kind: role, result})}\n`).toString("base64"),
        stderrBase64: ""})), ...["illegal", "avx", "avx2"].map(role => ({role, exitCode: 3_221_225_501,
        stdoutBase64: "", stderrBase64: ""}))],
    network: {hardwareNics: 0, enabledNonLoopbackInterfaces: 0, nonLoopbackRoutes: 0},
    activation, systemTools};
    const rawGuestEncoding = encode(rawGuest);
    const stage2GuestIdentity = {path: `/home/runner/work/_temp/myspeed-stage2-transport-${nonce}/guest-result.json`,
        bytes: String(rawGuestEncoding.bytes.length), sha256: rawGuestEncoding.sha256};
    const stage2Observation = {schemaVersion: 1, status: "observed", stage: "complete",
        classification: "github-hosted-windows-cpu-floor-stage2-nonqualifying", qualifying: false,
        releaseGateCleared: false, cpuCalibrationAccepted: true, cleanupProven: true, context,
        privilegeMode: "reviewed-sudo-kvm", qemuProcess: {cleanupProven: true, treeGone: true,
            qemuPidAbsentAfter: true, exitCode: 0, signal: null, timedOut: false, qemuPid: 2200,
            qemuStartTicks: "123456", processGroupId: 2200, launcherExecutablePath: toolchain.runtime.loader.path,
            terminationReason: null}, guest: {schemaVersion: 1, status: "observed",
            cpu: {sse42: true, popcnt: true, avx: false, avx2: false, osxsave: false, xcr0: null},
            instructions: {sse42: "completed", popcnt: "completed", avx: "illegal-instruction",
                avx2: "illegal-instruction"}, network: rawGuest.network,
            output: {path: `${stage2Root}/output.img`, bytes: String(OUTPUT_DISK_BYTES), sha256: SHA("0")}},
        argv: buildStage2QemuArguments({paths: stage2Paths, toolchain}), packageClosure, probeArtifact, probes,
        installWim: {path: `${stage2Root}/install.wim`, sourceIsoSha256: SHA("d"), bytes: "5000000000",
            sha256: SHA("5")},
        installWimRemoval: {path: `${stage2Root}/install.wim`, sha256: SHA("5"), removed: true},
        media: {seedIso: {path: `${stage2Root}/seed.iso`, bytes: "1048576", sha256: SHA("8"),
            sourceManifestSha256: SHA("6"), format: "iso9660", volumeLabel: "MYSPEEDSEED"},
        outputDisk: {path: `${stage2Root}/output.img`, bytes: String(OUTPUT_DISK_BYTES), sha256: SHA("7"),
            format: "raw-fat", volumeLabel: "MYSPEEDOUT"},
        systemDisk: {path: `${stage2Root}/system.qcow2`, bytes: "196616", sha256: SHA("3"),
            virtualBytes: "51539607552", format: "qcow2"},
        ovmfVars: {path: `${stage2Root}/OVMF_VARS.fd`, sha256: toolchain.ovmfVarsTemplate.sha256}},
        iso: {bytes: "8152356864",
            etag: '"0x60A8C190FBB54AF58E40BA049FF290D098101E0EAD343CE912A1DC685219BE85"',
            finalUrl: STAGE2_PROVENANCE.windowsIso.finalUrl, sha256: SHA("d"),
            digestProvenance: "windows-official-https-local-digest", publisherDigestMatched: null},
        selectedImage: {architecture: "x64", editionId: "ServerStandardEval", index: 2,
            installationType: "Server", name: "Windows Server 2025 SERVERSTANDARD",
            totalBytes: "15000000000"}, toolchain};
    const stage2Encoding = encode(stage2Observation);
    const stage2Identity = {path: `/home/runner/work/_temp/myspeed-stage2-transport-${nonce}/stage2-result.json`,
        bytes: String(stage2Encoding.bytes.length), sha256: stage2Encoding.sha256};
    const candidate = structuredClone(overrides.candidate ?? {
        artifactId: "563103679",
        artifactName: "MySpeed-windows-x64-baseline.exe",
        releaseAssetId: "563103679",
        releaseAssetDigest: `sha256:${SHA("d")}`,
        archive: {bytes: "1048576", sha256: SHA("c")},
        sourceSha: candidateSourceSha,
        runId: "34829932391",
        runAttempt: "1",
        tagName: "v1.6.1",
        file: {name: "MySpeed.exe", bytes: "524288", sha256: SHA("d")},
        qualificationSummary: {name: "qualification-summary.json", bytes: "8192", sha256: SHA("e")},
        manifest: {name: "qualification-manifest.json", bytes: "65536", sha256: SHA("f")}});
    const request = {schemaVersion: 1, context, profile: "baseline-cpu",
        authorization: {scope: "windows-baseline-cpu-floor-full-runtime", qemu: true, candidate: true,
            confirmation: "RUN-WINDOWS-BASELINE-CPU-FLOOR"},
        stage2: {result: stage2Identity, guestResult: stage2GuestIdentity}, candidate, paths: stage3Paths};
    const expected = {ping: "123.456", resultId: "qualification-seed-row", passwordValueSha256: SHA("6")};
    const summary = {status: "passed", exit: 0, mode: "full", sourceSha: candidate.sourceSha,
        artifactSha256: candidate.file.sha256, platform: "win32", architecture: "x64",
        command: [candidate.file.name === "MySpeed.exe" ? "C:\\MyspeedStage3\\candidate\\MySpeed.exe" : ""],
        processes: ["populated-first-boot", "populated-restart", "fresh-no-config-reset"]
            .map((scenario, index) => ({scenario, pid: 100 + index})),
        databaseChecks: ["preseeded-input", "after-first-shutdown", "after-second-shutdown"]
            .map(scenario => ({scenario, ...expected})).concat([{scenario: "fresh-no-config-reset",
                integrity: "ok", configTable: false}]),
        openGraphChecks: [{scenario: "populated-first-boot", elapsedMs: 10},
            {scenario: "populated-restart", elapsedMs: 12}],
        networkIsolation: {kind: "qemu-nic-none-windows-guest", ...rawGuest.network},
        shutdownProofs: ["populated-first-boot", "populated-restart", "fresh-no-config-reset"].map(scenario => ({scenario,
            controllerLifecyclePassed: true, candidateExited: true,
            candidateExitCode: scenario === "fresh-no-config-reset" ? 113 : 0, forced: false,
            jobActiveProcesses: 0, handlesClosed: true}))};
    const cpuidEncoding = encode(rawCpuid); const summaryEncoding = encode(summary);
    const guest = {schemaVersion: 1, status: "observed", profile: "baseline-cpu", context,
        candidate: {sourceSha: candidate.sourceSha, sha256: candidate.file.sha256, artifactName: candidate.artifactName},
        cpu: {model: "Westmere-v2", cpuidBytesBase64: cpuidEncoding.bytesBase64,
            cpuidSha256: cpuidEncoding.sha256, sse42: true, popcnt: true, avx: false, avx2: false,
            osxsave: false, xcr0: null}, network: rawGuest.network,
        verifier: {summary, summaryBytesBase64: summaryEncoding.bytesBase64, summarySha256: summaryEncoding.sha256},
        releaseGatesCleared: []};
    const guestEncoding = encode(guest);
    const guestEvidence = {identity: {path: `${root}/baseline-result.json`, bytes: String(guestEncoding.bytes.length),
        sha256: guestEncoding.sha256}, bytesBase64: guestEncoding.bytesBase64, result: guest,
        sourceOutputDisk: {path: stage3Paths.outputDisk, bytes: String(OUTPUT_DISK_BYTES), sha256: SHA("0")}};
    const process = {exitCode: 0, signal: null, timedOut: false, cleanupProven: true, treeGone: true,
        qemuPid: 1200, qemuStartTicks: "123456", processGroupId: 1200, qemuPidAbsentAfter: true,
        launcherExecutablePath: toolchain.runtime.loader.path, terminationReason: null};
    const operations = {async replayStage2(input) { return {identity: input.identity, result: stage2Observation,
        guestEvidence: {identity: stage2GuestIdentity, bytesBase64: rawGuestEncoding.bytesBase64}}; },
    async acquireCandidate(input) { return {candidate: input.candidate,
        stagedFile: {...input.candidate.file, path: `${root}/candidate/MySpeed.exe`},
        stagedSummary: {...input.candidate.qualificationSummary, path: `${root}/candidate/qualification-summary.json`},
        stagedManifest: {...input.candidate.manifest, path: `${root}/candidate/qualification-manifest.json`}}; },
    async prepareBaselineMedia() { return {seedIso: {path: stage3Paths.seedIso, bytes: "4096", sha256: SHA("8")},
        outputDisk: {path: stage3Paths.outputDisk, bytes: String(OUTPUT_DISK_BYTES), sha256: SHA("9")},
        systemDisk: {path: stage3Paths.systemDisk, bytes: "8388608", sha256: SHA("a"),
            virtualBytes: "51539607552"}, ovmfVars: {path: stage3Paths.ovmfVars, bytes: "4096", sha256: SHA("b")}}; },
    async launchBaselineGuest(input) { return {argv: input.argv, process,
        outputDisk: {path: stage3Paths.outputDisk, bytes: String(OUTPUT_DISK_BYTES), sha256: SHA("0")}}; },
    async collectBaselineGuestResult() { return guestEvidence; }};
    const completedResult = await runWindowsCpuFloorStage3(request, operations);
    if (completedResult.status !== "observed") throw new Error(completedResult.failure);
    validateCompletedStage3Result(completedResult, request, stage2Encoding.bytes);
    return {request, retainedStage2Bytes: stage2Encoding.bytes,
        retainedStage2GuestBytes: rawGuestEncoding.bytes, completedResult};
}
