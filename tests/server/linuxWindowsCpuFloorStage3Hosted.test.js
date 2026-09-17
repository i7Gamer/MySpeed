import assert from "node:assert/strict";
import crypto from "node:crypto";
import {describe, it} from "node:test";

import {
    createHostedStage3Operations,
    renderBaselineAutounattend
} from "../../scripts/qualification/linux-windows-cpu-floor-stage3-hosted.mjs";
import {PROBE_SEED_FILES} from "../../scripts/qualification/linux-windows-cpu-floor-stage2.mjs";

const NONCE = "2".repeat(32);
const SHA = character => character.repeat(64);
const ROOT = `/home/runner/work/_temp/myspeed-stage3-${NONCE}`;
const PORTABLE_ROOT = `/tmp/myspeed-windows-cpu-floor-tools-${NONCE}`;
const context = () => ({schemaVersion: 1, repository: "i7Gamer/MySpeed", sourceSha: "1".repeat(40),
    eventSha: "3".repeat(40), runId: "123", runAttempt: "1", nonce: NONCE, environment: {
        GITHUB_ACTIONS: "true", CI: "true", RUNNER_OS: "Linux", RUNNER_ARCH: "X64",
        RUNNER_ENVIRONMENT: "github-hosted", ImageOS: "ubuntu24", ImageVersion: "20260901.1"}});
const paths = () => ({root: ROOT, systemDisk: `${ROOT}/stage3.qcow2`, seedIso: `${ROOT}/baseline-seed.iso`,
    outputDisk: `${ROOT}/baseline-output.img`, ovmfVars: `${ROOT}/OVMF_VARS.fd`,
    qemuPid: `${ROOT}/baseline-qemu.pid`, serialLog: `${ROOT}/baseline-serial.log`});
const record = (name, character, bytes = "4096") => ({name, path: `${ROOT}/candidate/${name}`, bytes,
    sha256: SHA(character)});
const PROBE_NAMES = ["avx.exe", "avx2.exe", "cpuid.exe", "illegal.exe", "known_bad.exe", "known_good.exe",
    "popcnt.exe", "sse42.exe"];
const guestFiles = () => [record("node.exe", "6", "52428800"), record("request.json", "7"),
    record("execution.json", "8"), record("fixture-bundle.json", "9"), record("guest-runtime.json", "a"),
    record("runtime-installer.ps1", "b"), ...PROBE_NAMES.map((name, index) => record(name, String(index + 1)))];
const candidate = () => ({
    artifactId: "563103679",
    artifactName: "MySpeed-windows-x64-baseline.exe",
    releaseAssetId: "563103679",
    releaseAssetDigest: `sha256:${SHA("2")}`,
    archive: {bytes: "1048576", sha256: SHA("1")},
    sourceSha: "4".repeat(40),
    runId: "34829932391",
    runAttempt: "1",
    tagName: "v1.6.1",
    file: {name: "MySpeed.exe", bytes: "524288", sha256: SHA("2")},
    qualificationSummary: {name: "qualification-summary.json", bytes: "8192", sha256: SHA("3")},
    manifest: {name: "qualification-manifest.json", bytes: "65536", sha256: SHA("4")}});
const rootOwnership = () => ({uid: "0", gid: "0", mode: "555", ordinaryUserWritable: false});
const toolchain = () => ({runtime: {loader: {path: `${PORTABLE_ROOT}/usr/lib/ld-linux.so.2`, bytes: "4096",
    sha256: SHA("c"), ownership: rootOwnership()},
    libraryPath: [`${PORTABLE_ROOT}/usr/lib`]}, qemu: {path: `${PORTABLE_ROOT}/usr/bin/qemu-system-x86_64`,
    invocationPath: `${PORTABLE_ROOT}/usr/bin/qemu-system-x86_64`, bytes: "4096", sha256: SHA("f"),
    ownership: rootOwnership()},
    firmware: {searchPath: `${PORTABLE_ROOT}/usr/share/qemu`,
        kvmvapic: {path: `${PORTABLE_ROOT}/usr/share/qemu/kvmvapic.bin`, bytes: "4096", sha256: SHA("e"), ownership: rootOwnership()},
        vga: {path: `${PORTABLE_ROOT}/usr/share/seabios/vgabios-stdvga.bin`, bytes: "4096", sha256: SHA("e"), ownership: rootOwnership()}},
    mcopy: {path: `${PORTABLE_ROOT}/usr/bin/mtools`, invocationPath: `${PORTABLE_ROOT}/usr/bin/mcopy`, bytes: "4096",
        sha256: SHA("d"), ownership: rootOwnership()}});
