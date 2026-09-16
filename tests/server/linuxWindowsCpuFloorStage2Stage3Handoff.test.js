import assert from "node:assert/strict";
import crypto from "node:crypto";
import {describe, it} from "node:test";

import {
    PACKAGE_ROOTS,
    STAGE2_PROVENANCE,
    TOP_LEVEL_PACKAGE_PINS,
    runWindowsCpuFloorStage2,
    validatePackageClosure
} from "../../scripts/qualification/linux-windows-cpu-floor-stage2.mjs";
import {STAGE2_LIMITS} from "../../scripts/qualification/linux-windows-cpu-floor-admission.mjs";
import {
    runWindowsCpuFloorStage3,
    validateCompletedStage3Result
} from "../../scripts/qualification/linux-windows-cpu-floor-stage3.mjs";
import {createHostedStage3Operations} from "../../scripts/qualification/linux-windows-cpu-floor-stage3-hosted.mjs";
import {
    buildWindowsMsiSetupCompleteActivation,
    getCompletedWindowsMsiActivationEvidence
} from "../../scripts/qualification/windows-msi-post-setup-activation.mjs";

const NONCE = "0123456789abcdef0123456789abcdef";
const SOURCE_SHA = "1".repeat(40);
const CANDIDATE_SOURCE_SHA = "4".repeat(40);
const EVENT_SHA = "3".repeat(40);
const RUN_ID = "123";
const RUN_ATTEMPT = "1";
const SHA = character => character.repeat(64);
const HASH = value => crypto.createHash("sha256").update(value).digest("hex");
const BOOT_CONFIRMATION = "single-enter-before-setup-v1";
const bootInput = () => ({
    kind: "installer-boot-confirmation",
    qcode: "ret",
    holdMilliseconds: 100,
    requestedOffsetMilliseconds: 2000,
    sentOffsetMilliseconds: 2001,
    acknowledged: true
});

const ROOT_STAGE2 = `/home/runner/work/_temp/myspeed-windows-cpu-floor-${NONCE}`;
const ROOT_STAGE3 = `/home/runner/work/_temp/myspeed-stage3-${NONCE}`;
const PORTABLE_ROOT = `/tmp/myspeed-windows-cpu-floor-tools-${NONCE}`;
const TRANSPORT_ROOT = `/home/runner/work/_temp/myspeed-stage2-transport-${NONCE}`;
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);

function context() {
    return {
        schemaVersion: 1,
        repository: "i7Gamer/MySpeed",
        sourceSha: SOURCE_SHA,
        eventSha: EVENT_SHA,
        runId: RUN_ID,
        runAttempt: RUN_ATTEMPT,
        nonce: NONCE,
        environment: {
            GITHUB_ACTIONS: "true",
            CI: "true",
            RUNNER_OS: "Linux",
            RUNNER_ARCH: "X64",
            RUNNER_ENVIRONMENT: "github-hosted",
            ImageOS: "ubuntu24",
            ImageVersion: "20260907.1"
        }
    };
}

function stage2Paths() {
    return {
        root: ROOT_STAGE2,
        packageRoot: `${ROOT_STAGE2}/packages`,
        portableRoot: PORTABLE_ROOT,
        windowsIso: `${ROOT_STAGE2}/windows.iso`,
        installWim: `${ROOT_STAGE2}/install.wim`,
        seedIso: `${ROOT_STAGE2}/seed.iso`,
        outputDisk: `${ROOT_STAGE2}/output.img`,
        systemDisk: `${ROOT_STAGE2}/system.qcow2`,
        ovmfVars: `${ROOT_STAGE2}/OVMF_VARS.fd`,
        serialLog: `${ROOT_STAGE2}/serial.log`,
        probeRoot: `${ROOT_STAGE2}/probes`,
        qemuPid: `${ROOT_STAGE2}/qemu.pid`
    };
}

function stage3Paths() {
    return {
        root: ROOT_STAGE3,
        systemDisk: `${ROOT_STAGE3}/stage3.qcow2`,
        seedIso: `${ROOT_STAGE3}/baseline-seed.iso`,
        outputDisk: `${ROOT_STAGE3}/baseline-output.img`,
        ovmfVars: `${ROOT_STAGE3}/OVMF_VARS.fd`,
        qemuPid: `${ROOT_STAGE3}/baseline-qemu.pid`,
        serialLog: `${ROOT_STAGE3}/baseline-serial.log`
    };
}

function activationEvidence() {
    const ctx = context();
    return getCompletedWindowsMsiActivationEvidence(
        buildWindowsMsiSetupCompleteActivation({
            repository: ctx.repository,
            sourceSha: ctx.sourceSha,
            eventSha: ctx.eventSha,
            runId: ctx.runId,
            runAttempt: ctx.runAttempt,
            nonce: ctx.nonce
        })
    );
}

