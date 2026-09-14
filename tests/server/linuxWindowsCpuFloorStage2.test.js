import assert from "node:assert/strict";
import crypto from "node:crypto";
import {describe, it} from "node:test";

import {
    PACKAGE_ROOTS,
    STAGE2_PROVENANCE,
    TOP_LEVEL_PACKAGE_PINS,
    buildQemuArguments,
    runWindowsCpuFloorStage2,
    validatePackageClosure,
    selectWindowsImage
} from "../../scripts/qualification/linux-windows-cpu-floor-stage2.mjs";
import {STAGE2_LIMITS} from "../../scripts/qualification/linux-windows-cpu-floor-admission.mjs";
import {createHostedStage2Operations} from
    "../../scripts/qualification/linux-windows-cpu-floor-stage2-hosted.mjs";

const NONCE = "0123456789abcdef0123456789abcdef";
const HASH = value => crypto.createHash("sha256").update(value).digest("hex");
const FILE_HASH = "a".repeat(64);

function context() {
    return {schemaVersion: 1, repository: "i7Gamer/MySpeed", sourceSha: "b".repeat(40),
        eventSha: "c".repeat(40), runId: "123", runAttempt: "1", nonce: NONCE,
        environment: {GITHUB_ACTIONS: "true", CI: "true", RUNNER_OS: "Linux", RUNNER_ARCH: "X64",
            RUNNER_ENVIRONMENT: "github-hosted", ImageOS: "ubuntu24", ImageVersion: "20260907.1"}};
}

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
    {index: 2, name: "Windows Server 2025 Standard Evaluation (Desktop Experience)", architecture: "x64",
        editionId: "ServerStandardEval", installationType: "Server", totalBytes: "25000000000"}];
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
    sevenZip: {path: `${portable}/usr/bin/7zz`, invocationPath: `${portable}/usr/bin/7zz`, bytes: "4096",
        sha256: "e".repeat(64), ownership},
    wiminfo: {path: `${portable}/usr/bin/wiminfo`, invocationPath: `${portable}/usr/bin/wiminfo`, bytes: "4096",
        sha256: "f".repeat(64), ownership},
    ovmfCode: {path: `${portable}/usr/share/OVMF/OVMF_CODE_4M.fd`, bytes: "4096", sha256: "1".repeat(64), ownership},
    ovmfVarsTemplate: {path: `${portable}/usr/share/OVMF/OVMF_VARS_4M.fd`, bytes: "4096", sha256: "2".repeat(64), ownership},
    runtime: {loader: {path: `${portable}/usr/lib/x86_64-linux-gnu/ld-linux-x86-64.so.2`,
        bytes: "4096", sha256: "4".repeat(64), ownership}, libraryPath: [`${portable}/lib/x86_64-linux-gnu`,
        `${portable}/usr/lib/x86_64-linux-gnu`]},
    packageClosureSha256: HASH(Buffer.from(JSON.stringify(validatePackageClosure(packageClosure())))),
    installedFilesManifest: {bytes: "10000", sha256: "6".repeat(64)},
    licensesManifest: {bytes: "2000", sha256: "7".repeat(64)},
    capabilities: {cpuModels: ["Westmere-v2"], machines: ["q35"], devices: ["ich9-ahci", "ide-cd", "ide-hd",
        "isa-serial"], accelerator: "kvm"}};
}