const stage2 = () => ({privilegeMode: "reviewed-sudo-kvm", toolchain: toolchain(),
    selectedImage: {name: "Windows Server 2025 SERVERSTANDARD"}});
const processProof = () => ({exitCode: 0, signal: null, timedOut: false, cleanupProven: true, treeGone: true,
    qemuPid: 100, qemuStartTicks: "10", processGroupId: 100, qemuPidAbsentAfter: true,
    launcherExecutablePath: toolchain().runtime.loader.path, terminationReason: null});
const processObservation = {exitCode: 0, signal: null, timedOut: false, cleanupProven: true,
    errorObserved: false, stdoutOverflow: false, stderrOverflow: false};
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
const EARLY_BOOT = Object.freeze({schemaVersion: 1, kind: "qemu-early-boot-observation", inputSent: false,
    version: {major: 8, minor: 2, micro: 2}, status: "running", running: true,
    screenshots: [1, 2].map(index => ({path: `${ROOT}/early-boot-${index}.png`, bytes: String(PNG.length),
        sha256: crypto.createHash("sha256").update(PNG).digest("hex"), bytesBase64: PNG.toString("base64")}))});

function fixture(overrides = {}) {
    const calls = [];
    const files = new Map([
        [`${ROOT}/candidate/MySpeed.exe`, {path: `${ROOT}/candidate/MySpeed.exe`, bytes: "524288", sha256: SHA("2")}],
        [`${ROOT}/candidate/qualification-summary.json`, {path: `${ROOT}/candidate/qualification-summary.json`,
            bytes: "8192", sha256: SHA("3")}],
        [`${ROOT}/candidate/qualification-manifest.json`, {path: `${ROOT}/candidate/qualification-manifest.json`,
            bytes: "65536", sha256: SHA("4")}],
        ...guestFiles().map(({name: _name, path: target, bytes, sha256}) => [target, {path: target, bytes, sha256}]),
        [`${ROOT}/OVMF_VARS.fd`, {path: `${ROOT}/OVMF_VARS.fd`, bytes: "540672", sha256: SHA("6")}],
        [toolchain().runtime.loader.path, toolchain().runtime.loader],
        [toolchain().mcopy.path, toolchain().mcopy]
    ]);
    const stage2ResultIdentity = {path: `/home/runner/work/_temp/myspeed-stage2-transport-${NONCE}/stage2-result.json`,
        bytes: "65536", sha256: SHA("7")};
    const stage2Guest = {schemaVersion: 1, nonce: NONCE, runs: [], network: {hardwareNics: 0,
        enabledNonLoopbackInterfaces: 0, nonLoopbackRoutes: 0}};
    const stage2GuestBytes = Buffer.from(`${JSON.stringify(stage2Guest)}\n`, "utf8");
    const stage2GuestResultIdentity = {
        path: `/home/runner/work/_temp/myspeed-stage2-transport-${NONCE}/guest-result.json`,
        bytes: String(stage2GuestBytes.length), sha256: crypto.createHash("sha256").update(stage2GuestBytes).digest("hex")};
    const baseline = {schemaVersion: 1, status: "observed"};
    const baselineBytes = Buffer.from(`${JSON.stringify(baseline)}\n`, "utf8");
    const baselineIdentity = {path: `${ROOT}/baseline-result.json`, bytes: String(baselineBytes.length),
        sha256: crypto.createHash("sha256").update(baselineBytes).digest("hex")};
    const dependencies = {
        deriveActualContext: () => context(),
        inspectFile: target => {
            calls.push(["inspect", target]);
            if (!files.has(target)) throw new Error(`unexpected inspect ${target}`);
            return files.get(target);
        },
        readJson: target => {
            calls.push(["read", target]);
            if (target === stage2ResultIdentity.path) return {identity: stage2ResultIdentity, value: stage2()};
            if (target === stage2GuestResultIdentity.path) return {identity: stage2GuestResultIdentity,
                bytesBase64: stage2GuestBytes.toString("base64"), value: stage2Guest};
            if (target === `${ROOT}/baseline-result.json`) return {identity: baselineIdentity,
                bytesBase64: baselineBytes.toString("base64"), value: baseline};
            throw new Error(`unexpected read ${target}`);
        },
        pathExists: () => false,
        unixMilliseconds: () => NOW_MILLISECONDS,
        runOwned: async (command, argv, options) => { calls.push(["run", command, argv, options]);
            return {process: processObservation, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0)}; },
        stage2Factory: input => { calls.push(["factory", input]); return {
            async prepareOfflineMedia(request) { calls.push(["media", request]); return {
                seedIso: {path: paths().seedIso, bytes: "8192", sha256: SHA("9")},
                outputDisk: {path: paths().outputDisk, bytes: "67108864", sha256: SHA("a")},
                systemDisk: {path: paths().systemDisk, bytes: "8192", sha256: SHA("b"),
                    virtualBytes: "51539607552"}, ovmfVars: {path: paths().ovmfVars, sha256: SHA("6")}}; },
            async launchOwnedQemu(request) { calls.push(["launch", request]); return {argv: request.argv,
                process: processProof(), earlyBoot: structuredClone(EARLY_BOOT),
                guest: {schemaVersion: 1, status: "observed",
                    output: {path: paths().outputDisk, bytes: "67108864", sha256: SHA("a")}}}; }
        }; },
        ...overrides
    };
    const operations = createHostedStage3Operations({context: context(), paths: paths(),
        guestFiles: guestFiles(), dependencies});
    return {operations, calls, stage2ResultIdentity, stage2GuestResultIdentity, stage2GuestBytes, baseline};
}