const SYSTEM_TOOLS = [
    {role: "msiexec", path: "C:\\Windows\\System32\\msiexec.exe", bytes: "1024", sha256: "8".repeat(64)},
    {role: "sc", path: "C:\\Windows\\System32\\sc.exe", bytes: "2048", sha256: "9".repeat(64)},
    {role: "powershell", path: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
        bytes: "4096", sha256: "b".repeat(64)}
];

function admission() {
    return {
        schemaVersion: 1,
        status: "admitted",
        admitted: true,
        classification: "github-hosted-windows-cpu-floor-admission-nonqualifying",
        qualifying: false,
        releaseGateCleared: false,
        mediaAcquisitionAuthorized: false,
        qemuLaunchAuthorized: false,
        context: context(),
        kvm: {
            ordinary: {bytes: 1, sha256: SHA("a"), capability: "permission-denied"},
            combined: {bytes: 1, sha256: SHA("d"), capability: "usable", retryPerformed: true}
        },
        budget: structuredClone(STAGE2_LIMITS),
        observations: {},
        reasons: []
    };
}

function packageClosure() {
    const packages = TOP_LEVEL_PACKAGE_PINS.map(value => ({...value, dependsOn: []}));
    packages.push({
        name: "libfixture",
        version: "1.0",
        architecture: "amd64",
        filename: "pool/libfixture_1.0_amd64.deb",
        bytes: "2048",
        sha256: SHA("f"),
        dependsOn: []
    });
    packages[0].dependsOn = ["libfixture:amd64=1.0"];
    packages.sort((left, right) => `${left.name}:${left.architecture}=${left.version}`.localeCompare(
        `${right.name}:${right.architecture}=${right.version}`, "en"));
    return {
        schemaVersion: 1,
        snapshot: structuredClone(STAGE2_PROVENANCE.ubuntuSnapshot),
        indexes: [
            {suite: "noble", component: "main", architecture: "amd64", path: "dists/noble/main/binary-amd64/Packages.xz",
                bytes: "100", sha256: SHA("1"), listedSha256: SHA("1"), inReleaseSha256: SHA("3")},
            {suite: "noble-updates", component: "main", architecture: "amd64",
                path: "dists/noble-updates/main/binary-amd64/Packages.xz", bytes: "101", sha256: SHA("2"),
                listedSha256: SHA("2"), inReleaseSha256: SHA("4")}
        ],
        releases: [
            {suite: "noble", inReleasePath: "dists/noble/InRelease", bytes: "200", sha256: SHA("3"),
                signatureVerified: true, signerFingerprint: STAGE2_PROVENANCE.ubuntuArchiveSignerFingerprint},
            {suite: "noble-updates", inReleasePath: "dists/noble-updates/InRelease", bytes: "201",
                sha256: SHA("4"), signatureVerified: true,
                signerFingerprint: STAGE2_PROVENANCE.ubuntuArchiveSignerFingerprint}
        ],
        roots: [...PACKAGE_ROOTS],
        packages
    };
}

const rootOwnership = () => ({uid: "0", gid: "0", mode: "555", ordinaryUserWritable: false});
const portable = (relative, character, invocation = null) => ({
    path: `${PORTABLE_ROOT}/${relative}`,
    bytes: "4096",
    sha256: SHA(character),
    ownership: rootOwnership(),
    ...(invocation === null ? {} : {invocationPath: `${PORTABLE_ROOT}/${invocation}`})
});

function toolchain() {
    return {
        capabilities: {
            cpuModels: ["Westmere-v2"],
            machines: ["q35"],
            devices: ["ich9-ahci", "ide-cd", "ide-hd", "isa-serial", "VGA", "qemu-xhci", "usb-kbd"],
            accelerator: "kvm"
        },
        genisoimage: portable("usr/bin/genisoimage", "1", "usr/bin/genisoimage"),
        installedFilesManifest: {bytes: "8192", sha256: SHA("2")},
        licensesManifest: {bytes: "8192", sha256: SHA("3")},
        mcopy: portable("usr/bin/mtools", "4", "usr/bin/mcopy"),
        mformat: portable("usr/bin/mtools", "4", "usr/bin/mformat"),
        ovmfCode: portable("usr/share/OVMF/OVMF_CODE_4M.fd", "5"),
        ovmfVarsTemplate: portable("usr/share/OVMF/OVMF_VARS_4M.fd", "6"),
        firmware: {
            searchPath: `${PORTABLE_ROOT}/usr/share/qemu`,
            kvmvapic: portable("usr/share/qemu/kvmvapic.bin", "e"),
            vga: portable("usr/share/seabios/vgabios-stdvga.bin", "e")
        },
        packageClosureSha256: HASH(JSON.stringify(validatePackageClosure(packageClosure()))),
        qemu: {
            ...portable("usr/bin/qemu-system-x86_64", "8", "usr/bin/qemu-system-x86_64"),
            version: "QEMU emulator version 8.2.2 (Debian 1:8.2.2+ds-0ubuntu1.18)"
        },
        qemuImg: portable("usr/bin/qemu-img", "9", "usr/bin/qemu-img"),
        runtime: {
            loader: portable("usr/lib/x86_64-linux-gnu/ld-linux-x86-64.so.2", "a"),
            libraryPath: [`${PORTABLE_ROOT}/usr/lib/x86_64-linux-gnu`, `${PORTABLE_ROOT}/usr/lib/7zip`]
        },
        sevenZip: portable("usr/lib/7zip/7z", "b", "usr/lib/7zip/7z"),
        wiminfo: portable("usr/bin/wimlib-imagex", "c", "usr/bin/wiminfo")
    };
}

