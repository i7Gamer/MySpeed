import assert from "node:assert/strict";
import crypto from "node:crypto";
import {describe, it} from "node:test";

import {PACKAGE_ROOTS, STAGE2_PROVENANCE, TOP_LEVEL_PACKAGE_PINS, runWindowsCpuFloorStage2,
    validatePackageClosure} from "../../scripts/qualification/linux-windows-cpu-floor-stage2.mjs";
import {STAGE2_LIMITS} from "../../scripts/qualification/linux-windows-cpu-floor-admission.mjs";
import {sealSameJobInstalledBase,
    validateSameJobInstalledBaseSeal} from "../../scripts/qualification/windows-msi-installed-base.mjs";
import {buildWindowsMsiSetupCompleteActivation, getCompletedWindowsMsiActivationEvidence} from
    "../../scripts/qualification/windows-msi-post-setup-activation.mjs";

const NONCE = "0123456789abcdef0123456789abcdef";
const SYSTEM_BYTES = "4294967296";
const VIRTUAL_BYTES = "51539607552";
const WRONG_VIRTUAL_BYTES = "51539607551";
const SYSTEM_TOOLS = [
    {role: "msiexec", path: "C:\\Windows\\System32\\msiexec.exe", bytes: "1024", sha256: "8".repeat(64)},
    {role: "sc", path: "C:\\Windows\\System32\\sc.exe", bytes: "2048", sha256: "9".repeat(64)},
    {role: "powershell", path: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
        bytes: "4096", sha256: "b".repeat(64)}
];
const SYSTEM_HASH = "a".repeat(64);
const PNG = Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), Buffer.from("base-screen")]);
const OVERSIZED_PROCESS_ID = 0x8000_0000;
const OVERSIZED_START_TICKS = "1".repeat(25);
const hash = value => crypto.createHash("sha256").update(value).digest("hex");

function context() {
    return {schemaVersion: 1, repository: "i7Gamer/MySpeed", sourceSha: "b".repeat(40), eventSha: "c".repeat(40),
        runId: "34836752216", runAttempt: "1", nonce: NONCE, environment: {GITHUB_ACTIONS: "true", CI: "true",
            RUNNER_OS: "Linux", RUNNER_ARCH: "X64", RUNNER_ENVIRONMENT: "github-hosted", ImageOS: "ubuntu24",
            ImageVersion: "20260907.1"}};
}

function paths() {
    const root = `/home/runner/work/_temp/myspeed-windows-cpu-floor-${NONCE}`;
    return {root, packageRoot: `${root}/packages`, portableRoot: `/tmp/myspeed-windows-cpu-floor-tools-${NONCE}`,
        probeRoot: `${root}/probes`, windowsIso: `${root}/windows.iso`, installWim: `${root}/install.wim`,
        seedIso: `${root}/seed.iso`, outputDisk: `${root}/output.img`, systemDisk: `${root}/system.qcow2`,
        ovmfVars: `${root}/OVMF_VARS.fd`, serialLog: `${root}/serial.log`, qemuPid: `${root}/qemu.pid`};
}

function activationReceipt() {
    const hosted = context();
    const activation = buildWindowsMsiSetupCompleteActivation({repository: hosted.repository,
        sourceSha: hosted.sourceSha, eventSha: hosted.eventSha, runId: hosted.runId,
        runAttempt: hosted.runAttempt, nonce: hosted.nonce});
    return getCompletedWindowsMsiActivationEvidence(activation);
}