function guestEvidence() {
    return {schemaVersion: 1, status: "observed", cpu: {sse42: true, popcnt: true, osxsave: false,
        avx: false, avx2: false, xcr0: null}, instructions: {sse42: "completed", popcnt: "completed",
        avx: "illegal-instruction", avx2: "illegal-instruction"}, network: {hardwareNics: 0,
        enabledNonLoopbackInterfaces: 0, nonLoopbackRoutes: 0}, output: {path: paths().outputDisk,
        bytes: "67108864", sha256: "3".repeat(64)}};
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
        async prepareOfflineMedia(input) { calls.push("prepare-media"); seen.seedSpec = input.seedSpec; return {seedIso: {path: input.paths.seedIso,
            bytes: "1048576", sha256: "8".repeat(64), sourceManifestSha256: input.seedSpec.sha256,
            format: "iso9660", volumeLabel: "MYSPEEDSEED"}, outputDisk: {path: input.paths.outputDisk,
            bytes: "67108864", sha256: "0".repeat(64), format: "raw-fat", volumeLabel: "MYSPEEDOUT"}, systemDisk: {path: input.paths.systemDisk,
            bytes: "196616", sha256: "3".repeat(64), virtualBytes: "51539607552", format: "qcow2"}, ovmfVars: {path: input.paths.ovmfVars,
            sha256: toolchain().ovmfVarsTemplate.sha256}}; },
        async launchOwnedQemu(input) { calls.push("launch"); return {process: {exitCode: 0, signal: null,
            timedOut: false, cleanupProven: true, treeGone: true, qemuPid: 2345,
            qemuStartTicks: "77", launcherExecutablePath: toolchain().runtime.loader.path, processGroupId: 2300,
            qemuPidAbsentAfter: true, terminationReason: null}, argv: input.argv, guest: guestEvidence()}; },
        ...overrides
    };
    return {op, calls, seen};
}

describe("hosted Windows CPU-floor Stage 2 runnable preparation", () => {
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

    it("selects the exact unique supported Server Core edition from observed WIM metadata", () => {
        assert.deepEqual(selectWindowsImage(imageInventory()), imageInventory()[0]);
        assert.throws(() => selectWindowsImage([...imageInventory(), imageInventory()[0]]), /duplicated|unique/u);
        assert.throws(() => selectWindowsImage(imageInventory().map(value => ({...value, architecture: "arm64"}))),
            /unique/u);
    });

    it("builds the fixed offline KVM vector without implicit or network devices", () => {
        const argv = buildQemuArguments({paths: paths(), toolchain: toolchain()});
        assert.deepEqual(argv.slice(0, 16), ["-nodefaults", "-no-user-config", "-display", "none", "-monitor",
            "none", "-accel", "kvm", "-machine", "q35", "-cpu", "Westmere-v2", "-smp",
            "2,sockets=1,cores=2,threads=1", "-m", "6144M"]);
        assert.equal(argv.includes("-nic"), true);
        assert.equal(argv[argv.indexOf("-nic") + 1], "none");
        assert.equal(argv.includes("-no-reboot"), false);
        assert.equal(argv[argv.indexOf("-boot") + 1], "once=d,order=c,strict=on");
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
        assert.equal(result.selectedImage.index, 1);
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
        assert.match(bootstrap, /SetErrorMode\(3\)/u);
        assert.match(bootstrap, /WaitForExit\(\$PROBE_TIMEOUT_MILLISECONDS\)/u);
        assert.match(bootstrap, /BitConverter\]::ToUInt32/u);
        assert.doesNotMatch(bootstrap, /Enable-NetAdapter|New-NetIPAddress|Set-Net/u);
        assert.deepEqual(seen.seedSpec.files.filter(file => file.kind === "owned-file").map(file => file.name),
            PROBE_ROLES.map(role => `${role}.exe`));
        assert.equal(seen.seedSpec.files.find(file => file.name === "known-good.exe").sourcePath,
            `${paths().probeRoot}/known_good.exe`);
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
            ["toolchain alias", {extractPortableTools: async () => {
                const changed = toolchain(); changed.wiminfo.invocationPath = `${paths().portableRoot}/usr/bin/wimlib-imagex`;
                return changed;
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
    });

    it("records failure and cleanup truth without treating a QEMU CPU name as calibration", async () => {
        const fixture = operations({launchOwnedQemu: async input => ({process: {exitCode: null, signal: "SIGKILL",
            timedOut: true, cleanupProven: false, treeGone: false}, argv: input.argv, guest: null})});
        const result = await runWindowsCpuFloorStage2({context: context(), admission: admission(), paths: paths(),
            probeArtifact: probeArtifact()},
            fixture.op);
        assert.equal(result.status, "failed");
        assert.equal(result.stage, "qemu-launch");
        assert.equal(result.cpuCalibrationAccepted, false);
        assert.equal(result.cleanupProven, false);
        assert.equal(result.qualifying, false);
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
});