const PROBE_ROLES = ["avx", "avx2", "cpuid", "illegal", "known-bad", "known-good", "popcnt", "sse42"];
function probeArtifact() {
    return {
        schemaVersion: 1,
        repository: "i7Gamer/MySpeed",
        sourceSha: "9".repeat(40),
        runId: "34763667695",
        runAttempt: "1",
        artifactId: "1234567890",
        artifactName: "windows-cpu-readiness-evidence",
        archive: {bytes: "33554432", sha256: SHA("a")},
        innerManifest: {name: "result.json", bytes: "262144", sha256: SHA("b")},
        files: PROBE_ROLES.map((role, index) => ({
            role,
            name: `${role.replaceAll("-", "_")}.exe`,
            bytes: String(4096 + index),
            sha256: String(index + 1).repeat(64).slice(0, 64)
        }))
    };
}

function imageInventory() {
    return [
        {index: 1, name: "Windows Server 2025 Standard Evaluation", architecture: "x64",
            editionId: "ServerStandardEval", installationType: "Server Core", totalBytes: "15000000000"},
        {index: 2, name: "Windows Server 2025 SERVERSTANDARD", architecture: "x64",
            editionId: "ServerStandardEval", installationType: "Server", totalBytes: "24699866265"}
    ];
}

function createRawGuestOutput(nonce, overrides = {}) {
    const rawCpuid = {
        schemaVersion: 1,
        kind: "cpuid",
        maxBasicLeaf: 7,
        leaf1: {eax: "0x00000000", ebx: "0x00000000", ecx: "0x00900000", edx: "0x00000000"},
        leaf7Subleaf0: {eax: "0x00000000", ebx: "0x00000000", ecx: "0x00000000", edx: "0x00000000"},
        xcr0: null,
        features: {sse42: true, popcnt: true, osxsave: false, avx: false, avx2: false},
        ...(overrides.rawCpuid ?? {})
    };
    const controls = {"known-good": 42, "known-bad": 13, sse42: 2_276_049_685, popcnt: 32};
    const runs = [
        {role: "cpuid", exitCode: 0, stdoutBase64: Buffer.from(`${JSON.stringify(rawCpuid)}\n`).toString("base64"), stderrBase64: ""},
        ...Object.entries(controls).map(([role, result]) => ({
            role,
            exitCode: role === "known-bad" ? 19 : 0,
            stdoutBase64: Buffer.from(`${JSON.stringify({schemaVersion: 1, kind: role, result})}\n`).toString("base64"),
            stderrBase64: ""
        })),
        ...["illegal", "avx", "avx2"].map(role => ({role, exitCode: 3_221_225_501, stdoutBase64: "", stderrBase64: ""}))
    ];
    return {
        schemaVersion: 1,
        nonce,
        runs: overrides.runs ?? runs,
        network: overrides.network ?? {hardwareNics: 0, enabledNonLoopbackInterfaces: 0, nonLoopbackRoutes: 0},
        activation: overrides.activation ?? activationEvidence(),
        systemTools: overrides.systemTools ?? structuredClone(SYSTEM_TOOLS)
    };
}