function packageClosure() {
    const packages = TOP_LEVEL_PACKAGE_PINS.map(value => ({...value, dependsOn: []}));
    packages.push({name: "libfixture", version: "1.0", architecture: "amd64",
        filename: "pool/libfixture_1.0_amd64.deb", bytes: "2048", sha256: "f".repeat(64), dependsOn: []});
    packages[0].dependsOn = ["libfixture:amd64=1.0"];
    packages.sort((left, right) => `${left.name}:${left.architecture}=${left.version}`.localeCompare(
        `${right.name}:${right.architecture}=${right.version}`, "en"));
    return {schemaVersion: 1, snapshot: structuredClone(STAGE2_PROVENANCE.ubuntuSnapshot), roots: [...PACKAGE_ROOTS],
        indexes: [{suite: "noble", component: "main", architecture: "amd64",
            path: "dists/noble/main/binary-amd64/Packages.xz", bytes: "100", sha256: "1".repeat(64),
            listedSha256: "1".repeat(64), inReleaseSha256: "3".repeat(64)},
        {suite: "noble-updates", component: "main", architecture: "amd64",
            path: "dists/noble-updates/main/binary-amd64/Packages.xz", bytes: "101", sha256: "2".repeat(64),
            listedSha256: "2".repeat(64), inReleaseSha256: "4".repeat(64)}],
        releases: [{suite: "noble", inReleasePath: "dists/noble/InRelease", bytes: "200", sha256: "3".repeat(64),
            signatureVerified: true, signerFingerprint: STAGE2_PROVENANCE.ubuntuArchiveSignerFingerprint},
        {suite: "noble-updates", inReleasePath: "dists/noble-updates/InRelease", bytes: "201",
            sha256: "4".repeat(64), signatureVerified: true,
            signerFingerprint: STAGE2_PROVENANCE.ubuntuArchiveSignerFingerprint}], packages};
}

function admission() {
    return {schemaVersion: 1, status: "admitted", admitted: true,
        classification: "github-hosted-windows-cpu-floor-admission-nonqualifying", qualifying: false,
        releaseGateCleared: false, mediaAcquisitionAuthorized: false, qemuLaunchAuthorized: false, context: context(),
        kvm: {ordinary: {bytes: 1, sha256: "a".repeat(64), capability: "permission-denied"},
            combined: {bytes: 1, sha256: "d".repeat(64), capability: "usable", retryPerformed: true}},
        budget: structuredClone(STAGE2_LIMITS), observations: {}, reasons: []};
}

function probeArtifact() {
    const roles = ["avx", "avx2", "cpuid", "illegal", "known-bad", "known-good", "popcnt", "sse42"];
    return {schemaVersion: 1, repository: context().repository, sourceSha: "9".repeat(40), runId: "34763667695",
        runAttempt: "1", artifactId: "1234567890", artifactName: "windows-cpu-readiness-evidence",
        archive: {bytes: "33554432", sha256: "a".repeat(64)},
        innerManifest: {name: "result.json", bytes: "262144", sha256: "b".repeat(64)},
        files: roles.map((role, index) => ({role, name: `${role.replaceAll("-", "_")}.exe`,
            bytes: `${4096 + index}`, sha256: `${index + 1}`.repeat(64).slice(0, 64)}))};
}

function toolchain() {
    const root = paths().portableRoot;
    const ownership = {uid: "0", gid: "0", mode: "555", ordinaryUserWritable: false};
    const command = (name, sha256) => ({path: `${root}/usr/bin/${name}`, invocationPath: `${root}/usr/bin/${name}`,
        bytes: "4096", sha256, ownership});
    return {qemu: {...command("qemu-system-x86_64", "a".repeat(64)),
        version: "QEMU emulator version 8.2.2 (Debian 1:8.2.2+ds-0ubuntu1.18)"},
    qemuImg: command("qemu-img", "b".repeat(64)), genisoimage: command("genisoimage", "c".repeat(64)),
    mcopy: command("mcopy", "d".repeat(64)), mformat: command("mformat", "9".repeat(64)),
    sevenZip: {path: `${root}/usr/lib/7zip/7z`, invocationPath: `${root}/usr/lib/7zip/7z`, bytes: "4096",
        sha256: "e".repeat(64), ownership}, wiminfo: command("wiminfo", "f".repeat(64)),
    ovmfCode: {path: `${root}/usr/share/OVMF/OVMF_CODE_4M.fd`, bytes: "4096", sha256: "1".repeat(64), ownership},
    ovmfVarsTemplate: {path: `${root}/usr/share/OVMF/OVMF_VARS_4M.fd`, bytes: "4096", sha256: "2".repeat(64),
        ownership}, runtime: {loader: {path: `${root}/usr/lib/x86_64-linux-gnu/ld-linux-x86-64.so.2`, bytes: "4096",
            sha256: "4".repeat(64), ownership}, libraryPath: [`${root}/usr/lib/x86_64-linux-gnu`,
            `${root}/usr/lib/7zip`]},
    firmware: {searchPath: `${root}/usr/share/qemu`,
        kvmvapic: {path: `${root}/usr/share/qemu/kvmvapic.bin`, bytes: "4096",
            sha256: "3".repeat(64), ownership},
        vga: {path: `${root}/usr/share/seabios/vgabios-stdvga.bin`, bytes: "4096",
            sha256: "5".repeat(64), ownership}},
    packageClosureSha256: hash(Buffer.from(JSON.stringify(validatePackageClosure(packageClosure())))),
    installedFilesManifest: {bytes: "10000", sha256: "6".repeat(64)},
    licensesManifest: {bytes: "2000", sha256: "7".repeat(64)},
    capabilities: {cpuModels: ["Westmere-v2"], machines: ["q35"],
        devices: ["ich9-ahci", "ide-cd", "ide-hd", "isa-serial", "VGA", "qemu-xhci", "usb-kbd"],
        accelerator: "kvm"}};
}