const WALL_DEADLINE_MILLISECONDS = Date.parse("2026-09-16T13:20:00Z");
const NOW_MILLISECONDS = WALL_DEADLINE_MILLISECONDS - 80 * 60_000;
const budget = () => ({label: "cpu-floor-stage3-baseline",
    wallDeadlineUnixMilliseconds: WALL_DEADLINE_MILLISECONDS});

describe("hosted Windows CPU-floor Stage 3 operations", () => {
    it("rejects a copied context before inspecting any file", () => {
        let inspected = false;
        assert.throws(() => createHostedStage3Operations({context: context(), paths: paths(),
            guestFiles: guestFiles(), dependencies: {
                deriveActualContext: () => ({...context(), runAttempt: "2"}), inspectFile: () => { inspected = true; }
            }}), /actual hosted context/u);
        assert.equal(inspected, false);
    });

    it("requires the exact closed guest seed inventory before creating native operations", () => {
        let created = false;
        const identities = new Map(guestFiles().map(record => [record.path, record]));
        assert.throws(() => createHostedStage3Operations({context: context(), paths: paths(),
            guestFiles: guestFiles().filter(record => record.name !== "avx2.exe"), dependencies: {
                deriveActualContext: () => context(), inspectFile: target => identities.get(target),
                stage2Factory: () => { created = true; return {}; }
            }}), /guest closure file set/u);
        assert.equal(created, false);
        const extra = record("unexpected.exe", "f");
        identities.set(extra.path, extra);
        assert.throws(() => createHostedStage3Operations({context: context(), paths: paths(),
            guestFiles: [...guestFiles(), extra], dependencies: {
                deriveActualContext: () => context(), inspectFile: target => identities.get(target)
            }}), /guest closure file set/u);
    });

    it("replays exact Stage 2 bytes and stages exact candidate and guest files", async () => {
        const value = fixture();
        const replay = await value.operations.replayStage2({identity: value.stage2ResultIdentity,
            guestIdentity: value.stage2GuestResultIdentity});
        assert.deepEqual(replay, {identity: value.stage2ResultIdentity, result: stage2(), guestEvidence: {
            identity: value.stage2GuestResultIdentity, bytesBase64: value.stage2GuestBytes.toString("base64")}});
        const acquired = await value.operations.acquireCandidate({candidate: candidate()});
        assert.equal(acquired.stagedFile.path, `${ROOT}/candidate/MySpeed.exe`);
        assert.equal(acquired.stagedManifest.sha256, candidate().manifest.sha256);
    });

    it("rejects a raw Stage 2 guest identity that differs from the retained file", async () => {
        const value = fixture();
        await assert.rejects(value.operations.replayStage2({identity: value.stage2ResultIdentity,
            guestIdentity: {...value.stage2GuestResultIdentity, sha256: SHA("8")}}),
        /raw guest result identity differs/u);
    });

    it("reuses reviewed Stage 2 media and QEMU operations then extracts only after launch returns", async () => {
        const value = fixture();
        await value.operations.replayStage2({identity: value.stage2ResultIdentity,
            guestIdentity: value.stage2GuestResultIdentity});
        const acquired = await value.operations.acquireCandidate({candidate: candidate()});
        const media = await value.operations.prepareBaselineMedia({candidate: acquired, paths: paths(), stage2: stage2(),
            toolchain: toolchain()});
        assert.equal(media.systemDisk.virtualBytes, "51539607552");
        const mediaRequest = value.calls.find(call => call[0] === "media")[1];
        const seededNames = mediaRequest.seedSpec.files.map(file => file.name);
        assert.ok(["execution.json", "fixture-bundle.json", "guest-runtime.json", "runtime-installer.ps1"]
            .every(name => seededNames.includes(name)));
        const bootstrapRecord = mediaRequest.seedSpec.files.find(file => file.name === "baseline-bootstrap.ps1");
        const bootstrap = Buffer.from(bootstrapRecord.bytesBase64, "base64").toString("utf8");
        assert.match(bootstrap, /Install-MyspeedBaselineRuntimeBundle/u);
        assert.match(bootstrap, /windows-baseline-guest-executor\.mjs/u);
        assert.doesNotMatch(bootstrap, /baseline-guest-runner\.mjs/u);
        const launch = await value.operations.launchBaselineGuest({argv: ["-nic", "none"], budget: budget(), paths: paths(),
            stage2: stage2(), toolchain: toolchain()});
        assert.equal(launch.process.treeGone, true);
        const result = await value.operations.collectBaselineGuestResult({outputDisk: launch.outputDisk});
        assert.deepEqual(result, {identity: {path: `${ROOT}/baseline-result.json`,
            bytes: String(Buffer.byteLength(`${JSON.stringify(value.baseline)}\n`)),
            sha256: crypto.createHash("sha256").update(`${JSON.stringify(value.baseline)}\n`).digest("hex")},
        bytesBase64: Buffer.from(`${JSON.stringify(value.baseline)}\n`).toString("base64"), result: value.baseline,
        sourceOutputDisk: launch.outputDisk});
        const names = value.calls.map(call => call[0]);
        assert.ok(names.indexOf("launch") < names.indexOf("run"));
        const extraction = value.calls.find(call => call[0] === "run");
        assert.deepEqual(extraction[2].slice(-5), [toolchain().mcopy.path, "-i", paths().outputDisk,
            "::baseline-result.json", `${ROOT}/baseline-result.json`]);
    });

    it("passes raw QEMU arguments once through the actual Stage 2 factory", async () => {
        const monitored = [];
        const value = fixture({stage2Factory: undefined, native: {
            monotonicMilliseconds: () => 1,
            inspectDirectory: target => ({path: target, uid: "0", gid: "0", mode: target === "/tmp" ? "1777" : "755",
                sticky: target === "/tmp", ordinaryUserWritable: false}),
            inspectOwned: target => {
                if (target === toolchain().runtime.loader.path) return toolchain().runtime.loader;
                if (target === toolchain().qemu.path) return {...toolchain().qemu, bytes: "4096", sha256: SHA("f"),
                    ownership: rootOwnership()};
                return {path: target, bytes: "4096", sha256: SHA("e"), ownership: rootOwnership()};
            },
            runMonitoredQemu: async request => { monitored.push(request); return {observation: {process: {
                ...processObservation}, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0)}, identity: {pid: 100, startTicks: "10", processGroupId: 100,
                executablePath: toolchain().runtime.loader.path}, absentAfter: true, processGroupGone: true,
            terminationReason: null}; },
            runOwned: async () => ({process: processObservation, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0)}),
            readOwnedVerified: () => ({bytes: Buffer.from(JSON.stringify({schemaVersion: 1, status: "failed",
                nonce: NONCE, stage: "test", failure: "expected"}))}), pathExists: () => false
        }});
        await value.operations.replayStage2({identity: value.stage2ResultIdentity,
            guestIdentity: value.stage2GuestResultIdentity});
        const raw = ["-nodefaults", "-nic", "none"];
        await assert.rejects(value.operations.launchBaselineGuest({argv: raw, budget: budget(), paths: paths(), stage2: stage2(),
            toolchain: toolchain()}), /did not return/u);
        assert.equal(monitored.length, 1);
        // The bounded reservation, not the launcher's generic 16200s allowance.
        assert.deepEqual(monitored[0].argv.slice(0, 10), ["-n", "--", "/usr/bin/timeout", "--foreground",
            "--signal=KILL", "3300s", toolchain().runtime.loader.path, "--argv0",
            toolchain().qemu.invocationPath, "--library-path"]);
        assert.equal(monitored[0].argv.includes("16200s"), false);
        assert.equal(monitored[0].timeoutMs, 55 * 60_000 + 2 * 60_000);
        assert.deepEqual(monitored[0].argv.slice(-raw.length), raw);
        assert.equal(monitored[0].argv.filter(value => value === "--argv0").length, 1);
    });

    it("does not extract output before replaying the Stage 2 toolchain", async () => {
        const value = fixture();
        await assert.rejects(value.operations.collectBaselineGuestResult({outputDisk: {path: paths().outputDisk}}),
            /not replayed/u);
        assert.equal(value.calls.some(call => call[0] === "run"), false);
    });

    it("does not extract output until the exact launched QEMU group is gone", async () => {
        const value = fixture();
        await value.operations.replayStage2({identity: value.stage2ResultIdentity,
            guestIdentity: value.stage2GuestResultIdentity});
        await assert.rejects(value.operations.collectBaselineGuestResult({outputDisk: {path: paths().outputDisk}}),
            /QEMU cleanup was not proven/u);
        const failed = fixture({stage2Factory: _input => ({
            async prepareOfflineMedia() { throw new Error("not used"); },
            async launchOwnedQemu(request) { return {argv: request.argv, process: {...processProof(), treeGone: false},
                earlyBoot: structuredClone(EARLY_BOOT),
                guest: {status: "observed", output: {path: paths().outputDisk, bytes: "67108864", sha256: SHA("a")}}}; }
        })});
        await failed.operations.replayStage2({identity: failed.stage2ResultIdentity,
            guestIdentity: failed.stage2GuestResultIdentity});
        await assert.rejects(failed.operations.launchBaselineGuest({argv: ["-nic", "none"], budget: budget(), paths: paths(),
            stage2: stage2(), toolchain: toolchain()}), /QEMU cleanup was not proven/u);
        assert.equal(value.calls.some(call => call[0] === "run"), false);
    });

    it("carries the guest's own failure receipt into the launch refusal instead of discarding it", async () => {
        const guestFailure = {schemaVersion: 1, status: "failed", nonce: NONCE, stage: "guest-bootstrap",
            failure: "executor-invocation: Baseline executor left an owned descendant"};
        const launched = guest => fixture({stage2Factory: _input => ({
            async prepareOfflineMedia() { throw new Error("not used"); },
            async launchOwnedQemu(request) { return {argv: request.argv, process: processProof(),
                earlyBoot: structuredClone(EARLY_BOOT), ...guest}; }
        })});
        const withReceipt = launched({guest: structuredClone(guestFailure), guestFailure: structuredClone(guestFailure)});
        await withReceipt.operations.replayStage2({identity: withReceipt.stage2ResultIdentity,
            guestIdentity: withReceipt.stage2GuestResultIdentity});
        await assert.rejects(withReceipt.operations.launchBaselineGuest({argv: ["-nic", "none"], budget: budget(),
            paths: paths(), stage2: stage2(), toolchain: toolchain()}), {
            message: "baseline guest did not return the CPU calibration envelope: " +
                "executor-invocation: Baseline executor left an owned descendant"
        });
        const withoutReceipt = launched({guest: null});
        await withoutReceipt.operations.replayStage2({identity: withoutReceipt.stage2ResultIdentity,
            guestIdentity: withoutReceipt.stage2GuestResultIdentity});
        await assert.rejects(withoutReceipt.operations.launchBaselineGuest({argv: ["-nic", "none"], budget: budget(),
            paths: paths(), stage2: stage2(), toolchain: toolchain()}),
        {message: "baseline guest did not return the CPU calibration envelope"});
        const malformed = launched({guest: null, guestFailure: {failure: 42}});
        await malformed.operations.replayStage2({identity: malformed.stage2ResultIdentity,
            guestIdentity: malformed.stage2GuestResultIdentity});
        await assert.rejects(malformed.operations.launchBaselineGuest({argv: ["-nic", "none"], budget: budget(),
            paths: paths(), stage2: stage2(), toolchain: toolchain()}),
        {message: "baseline guest did not return the CPU calibration envelope"});
    });
});