function stage2InertOperations(rawGuest, overrides = {}) {
    const calls = [];
    const p = stage2Paths();
    const earlyBoot = () => ({
        schemaVersion: 1,
        kind: "qemu-early-boot-observation",
        inputSent: false,
        version: {major: 8, minor: 2, micro: 2},
        status: "running",
        running: true,
        screenshots: [1, 2].map(index => ({
            path: `${p.root}/early-boot-${index}.png`,
            bytes: String(PNG.length),
            sha256: HASH(PNG),
            bytesBase64: PNG.toString("base64")
        }))
    });
    const guestEvidence = () => ({
        schemaVersion: 1,
        status: "observed",
        cpu: {sse42: true, popcnt: true, osxsave: false, avx: false, avx2: false, xcr0: null},
        instructions: {sse42: "completed", popcnt: "completed", avx: "illegal-instruction", avx2: "illegal-instruction"},
        network: {hardwareNics: 0, enabledNonLoopbackInterfaces: 0, nonLoopbackRoutes: 0},
        activation: activationEvidence(),
        systemTools: structuredClone(SYSTEM_TOOLS),
        output: {path: p.outputDisk, bytes: "67108864", sha256: SHA("0")}
    });
    const op = {
        async resolveSignedPackageClosure() { calls.push("resolve"); return packageClosure(); },
        async acquirePackages(input) {
            calls.push("acquire-packages");
            return {
                complete: true,
                packages: input.packageClosure.packages.map(value => ({
                    reference: `${value.name}:${value.architecture}=${value.version}`,
                    path: `${input.paths.packageRoot}/${value.name}.deb`,
                    bytes: value.bytes,
                    sha256: value.sha256
                }))
            };
        },
        async extractPortableTools() { calls.push("extract-tools"); return toolchain(); },
        async acquireWindowsIso() {
            calls.push("acquire-iso");
            return {
                finalUrl: STAGE2_PROVENANCE.windowsIso.finalUrl,
                bytes: STAGE2_PROVENANCE.windowsIso.bytes,
                etag: STAGE2_PROVENANCE.windowsIso.strongEtag,
                observerA: {id: "same-handle-pass-1", sha256: SHA("4")},
                observerB: {id: "same-handle-pass-2", sha256: SHA("4")}
            };
        },
        async acquireProbeClosure(input) {
            calls.push("acquire-probes");
            return {
                archive: input.probeArtifact.archive,
                innerManifest: input.probeArtifact.innerManifest,
                files: input.probeArtifact.files.map(value => ({...value, path: `${input.paths.probeRoot}/${value.name}`}))
            };
        },
        async extractInstallWim() {
            calls.push("extract-wim");
            return {path: p.installWim, sourceIsoSha256: SHA("4"), bytes: "5000000000", sha256: SHA("5")};
        },
        async inspectInstallWim(input) {
            calls.push("inspect-wim");
            return {images: imageInventory(), removal: {path: input.installWim.path, sha256: input.installWim.sha256, removed: true}};
        },
        async prepareOfflineMedia(input) {
            calls.push("prepare-media");
            return {
                seedIso: {path: input.paths.seedIso, bytes: "1048576", sha256: SHA("8"),
                    sourceManifestSha256: input.seedSpec.sha256, format: "iso9660", volumeLabel: "MYSPEEDSEED"},
                outputDisk: {path: input.paths.outputDisk, bytes: "67108864", sha256: SHA("0"), format: "raw-fat", volumeLabel: "MYSPEEDOUT"},
                systemDisk: {path: input.paths.systemDisk, bytes: "196616", sha256: SHA("3"), virtualBytes: "51539607552", format: "qcow2"},
                ovmfVars: {path: input.paths.ovmfVars, sha256: toolchain().ovmfVarsTemplate.sha256}
            };
        },
        async launchOwnedQemu(input) {
            calls.push("launch");
            const eb = earlyBoot();
            if (input.bootConfirmation === BOOT_CONFIRMATION) {
                eb.inputSent = bootInput();
            }
            return {
                process: {
                    exitCode: 0, signal: null, timedOut: false, cleanupProven: true, treeGone: true,
                    qemuPid: 2345, qemuStartTicks: "77", launcherExecutablePath: toolchain().runtime.loader.path,
                    processGroupId: 2300, qemuPidAbsentAfter: true, terminationReason: null
                },
                argv: input.argv,
                earlyBoot: eb,
                guest: guestEvidence()
            };
        },
        ...overrides
    };
    return {op, calls};
}

function candidateRecord() {
    return {
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
        manifest: {name: "qualification-manifest.json", bytes: "65536", sha256: SHA("f")}
    };
}

const PROBE_NAMES = ["avx.exe", "avx2.exe", "cpuid.exe", "illegal.exe", "known_bad.exe", "known_good.exe",
    "popcnt.exe", "sse42.exe"];
function guestFiles() {
    const record = (name, character, bytes = "4096") => ({
        name, path: `${ROOT_STAGE3}/candidate/${name}`, bytes, sha256: SHA(character)
    });
    return [
        record("node.exe", "6", "52428800"),
        record("request.json", "7"),
        record("execution.json", "8"),
        record("fixture-bundle.json", "9"),
        record("guest-runtime.json", "a"),
        record("runtime-installer.ps1", "b"),
        ...PROBE_NAMES.map((name, index) => record(name, String(index + 1)))
    ];
}