function producerOperations() {
    return {
        async resolveSignedPackageClosure() { return packageClosure(); },
        async acquirePackages(input) { return {complete: true, packages: input.packageClosure.packages.map(value =>
            ({reference: `${value.name}:${value.architecture}=${value.version}`,
                path: `${input.paths.packageRoot}/${value.name}.deb`, bytes: value.bytes, sha256: value.sha256}))}; },
        async extractPortableTools() { return toolchain(); },
        async acquireProbeClosure(input) { return {archive: input.probeArtifact.archive,
            innerManifest: input.probeArtifact.innerManifest, files: input.probeArtifact.files.map(value =>
                ({...value, path: `${input.paths.probeRoot}/${value.name}`}))}; },
        async acquireWindowsIso() { return {finalUrl: STAGE2_PROVENANCE.windowsIso.finalUrl,
            bytes: STAGE2_PROVENANCE.windowsIso.bytes, etag: STAGE2_PROVENANCE.windowsIso.strongEtag,
            observerA: {id: "same-handle-pass-1", sha256: "4".repeat(64)},
            observerB: {id: "same-handle-pass-2", sha256: "4".repeat(64)}}; },
        async extractInstallWim() { return {path: paths().installWim, sourceIsoSha256: "4".repeat(64),
            bytes: "5000000000", sha256: "5".repeat(64)}; },
        async inspectInstallWim(input) { return {images: [{index: 2,
            name: "Windows Server 2025 SERVERSTANDARD", architecture: "x64", editionId: "ServerStandardEval",
            installationType: "Server", totalBytes: "24699866265"}],
        removal: {path: input.installWim.path, sha256: input.installWim.sha256, removed: true}}; },
        async prepareOfflineMedia(input) { return {seedIso: {path: input.paths.seedIso, bytes: "1048576",
            sha256: "8".repeat(64), sourceManifestSha256: input.seedSpec.sha256, format: "iso9660",
            volumeLabel: "MYSPEEDSEED"}, outputDisk: {path: input.paths.outputDisk, bytes: "67108864",
            sha256: "0".repeat(64), format: "raw-fat", volumeLabel: "MYSPEEDOUT"},
        systemDisk: {path: input.paths.systemDisk, bytes: "196616", sha256: "d".repeat(64),
            virtualBytes: VIRTUAL_BYTES, format: "qcow2"},
        ovmfVars: {path: input.paths.ovmfVars, sha256: toolchain().ovmfVarsTemplate.sha256}}; },
        async launchOwnedQemu(input) { return {argv: input.argv,
            process: {exitCode: 0, signal: null, timedOut: false, cleanupProven: true, treeGone: true, qemuPid: 2345,
                qemuStartTicks: "77", launcherExecutablePath: toolchain().runtime.loader.path, processGroupId: 2300,
                qemuPidAbsentAfter: true, terminationReason: null},
            earlyBoot: {schemaVersion: 1, kind: "qemu-early-boot-observation", inputSent: false,
                version: {major: 8, minor: 2, micro: 2}, status: "running", running: true,
                screenshots: [1, 2].map(index => ({path: `${paths().root}/early-boot-${index}.png`,
                    bytes: String(PNG.length), sha256: hash(PNG), bytesBase64: PNG.toString("base64")}))},
            guest: {schemaVersion: 1, status: "observed",
                cpu: {sse42: true, popcnt: true, osxsave: false, avx: false, avx2: false, xcr0: null},
                instructions: {sse42: "completed", popcnt: "completed", avx: "illegal-instruction",
                    avx2: "illegal-instruction"},
                network: {hardwareNics: 0, enabledNonLoopbackInterfaces: 0, nonLoopbackRoutes: 0},
                activation: activationReceipt(),
                systemTools: structuredClone(SYSTEM_TOOLS),
                output: {path: paths().outputDisk, bytes: "67108864", sha256: "e".repeat(64)}}}; }
    };
}