describe("hosted Windows CPU-floor Stage 3 seed contract", () => {
    const seedFiles = async () => {
        const value = fixture();
        await value.operations.replayStage2({identity: value.stage2ResultIdentity,
            guestIdentity: value.stage2GuestResultIdentity});
        const acquired = await value.operations.acquireCandidate({candidate: candidate()});
        await value.operations.prepareBaselineMedia({candidate: acquired, paths: paths(), stage2: stage2(),
            toolchain: toolchain()});
        return value.calls.find(call => call[0] === "media")[1].seedSpec.files;
    };
    const byName = files => new Map(files.map(file => [file.name, file]));
    const text = file => Buffer.from(file.bytesBase64, "base64").toString("utf8");

    it("renames only the two hyphen-role probes and keeps their source and digest untouched", async () => {
        const files = byName(await seedFiles());
        for (const [seedName, artifactName] of [["known-bad.exe", "known_bad.exe"],
            ["known-good.exe", "known_good.exe"]]) {
            const seeded = files.get(seedName);
            const original = guestFiles().find(record => record.name === artifactName);
            assert.ok(seeded, `${seedName} is absent from the seed`);
            assert.equal(files.has(artifactName), false);
            assert.equal(seeded.kind, "owned-file");
            assert.equal(seeded.sourcePath, original.path);
            assert.equal(seeded.sha256, original.sha256);
            assert.equal(seeded.bytes, original.bytes);
        }
        for (const name of ["avx.exe", "avx2.exe", "cpuid.exe", "illegal.exe", "popcnt.exe", "sse42.exe"])
            assert.ok(files.has(name), `${name} is absent from the seed`);
    });

    it("seeds every probe name the reused Stage 2 collector will actually open", async () => {
        const files = byName(await seedFiles());
        const collector = text(files.get("cpu-calibration.ps1"));
        for (const entry of PROBE_SEED_FILES) {
            assert.ok(collector.includes(`'${entry.role}'`), `collector omits role ${entry.role}`);
            assert.ok(files.has(entry.seedName), `seed omits ${entry.seedName}`);
        }
    });

    it("installs the shared post-setup activation instead of running the bootstrap inside setup", async () => {
        const files = byName(await seedFiles());
        assert.equal(files.has("bootstrap.ps1"), false);
        for (const name of ["install-activation.ps1", "myspeed-baseline-cpu-handoff.json", "SetupComplete.cmd",
            "myspeed-msi-setupcomplete.ps1", "baseline-bootstrap.ps1"])
            assert.ok(files.has(name), `${name} is absent from the seed`);
        assert.equal(files.get("install-activation.ps1").kind, "activation-installer");
        assert.equal(files.get("myspeed-baseline-cpu-handoff.json").kind, "activation-handoff");
        assert.equal(files.get("SetupComplete.cmd").kind, "activation-inline");
        assert.equal(files.get("myspeed-msi-setupcomplete.ps1").kind, "activation-inline");
        const handoff = JSON.parse(text(files.get("myspeed-baseline-cpu-handoff.json")));
        const bootstrap = files.get("baseline-bootstrap.ps1");
        assert.equal(handoff.kind, "myspeed-windows-baseline-cpu-handoff");
        assert.deepEqual(handoff.bootstrap, {name: "baseline-bootstrap.ps1", bytes: Number(bootstrap.bytes),
            sha256: bootstrap.sha256});
        assert.deepEqual(handoff.host, {repository: context().repository, sourceSha: context().sourceSha,
            eventSha: context().eventSha, runId: context().runId, runAttempt: context().runAttempt,
            nonce: context().nonce});
    });

    it("binds the activation files the collector will hash to the ones the seed installs", async () => {
        const files = byName(await seedFiles());
        const collector = text(files.get("cpu-calibration.ps1"));
        for (const name of ["SetupComplete.cmd", "myspeed-msi-setupcomplete.ps1"]) {
            const seeded = files.get(name);
            assert.ok(collector.includes(`'${seeded.sha256}'`), `collector does not pin ${name}`);
            assert.ok(collector.includes(`= ${seeded.bytes}`), `collector does not pin ${name} size`);
        }
    });

    it("dispatches after setup completion rather than inside the specialize pass", () => {
        const unattend = renderBaselineAutounattend({name: "Windows Server 2025 SERVERSTANDARD"}, NONCE)
            .toString("utf8");
        assert.match(unattend, /install-activation\.ps1/u);
        assert.doesNotMatch(unattend, /bootstrap\.ps1/u);
    });

    it("answers the Windows Setup language page from the windowsPE pass", () => {
        const unattend = renderBaselineAutounattend({name: "Windows Server 2025 SERVERSTANDARD"}, NONCE)
            .toString("utf8");
        const windowsPe = unattend.match(/<settings pass="windowsPE">([\s\S]*?)<\/settings>/u);
        assert.ok(windowsPe, "answer file has no windowsPE pass");
        assert.match(windowsPe[1], /<component name="Microsoft-Windows-International-Core-WinPE" /u);
        assert.match(windowsPe[1], /<SetupUILanguage><UILanguage>en-US<\/UILanguage><\/SetupUILanguage>/u);
        for (const setting of ["InputLocale", "SystemLocale", "UILanguage", "UserLocale"])
            assert.match(windowsPe[1], new RegExp(`<${setting}>en-US</${setting}>`, "u"));
        assert.doesNotMatch(unattend.replace(/<settings pass="windowsPE">[\s\S]*?<\/settings>/u, ""),
            /International-Core-WinPE/u);
    });

    it("carries the launcher's early-boot observation out of the Stage 3 launch", async () => {
        const value = fixture();
        await value.operations.replayStage2({identity: value.stage2ResultIdentity,
            guestIdentity: value.stage2GuestResultIdentity});
        const launch = await value.operations.launchBaselineGuest({argv: ["-nic", "none"], budget: budget(), paths: paths(),
            stage2: stage2(), toolchain: toolchain()});
        assert.deepEqual(launch.earlyBoot, EARLY_BOOT);
        assert.deepEqual(value.calls.find(call => call[0] === "launch")[1].bootConfirmation, undefined);
    });

    it("refuses a launch whose early-boot observation the launcher could not complete", async () => {
        const value = fixture({stage2Factory: () => ({
            async prepareOfflineMedia() { throw new Error("not used"); },
            async launchOwnedQemu(request) { return {argv: request.argv, process: processProof(), earlyBoot: null,
                guest: {schemaVersion: 1, status: "observed",
                    output: {path: paths().outputDisk, bytes: "67108864", sha256: SHA("a")}}}; }
        })});
        await value.operations.replayStage2({identity: value.stage2ResultIdentity,
            guestIdentity: value.stage2GuestResultIdentity});
        await assert.rejects(value.operations.launchBaselineGuest({argv: ["-nic", "none"], budget: budget(), paths: paths(),
            stage2: stage2(), toolchain: toolchain()}), /early-boot observation/u);
    });

    it("admits one bounded reservation from the declared budget instead of the generic allowance", async () => {
        const value = fixture();
        await value.operations.replayStage2({identity: value.stage2ResultIdentity,
            guestIdentity: value.stage2GuestResultIdentity});
        const launch = await value.operations.launchBaselineGuest({argv: ["-nic", "none"], budget: budget(),
            paths: paths(), stage2: stage2(), toolchain: toolchain()});
        const expected = {label: "cpu-floor-stage3-baseline", executionMilliseconds: 55 * 60_000,
            cleanupMilliseconds: 2 * 60_000};
        assert.deepEqual(launch.reservation, expected);
        assert.deepEqual(value.calls.find(call => call[0] === "launch")[1].reservation, expected);
    });

    it("refuses to start a guest the declared deadline can no longer hold", async () => {
        const value = fixture({unixMilliseconds: () => WALL_DEADLINE_MILLISECONDS - 10 * 60_000});
        await value.operations.replayStage2({identity: value.stage2ResultIdentity,
            guestIdentity: value.stage2GuestResultIdentity});
        await assert.rejects(value.operations.launchBaselineGuest({argv: ["-nic", "none"], budget: budget(),
            paths: paths(), stage2: stage2(), toolchain: toolchain()}), /Stage 3 execution budget/u);
        assert.equal(value.calls.some(call => call[0] === "launch"), false);
    });

    it("refuses a launch that declares no budget at all", async () => {
        const value = fixture();
        await value.operations.replayStage2({identity: value.stage2ResultIdentity,
            guestIdentity: value.stage2GuestResultIdentity});
        await assert.rejects(value.operations.launchBaselineGuest({argv: ["-nic", "none"], paths: paths(),
            stage2: stage2(), toolchain: toolchain()}), /Stage 3 budget keys are invalid/u);
        assert.equal(value.calls.some(call => call[0] === "launch"), false);
    });

    it("forwards only an explicitly bound Stage 3 confirmation to the shared launcher", async () => {
        const value = fixture();
        await value.operations.replayStage2({identity: value.stage2ResultIdentity,
            guestIdentity: value.stage2GuestResultIdentity});
        await value.operations.launchBaselineGuest({argv: ["-nic", "none"], budget: budget(), paths: paths(), stage2: stage2(),
            toolchain: toolchain(), bootConfirmation: "single-enter-before-setup-v1"});
        assert.equal(value.calls.find(call => call[0] === "launch")[1].bootConfirmation,
            "single-enter-before-setup-v1");
    });
});