function stage3GuestResult() {
    const rawCpuid = {
        schemaVersion: 1,
        kind: "cpuid",
        maxBasicLeaf: 7,
        leaf1: {eax: "0x00000000", ebx: "0x00000000", ecx: "0x00900000", edx: "0x00000000"},
        leaf7Subleaf0: {eax: "0x00000000", ebx: "0x00000000", ecx: "0x00000000", edx: "0x00000000"},
        xcr0: null,
        features: {sse42: true, popcnt: true, osxsave: false, avx: false, avx2: false}
    };
    const cpuidBytes = Buffer.from(`${JSON.stringify(rawCpuid)}\n`, "utf8");
    const cpuid = {bytes: cpuidBytes, bytesBase64: cpuidBytes.toString("base64"), sha256: HASH(cpuidBytes)};
    const expected = {ping: "123.456", resultId: "qualification-seed-row", passwordValueSha256: SHA("6")};
    const summary = {
        status: "passed", exit: 0, mode: "full", sourceSha: CANDIDATE_SOURCE_SHA,
        artifactSha256: SHA("d"), platform: "win32", architecture: "x64",
        command: ["C:\\MyspeedStage3\\candidate\\MySpeed.exe"],
        processes: ["populated-first-boot", "populated-restart", "fresh-no-config-reset"]
            .map((scenario, index) => ({scenario, pid: 100 + index})),
        databaseChecks: ["preseeded-input", "after-first-shutdown", "after-second-shutdown"]
            .map(scenario => ({scenario, ...expected})).concat([{scenario: "fresh-no-config-reset",
                integrity: "ok", configTable: false}]),
        openGraphChecks: [{scenario: "populated-first-boot", elapsedMs: 10},
            {scenario: "populated-restart", elapsedMs: 12}],
        networkIsolation: {kind: "qemu-nic-none-windows-guest", hardwareNics: 0,
            enabledNonLoopbackInterfaces: 0, nonLoopbackRoutes: 0},
        shutdownProofs: ["populated-first-boot", "populated-restart", "fresh-no-config-reset"].map(scenario => ({
            scenario, controllerLifecyclePassed: true, candidateExited: true,
            candidateExitCode: scenario === "fresh-no-config-reset" ? 113 : 0, forced: false,
            jobActiveProcesses: 0, handlesClosed: true
        }))
    };
    const summaryBytes = Buffer.from(`${JSON.stringify(summary)}\n`, "utf8");
    const summaryEncoding = {bytes: summaryBytes, bytesBase64: summaryBytes.toString("base64"), sha256: HASH(summaryBytes)};
    return {
        schemaVersion: 1, status: "observed", profile: "baseline-cpu",
        context: context(), candidate: {sourceSha: CANDIDATE_SOURCE_SHA, sha256: SHA("d"),
            artifactName: "MySpeed-windows-x64-baseline.exe"},
        cpu: {model: "Westmere-v2", cpuidBytesBase64: cpuid.bytesBase64, cpuidSha256: cpuid.sha256,
            sse42: true, popcnt: true, avx: false, avx2: false, osxsave: false, xcr0: null},
        network: {hardwareNics: 0, enabledNonLoopbackInterfaces: 0, nonLoopbackRoutes: 0},
        verifier: {summary, summaryBytesBase64: summaryEncoding.bytesBase64, summarySha256: summaryEncoding.sha256},
        releaseGatesCleared: []
    };
}