const PRODUCED_STAGE2_RESULT = await runWindowsCpuFloorStage2({context: context(), admission: admission(), paths: paths(),
    probeArtifact: probeArtifact()}, producerOperations());

function stage2Result() {
    return structuredClone(PRODUCED_STAGE2_RESULT);
}

function fileIdentity(mode = "644") {
    return {path: paths().systemDisk, kind: "file", dev: "8", ino: "1234", bytes: SYSTEM_BYTES, sha256: SYSTEM_HASH,
        ownership: {uid: mode === "444" ? "0" : "1001", gid: mode === "444" ? "0" : "1001", mode,
            ordinaryUserWritable: mode !== "444"}};
}

function operations(overrides = {}) {
    const calls = [];
    const value = {
        async observeQemuGroup(input) { calls.push(["group", input]);
            return {processGroupId: input.processGroupId, activeProcesses: 0}; },
        async inspectFile(input) { calls.push(["file", input]);
            return calls.filter(([kind]) => kind === "file").length === 1 ? fileIdentity() : fileIdentity("444"); },
        async inspectQcow2(input) { calls.push(["qcow2", input]);
            return {format: "qcow2", virtualBytes: VIRTUAL_BYTES, backingFilename: null}; },
        async sealExact(input) { calls.push(["seal", input]); },
        ...overrides
    };
    return {calls, value};
}