async function runHandoffPipeline({
    bootConfirmation = undefined,
    mutateStage2Result = null,
    mutateRawGuest = null
} = {}) {
    const ctx = context();
    const rawGuest = createRawGuestOutput(ctx.nonce);
    if (mutateRawGuest) mutateRawGuest(rawGuest);
    const stage2Ops = stage2InertOperations(rawGuest);

    const stage2Input = {
        context: ctx,
        admission: admission(),
        paths: stage2Paths(),
        probeArtifact: probeArtifact(),
        ...(bootConfirmation !== undefined ? {bootConfirmation} : {})
    };
    let stage2Result = await runWindowsCpuFloorStage2(stage2Input, stage2Ops.op);
    if (mutateStage2Result) {
        stage2Result = structuredClone(stage2Result);
        mutateStage2Result(stage2Result);
    }

    const stage2Bytes = Buffer.from(`${JSON.stringify(stage2Result)}\n`, "utf8");
    const stage2Sha256 = HASH(stage2Bytes);
    const stage2Identity = {
        path: `${TRANSPORT_ROOT}/stage2-result.json`,
        bytes: String(stage2Bytes.length),
        sha256: stage2Sha256
    };

    const rawGuestBytes = Buffer.from(`${JSON.stringify(rawGuest)}\n`, "utf8");
    const rawGuestSha256 = HASH(rawGuestBytes);
    const stage2GuestIdentity = {
        path: `${TRANSPORT_ROOT}/guest-result.json`,
        bytes: String(rawGuestBytes.length),
        sha256: rawGuestSha256
    };

    const s3Paths = stage3Paths();
    const cand = candidateRecord();
    const stage3Request = {
        schemaVersion: 1,
        context: ctx,
        profile: "baseline-cpu",
        authorization: {
            scope: "windows-baseline-cpu-floor-full-runtime",
            qemu: true,
            candidate: true,
            confirmation: "RUN-WINDOWS-BASELINE-CPU-FLOOR"
        },
        stage2: {
            result: stage2Identity,
            guestResult: stage2GuestIdentity
        },
        candidate: cand,
        paths: s3Paths
    };

    const files = new Map([
        [`${s3Paths.root}/candidate/MySpeed.exe`, {path: `${s3Paths.root}/candidate/MySpeed.exe`, bytes: "524288", sha256: SHA("d")}],
        [`${s3Paths.root}/candidate/qualification-summary.json`, {path: `${s3Paths.root}/candidate/qualification-summary.json`, bytes: "8192", sha256: SHA("e")}],
        [`${s3Paths.root}/candidate/qualification-manifest.json`, {path: `${s3Paths.root}/candidate/qualification-manifest.json`, bytes: "65536", sha256: SHA("f")}],
        ...guestFiles().map(f => [f.path, f]),
        [`${s3Paths.root}/OVMF_VARS.fd`, {path: `${s3Paths.root}/OVMF_VARS.fd`, bytes: "540672", sha256: SHA("6")}],
        [toolchain().runtime.loader.path, toolchain().runtime.loader],
        [toolchain().mcopy.path, toolchain().mcopy]
    ]);

    let capturedLaunchArgv = null;
    const gResult = stage3GuestResult();
    const gResultEncoded = Buffer.from(`${JSON.stringify(gResult)}\n`, "utf8");

    const stage3Ops = createHostedStage3Operations({
        context: ctx,
        paths: s3Paths,
        guestFiles: guestFiles(),
        dependencies: {
            deriveActualContext: () => ctx,
            inspectFile: target => {
                if (files.has(target)) return files.get(target);
                throw new Error(`unexpected inspect ${target}`);
            },
            readJson: target => {
                if (target === stage2Identity.path) {
                    return {identity: stage2Identity, value: JSON.parse(stage2Bytes.toString("utf8"))};
                }
                if (target === stage2GuestIdentity.path) {
                    return {identity: stage2GuestIdentity, bytesBase64: rawGuestBytes.toString("base64"), value: JSON.parse(rawGuestBytes.toString("utf8"))};
                }
                throw new Error(`unexpected readJson ${target}`);
            },
            runOwned: async (command, argv) => {
                capturedLaunchArgv = argv;
                return {
                    process: {
                        exitCode: 0, signal: null, timedOut: false, cleanupProven: true, treeGone: true,
                        qemuPid: 1200, qemuStartTicks: "123456", processGroupId: 1200, qemuPidAbsentAfter: true,
                        launcherExecutablePath: toolchain().runtime.loader.path, terminationReason: null
                    },
                    observation: {
                        exitCode: 0, signal: null, timedOut: false, cleanupProven: true,
                        errorObserved: false, stdoutOverflow: false, stderrOverflow: false
                    }
                };
            }
        }
    });

    const customOps = {
        ...stage3Ops,
        async prepareBaselineMedia() {
            return {
                seedIso: {path: `${s3Paths.root}/baseline-seed.iso`, bytes: "1048576", sha256: SHA("8")},
                outputDisk: {path: `${s3Paths.root}/baseline-output.img`, bytes: "67108864", sha256: SHA("0")},
                systemDisk: {path: `${s3Paths.root}/stage3.qcow2`, bytes: "8388608", sha256: SHA("a"), virtualBytes: "51539607552"},
                ovmfVars: {path: `${s3Paths.root}/OVMF_VARS.fd`, bytes: "540672", sha256: SHA("6")}
            };
        },
        async launchBaselineGuest(input) {
            capturedLaunchArgv = input.argv;
            return {
                argv: input.argv,
                process: {
                    exitCode: 0, signal: null, timedOut: false, cleanupProven: true, treeGone: true,
                    qemuPid: 1200, qemuStartTicks: "123456", processGroupId: 1200, qemuPidAbsentAfter: true,
                    launcherExecutablePath: toolchain().runtime.loader.path, terminationReason: null
                },
                earlyBoot: {
                    schemaVersion: 1, kind: "qemu-early-boot-observation", inputSent: false,
                    version: {major: 8, minor: 2, micro: 2}, status: "running", running: true,
                    screenshots: [1, 2].map(index => ({path: `${s3Paths.root}/early-boot-${index}.png`,
                        bytes: String(PNG.length), sha256: HASH(PNG), bytesBase64: PNG.toString("base64")}))
                },
                outputDisk: {path: `${s3Paths.root}/baseline-output.img`, bytes: "67108864", sha256: SHA("0")}
            };
        },
        async collectBaselineGuestResult() {
            return {
                identity: {path: `${s3Paths.root}/baseline-result.json`, bytes: String(gResultEncoded.length), sha256: HASH(gResultEncoded)},
                bytesBase64: gResultEncoded.toString("base64"),
                result: gResult,
                sourceOutputDisk: {path: `${s3Paths.root}/baseline-output.img`, bytes: "67108864", sha256: SHA("0")}
            };
        }
    };

    const stage3Result = await runWindowsCpuFloorStage3(stage3Request, customOps);
    return {
        ctx,
        stage2Result,
        stage2Bytes,
        stage2Identity,
        stage2GuestIdentity,
        stage3Request,
        stage3Ops,
        stage3Result,
        capturedLaunchArgv: () => capturedLaunchArgv
    };
}

describe("Stage 2 → Stage 3 real producer handoff and hosted replay", () => {
    it("feeds real Stage 2 result and raw guest bytes through real Stage 3 hosted replay and completed consumer (default no-input)", async () => {
        const {stage2Result, stage3Result, stage3Request, stage2Bytes, capturedLaunchArgv} = await runHandoffPipeline();
        assert.equal(stage2Result.status, "observed", JSON.stringify(stage2Result.failure));
        assert.equal(stage2Result.classification, "github-hosted-windows-cpu-floor-stage2-calibration-nonqualifying");
        assert.equal(stage2Result.earlyBoot.inputSent, false);
        assert.equal(stage2Result.bootConfirmation, undefined);

        assert.equal(stage3Result.status, "observed", stage3Result.failure);

        // Assert Stage 3 launcher does not inherit boot confirmation
        assert.ok(capturedLaunchArgv());
        assert.ok(!capturedLaunchArgv().includes("installer-boot-confirmation"));
        assert.ok(!capturedLaunchArgv().includes(BOOT_CONFIRMATION));

        const completed = validateCompletedStage3Result(stage3Result, stage3Request, stage2Bytes);
        assert.equal(completed.accepted, true);
    });

    it("feeds real Stage 2 result and raw guest bytes through real Stage 3 hosted replay and completed consumer with authorized installer-boot-confirmation", async () => {
        const {stage2Result, stage3Result, stage3Request, stage2Bytes, capturedLaunchArgv} = await runHandoffPipeline({
            bootConfirmation: BOOT_CONFIRMATION
        });
        assert.equal(stage2Result.status, "observed", JSON.stringify(stage2Result.failure));
        assert.equal(stage2Result.classification, "github-hosted-windows-cpu-floor-stage2-calibration-nonqualifying");
        assert.equal(stage2Result.bootConfirmation, BOOT_CONFIRMATION);
        assert.equal(stage2Result.earlyBoot.inputSent.kind, "installer-boot-confirmation");
        assert.equal(stage2Result.earlyBoot.inputSent.qcode, "ret");
        assert.equal(stage2Result.earlyBoot.inputSent.acknowledged, true);

        assert.equal(stage3Result.status, "observed", stage3Result.failure);

        // Assert Stage 3 launcher does not inherit boot confirmation even when Stage 2 used it
        assert.ok(capturedLaunchArgv());
        assert.ok(!capturedLaunchArgv().includes("installer-boot-confirmation"));
        assert.ok(!capturedLaunchArgv().includes(BOOT_CONFIRMATION));

        const completed = validateCompletedStage3Result(stage3Result, stage3Request, stage2Bytes);
        assert.equal(completed.accepted, true);
    });
});