describe("same-job installed Stage 2 base sealing", () => {
    it("binds accepted NIC-none evidence and seals the current disk identity", async () => {
        assert.equal(PRODUCED_STAGE2_RESULT.status, "observed", PRODUCED_STAGE2_RESULT.failure);
        const io = operations();
        const result = await sealSameJobInstalledBase({expectedContext: context(), paths: paths(),
            stage2Result: stage2Result()}, io.value);

        assert.deepEqual(io.calls.map(([kind]) => kind), ["group", "file", "qcow2", "seal", "file"]);
        assert.equal(io.calls[2][1].qemuImgPath, stage2Result().toolchain.qemuImg.path);
        assert.deepEqual(io.calls[3][1], {path: paths().systemDisk, kind: "file", dev: "8", ino: "1234",
            uid: "0", gid: "0", mode: "444"});
        assert.deepEqual(result.image, {...fileIdentity("444"), format: "qcow2", virtualBytes: VIRTUAL_BYTES,
            backingFilename: null, sealedReadOnly: true});
        assert.equal(result.kind, "myspeed-stage2-installed-base-same-job-ephemeral");
        assert.equal(result.authority, "same-job-ephemeral-identity-only");
        assert.deepEqual(result.source.activation, activationReceipt());
        assert.deepEqual(result.source.systemTools, SYSTEM_TOOLS);
        assert.deepEqual(result.source.preparedSystemDisk, {bytes: "196616", sha256: "d".repeat(64)});
        for (const forbidden of ["eligible", "qualifying", "releaseGateCleared", "releaseGatesCleared"])
            assert.equal(Object.hasOwn(result, forbidden), false);
        assert.ok(Object.isFrozen(result));
        assert.ok(Object.isFrozen(result.image.ownership));
        const serialized = JSON.parse(JSON.stringify(result));
        const validated = validateSameJobInstalledBaseSeal(serialized, context());
        assert.deepEqual(validated, result);
        assert.notEqual(validated, serialized);
        assert.ok(Object.isFrozen(validated.image.ownership));
    });

    it("rejects unbound Stage 2, NIC, QEMU, and live process-group evidence before disk inspection", async () => {
        const cases = [
            value => { value.context.runId = "999"; },
            value => { value.guest.network.hardwareNics = 1; },
            value => { value.guest.activation.setupCompleted = false; },
            value => { value.argv = [...value.argv]; value.argv[value.argv.indexOf("none")] = "user"; },
            value => { value.qemuProcess.treeGone = false; },
            value => { value.qemuProcess.qemuPid = OVERSIZED_PROCESS_ID; },
            value => { value.qemuProcess.processGroupId = OVERSIZED_PROCESS_ID; },
            value => { value.qemuProcess.qemuStartTicks = OVERSIZED_START_TICKS; }
        ];
        for (const mutate of cases) {
            const evidence = stage2Result(); mutate(evidence);
            const io = operations();
            await assert.rejects(() => sealSameJobInstalledBase({expectedContext: context(), paths: paths(),
                stage2Result: evidence}, io.value));
            assert.deepEqual(io.calls, []);
        }
        const io = operations({observeQemuGroup: async input => {
            io.calls.push(["group", input]); return {processGroupId: input.processGroupId, activeProcesses: 1}; }});
        await assert.rejects(() => sealSameJobInstalledBase({expectedContext: context(), paths: paths(),
            stage2Result: stage2Result()}, io.value), /process group/u);
        assert.deepEqual(io.calls.map(([kind]) => kind), ["group"]);
    });

    it("rejects backing files, changed identities, and incompletely sealed output", async () => {
        for (const changed of [{backingFilename: "/tmp/base.qcow2"}, {format: "raw"},
            {virtualBytes: WRONG_VIRTUAL_BYTES}]) {
            const badQcow = operations({inspectQcow2: async input => { badQcow.calls.push(["qcow2", input]);
                return {...{format: "qcow2", virtualBytes: VIRTUAL_BYTES, backingFilename: null}, ...changed}; }});
            await assert.rejects(() => sealSameJobInstalledBase({expectedContext: context(), paths: paths(),
                stage2Result: stage2Result()}, badQcow.value), /backing|qemu-img/u);
        }

        for (const changed of [{kind: "symlink"}, {ino: "1235"}, {sha256: "f".repeat(64)},
            {ownership: {uid: "0", gid: "0", mode: "644", ordinaryUserWritable: true}}]) {
            let reads = 0;
            const io = operations({inspectFile: async input => { io.calls.push(["file", input]); reads += 1;
                return reads === 1 ? fileIdentity() : {...fileIdentity("444"), ...changed}; }});
            await assert.rejects(() => sealSameJobInstalledBase({expectedContext: context(), paths: paths(),
                stage2Result: stage2Result()}, io.value));
        }
    });

    it("requires every injected observation and mutation operation", async () => {
        for (const missing of ["observeQemuGroup", "inspectFile", "inspectQcow2", "sealExact"]) {
            const io = operations(); delete io.value[missing];
            await assert.rejects(() => sealSameJobInstalledBase({expectedContext: context(), paths: paths(),
                stage2Result: stage2Result()}, io.value), /operation/u);
            assert.deepEqual(io.calls, []);
        }
    });

    it("rejects coercible and non-terminal Stage 2 identity scalars before observation", async () => {
        const invalidTicks = [77, ["77"], {toString: () => "77"}, "77\n", "77\r\n"];
        for (const qemuStartTicks of invalidTicks) {
            const evidence = stage2Result(); evidence.qemuProcess.qemuStartTicks = qemuStartTicks;
            const io = operations();
            await assert.rejects(() => sealSameJobInstalledBase({expectedContext: context(), paths: paths(),
                stage2Result: evidence}, io.value));
            assert.deepEqual(io.calls, []);
        }
    });

    it("rejects malformed identities for each transitively used Stage 2 tool", async () => {
        const cases = [
            value => { value.toolchain.qemuImg.sha256 = `${value.toolchain.qemuImg.sha256}\n`; },
            value => { value.toolchain.runtime.loader.bytes = [value.toolchain.runtime.loader.bytes]; },
            value => { value.toolchain.ovmfCode.ownership = {...value.toolchain.ovmfCode.ownership, uid: 0}; }
        ];
        for (const mutate of cases) {
            const evidence = stage2Result(); mutate(evidence);
            const io = operations();
            await assert.rejects(() => sealSameJobInstalledBase({expectedContext: context(), paths: paths(),
                stage2Result: evidence}, io.value), /Stage 2/u);
            assert.deepEqual(io.calls, []);
        }
    });

    it("pins the installed base virtual size instead of trusting the Stage 2 input", async () => {
        const evidence = stage2Result(); evidence.media.systemDisk.virtualBytes = WRONG_VIRTUAL_BYTES;
        const io = operations({inspectQcow2: async input => { io.calls.push(["qcow2", input]);
            return {format: "qcow2", virtualBytes: WRONG_VIRTUAL_BYTES, backingFilename: null}; }});
        await assert.rejects(() => sealSameJobInstalledBase({expectedContext: context(), paths: paths(),
            stage2Result: evidence}, io.value), /virtual|system disk/u);
        assert.deepEqual(io.calls, []);
    });

    it("rejects coercible and newline-suffixed current-file identities before sealing", async () => {
        const invalid = [{dev: 8}, {ino: ["1234"]}, {bytes: {toString: () => SYSTEM_BYTES}},
            {sha256: `${SYSTEM_HASH}\n`}, {sha256: `${SYSTEM_HASH}\r\n`},
            {ownership: {uid: 0, gid: "1001", mode: "644", ordinaryUserWritable: true}}];
        for (const changed of invalid) {
            const io = operations({inspectFile: async input => { io.calls.push(["file", input]);
                return {...fileIdentity(), ...changed}; }});
            await assert.rejects(() => sealSameJobInstalledBase({expectedContext: context(), paths: paths(),
                stage2Result: stage2Result()}, io.value));
            assert.equal(io.calls.some(([kind]) => kind === "seal"), false);
        }
    });

    it("rejects a current disk that still has the prepared empty-disk hash", async () => {
        const preparedHash = stage2Result().media.systemDisk.sha256;
        const io = operations({inspectFile: async input => { io.calls.push(["file", input]);
            return {...fileIdentity(), sha256: preparedHash}; }});
        await assert.rejects(() => sealSameJobInstalledBase({expectedContext: context(), paths: paths(),
            stage2Result: stage2Result()}, io.value), /empty-disk/u);
        assert.equal(io.calls.some(([kind]) => kind === "seal"), false);
    });

    it("rejects malformed or unbound serialized installed-base seals", async () => {
        const sealed = await sealSameJobInstalledBase({expectedContext: context(), paths: paths(),
            stage2Result: stage2Result()}, operations().value);
        const cases = [
            value => { value.extra = true; },
            value => { value.context.runId = "999"; },
            value => { value.authority = "qualifying"; },
            value => { value.source.stage2Classification = "other"; },
            value => { value.source.activation.files.dispatcher.sha256 = "f".repeat(64); },
            value => { value.source.activation.nativeMsiExecutionStarted = true; },
            value => { value.source.systemTools[0].path = "C:\\Windows\\System32\\not-msiexec.exe"; },
            value => { value.source.systemTools[1].bytes = "0"; },
            value => { value.source.systemTools[2].sha256 = "A".repeat(64); },
            value => { value.source.extra = true; },
            value => { value.source.processGroupId = "2300"; },
            value => { value.source.qemuStartTicks = "77\n"; },
            value => { value.source.preparedSystemDisk.extra = true; },
            value => { value.image.path = `/home/runner/work/_temp/elsewhere/system.qcow2`; },
            value => { value.image.path = `${value.image.path}\n`; },
            value => { value.image.extra = true; },
            value => { value.image.kind = "symlink"; },
            value => { value.image.sha256 = value.source.preparedSystemDisk.sha256; },
            value => { value.image.ownership.uid = "1001"; },
            value => { value.image.ownership.mode = "644"; },
            value => { value.image.backingFilename = "/tmp/base.qcow2"; },
            value => { value.image.virtualBytes = WRONG_VIRTUAL_BYTES; },
            value => { value.image.sealedReadOnly = false; }
        ];
        for (const mutate of cases) {
            const value = structuredClone(sealed); mutate(value);
            assert.throws(() => validateSameJobInstalledBaseSeal(value, context()));
        }
    });
});