describe("Historical evidence compatibility (fail-closed)", () => {
    it("rejects obsolete Stage 2 observation missing earlyBoot", async () => {
        const {stage3Result} = await runHandoffPipeline({
            mutateStage2Result: r => { delete r.earlyBoot; }
        });
        assert.equal(stage3Result.status, "failed");
        assert.equal(stage3Result.stage, "stage2-replay");
        assert.match(stage3Result.failure, /Stage 2 observation keys are invalid/);
    });

    it("rejects obsolete classification without calibration marker", async () => {
        const {stage3Result} = await runHandoffPipeline({
            mutateStage2Result: r => { r.classification = "github-hosted-windows-cpu-floor-stage2-nonqualifying"; }
        });
        assert.equal(stage3Result.status, "failed");
        assert.equal(stage3Result.stage, "stage2-replay");
        assert.match(stage3Result.failure, /Stage 2 observation is not accepted/);
    });

    it("rejects Stage 2 guest observation missing activation", async () => {
        const {stage3Result} = await runHandoffPipeline({
            mutateStage2Result: r => { delete r.guest.activation; }
        });
        assert.equal(stage3Result.status, "failed");
        assert.equal(stage3Result.stage, "stage2-replay");
        assert.match(stage3Result.failure, /Stage 2 raw guest projection differs|guest/i);
    });

    it("rejects Stage 2 guest observation missing systemTools", async () => {
        const {stage3Result} = await runHandoffPipeline({
            mutateStage2Result: r => { delete r.guest.systemTools; }
        });
        assert.equal(stage3Result.status, "failed");
        assert.equal(stage3Result.stage, "stage2-replay");
        assert.match(stage3Result.failure, /Stage 2 raw guest projection differs|guest/i);
    });
});

describe("Negative mutation defenses across handoff boundary", () => {
    it("rejects mutated raw CPU vs projected CPU", async () => {
        const {stage3Result} = await runHandoffPipeline({
            mutateRawGuest: g => {
                const cpuidRun = g.runs.find(r => r.role === "cpuid");
                const cpuidVal = JSON.parse(Buffer.from(cpuidRun.stdoutBase64, "base64").toString("utf8"));
                cpuidVal.features.avx = true;
                cpuidRun.stdoutBase64 = Buffer.from(`${JSON.stringify(cpuidVal)}\n`).toString("base64");
            }
        });
        assert.equal(stage3Result.status, "failed");
        assert.equal(stage3Result.stage, "stage2-replay");
        assert.match(stage3Result.failure, /CPUID target floor is invalid|Stage 2 raw guest projection differs|AVX/);
    });

    it("rejects mutated network interfaces in raw guest", async () => {
        const {stage3Result} = await runHandoffPipeline({
            mutateRawGuest: g => {
                g.network = {hardwareNics: 1, enabledNonLoopbackInterfaces: 0, nonLoopbackRoutes: 0};
            }
        });
        assert.equal(stage3Result.status, "failed");
        assert.equal(stage3Result.stage, "stage2-replay");
        assert.match(stage3Result.failure, /Stage 2 raw guest projection differs|network/);
    });

    it("rejects mutated activation evidence in raw guest", async () => {
        const {stage3Result} = await runHandoffPipeline({
            mutateRawGuest: g => {
                const act = structuredClone(g.activation);
                act.files.dispatcher.sha256 = SHA("9");
                g.activation = act;
            }
        });
        assert.equal(stage3Result.status, "failed");
        assert.equal(stage3Result.stage, "stage2-replay");
        assert.match(stage3Result.failure, /Stage 2 raw guest projection differs|activation/);
    });

    it("rejects mutated system tools in raw guest", async () => {
        const {stage3Result} = await runHandoffPipeline({
            mutateRawGuest: g => {
                g.systemTools[0].sha256 = SHA("9");
            }
        });
        assert.equal(stage3Result.status, "failed");
        assert.equal(stage3Result.stage, "stage2-replay");
        assert.match(stage3Result.failure, /Stage 2 raw guest projection differs|systemTools/);
    });

    it("rejects unproven cleanup in Stage 2", async () => {
        const {stage3Result} = await runHandoffPipeline({
            mutateStage2Result: r => {
                r.cleanupProven = false;
            }
        });
        assert.equal(stage3Result.status, "failed");
        assert.equal(stage3Result.stage, "stage2-replay");
        assert.match(stage3Result.failure, /Stage 2 observation is not accepted|Stage 2 cleanup/);
    });

    it("rejects unauthorized boot input sent without bootConfirmation opt-in", async () => {
        const {stage3Result} = await runHandoffPipeline({
            mutateStage2Result: r => {
                r.earlyBoot.inputSent = bootInput();
            }
        });
        assert.equal(stage3Result.status, "failed");
        assert.equal(stage3Result.stage, "stage2-replay");
        assert.match(stage3Result.failure, /QMP installer boot input is invalid/);
    });

    it("rejects unauthorized boot confirmation token", async () => {
        const {stage3Result} = await runHandoffPipeline({
            mutateStage2Result: r => {
                r.bootConfirmation = "unauthorized-token-v9";
            }
        });
        assert.equal(stage3Result.status, "failed");
        assert.equal(stage3Result.stage, "stage2-replay");
        assert.match(stage3Result.failure, /QMP installer boot confirmation is invalid/);
    });
});
