import assert from "node:assert/strict";
import crypto from "node:crypto";
import {describe, it} from "node:test";

import {runWindowsCpuFloorStage3, validateCompletedStage3Result} from
    "../../scripts/qualification/linux-windows-cpu-floor-stage3.mjs";
import {createHostedStage3Operations} from "../../scripts/qualification/linux-windows-cpu-floor-stage3-hosted.mjs";
import {PROBE_SEED_FILES, WINDOWS_SYSTEM_TOOL_PATHS} from
    "../../scripts/qualification/linux-windows-cpu-floor-stage2.mjs";
import {INSTALLER_BOOT_CONFIRMATION, validateScreenshots} from
    "../../scripts/qualification/linux-windows-cpu-floor-stage2-qmp.mjs";
import {buildWindowsMsiSetupCompleteActivation, getCompletedWindowsMsiActivationEvidence} from
    "../../scripts/qualification/windows-msi-post-setup-activation.mjs";
import {POST_RELEASE_CPU_FLOOR_GUEST_PREPARATION_CONSTANTS} from
    "../../scripts/release/post-release-cpu-floor-guest-preparation.mjs";
import {bindV161PostReleaseTarget} from "../../scripts/release/post-release-target.mjs";
import {
    acquireV161PostReleaseCpuFloorBaselineSummary,
    buildV161PostReleaseCpuFloorStage3Request,
    createV161PostReleaseCpuFloorBinding,
    inspectV161PostReleaseCpuFloorEvidence
} from "../../scripts/release/post-release-cpu-floor.mjs";
import {acquisitionInput, buildPostReleaseStage3Fixture, hostedContext, manifestBytes, placeholderStage2Receipts,
    stage3ExecutionPlan,
    targetInput} from "../helpers/post-release-cpu-floor-fixture.mjs";

const SHA = character => character.repeat(64);
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]);
const OUTPUT_DISK_BYTES = 67_108_864;
const SYSTEM_DISK_VIRTUAL_BYTES = 51_539_607_552;
const GUEST_RESULT_NAME = "result.json";
const BASELINE_RESULT_NAME = "baseline-result.json";
const CPUID_LEAF1_ECX = "0x00900000";
const CONTROL_RESULTS = Object.freeze({"known-good": 42, "known-bad": 13, sse42: 2_276_049_685, popcnt: 32});
const KNOWN_BAD_EXIT = 19;
const ILLEGAL_INSTRUCTION_EXIT = 3_221_225_501;
const NON_PROBE_GUEST_FILES = Object.freeze(["node.exe", "request.json", "execution.json", "fixture-bundle.json",
    "guest-runtime.json", "runtime-installer.ps1"]);
const ROOT_OWNERSHIP = Object.freeze({uid: "0", gid: "0", mode: "555", ordinaryUserWritable: false});

const digest = bytes => crypto.createHash("sha256").update(bytes).digest("hex");

describe("Stage 3 probe seed naming contract", () => {
    it("declares one explicit artifact and seed name per role", () => {
        assert.deepEqual(PROBE_SEED_FILES.map(entry => [entry.role, entry.artifactName, entry.seedName]), [
            ["avx", "avx.exe", "avx.exe"],
            ["avx2", "avx2.exe", "avx2.exe"],
            ["cpuid", "cpuid.exe", "cpuid.exe"],
            ["illegal", "illegal.exe", "illegal.exe"],
            ["known-bad", "known_bad.exe", "known-bad.exe"],
            ["known-good", "known_good.exe", "known-good.exe"],
            ["popcnt", "popcnt.exe", "popcnt.exe"],
            ["sse42", "sse42.exe", "sse42.exe"]
        ]);
        assert.ok(Object.isFrozen(PROBE_SEED_FILES));
        assert.ok(PROBE_SEED_FILES.every(entry => Object.isFrozen(entry)));
    });

    it("gives every role the seed name the collector computes for it", () => {
        // renderGuestBootstrap opens `Join-Path $Seed ($role + '.exe')`, so this is the lookup the
        // guest actually performs rather than a literal filename list.
        for (const entry of PROBE_SEED_FILES) assert.equal(entry.seedName, `${entry.role}.exe`);
    });

    it("cannot drift from the release artifact names the host actually downloads", () => {
        assert.deepEqual(POST_RELEASE_CPU_FLOOR_GUEST_PREPARATION_CONSTANTS.PROBES.map(([role, name]) => [role, name]),
            PROBE_SEED_FILES.map(entry => [entry.role, entry.artifactName]));
    });
});

/**
 * An inert Stage 3 execution over the real chain: the real release request builder, the real
 * Stage 3 runner, the real hosted Stage 3 and Stage 2 adapters, the real seed producer, the real
 * generated bootstrap contract, the real QEMU argument builder, the real hosted launch and guest
 * parser, and the real post-release consumer.
 *
 * Only the lowest seams are doubled: the filesystem, the owned-process spawns and the QEMU monitor.
 * No QEMU, VM, MSI, service or network is involved. Where a Windows guest would run, this harness
 * simulates it *from the materialised seed*, so a file the guest would open but the seed does not
 * carry fails here rather than natively. Everything the simulated guest does is named as such.
 */
async function runInertStage3({mutateLaunchArgv = argv => argv, renameSeedEntry = name => name,
    mutateGuestEnvelope = envelope => envelope, installerConfirmation = "no-input",
    elapsedMilliseconds = 0, qmpInputSent = false} = {}) {
    const target = bindV161PostReleaseTarget(targetInput());
    const acquiredBinding = acquireV161PostReleaseCpuFloorBaselineSummary(
        createV161PostReleaseCpuFloorBinding({target, manifestBytes: manifestBytes(),
            hostedContext: hostedContext()}), acquisitionInput());
    // The run's own declared plan, carried by the real builder rather than patched into the request.
    const plan = stage3ExecutionPlan({installerConfirmation});
    const projection = buildV161PostReleaseCpuFloorStage3Request(acquiredBinding,
        placeholderStage2Receipts(), plan);
    // Real Stage 2 evidence for this same execution, produced by the shared Stage 3 fixture.
    const stage2Fixture = await buildPostReleaseStage3Fixture(projection.candidate, plan);
    const built = buildV161PostReleaseCpuFloorStage3Request(acquiredBinding, stage2Fixture.request.stage2, plan);
    const request = structuredClone(built);
    const launchedAt = plan.wallDeadlineUnixMilliseconds - 80 * 60_000 + elapsedMilliseconds;
    const context = request.context;
    const root = request.paths.root;
    const candidateRoot = `${root}/candidate`;
    const stage2 = JSON.parse(stage2Fixture.retainedStage2Bytes.toString("utf8"));
    const toolchain = stage2.toolchain;
    const portableRoot = `/tmp/myspeed-windows-cpu-floor-tools-${context.nonce}`;

    // ---- in-memory filesystem -------------------------------------------------------------
    const files = new Map();
    const archives = new Map();
    const outputDisk = new Map();
    const put = (target_, content) => files.set(target_,
        {content, bytes: String(content.length), sha256: digest(content)});
    const putSized = (target_, bytes) => files.set(target_,
        {content: null, bytes: String(bytes), sha256: digest(Buffer.from(`sized:${target_}:${bytes}`))});
    const declared = new Map();
    const declare = record => { declared.set(record.path, record); return record; };
    for (const tool of [toolchain.runtime.loader, toolchain.qemu, toolchain.qemuImg, toolchain.genisoimage,
        toolchain.mcopy, toolchain.mformat, toolchain.sevenZip, toolchain.wiminfo, toolchain.ovmfCode,
        toolchain.ovmfVarsTemplate, toolchain.firmware.kvmvapic, toolchain.firmware.vga]) declare(tool);
    for (const launcher of ["/usr/bin/sudo", "/usr/bin/timeout", "/usr/bin/kill", "/usr/bin/readlink"])
        declare({path: launcher, bytes: "4096", sha256: SHA("e"), ownership: ROOT_OWNERSHIP});

    const guestFiles = [...NON_PROBE_GUEST_FILES, ...PROBE_SEED_FILES.map(entry => entry.artifactName)]
        .map(name => {
            const content = Buffer.from(`inert-guest-file:${name}`);
            put(`${candidateRoot}/${name}`, content);
            return {name, path: `${candidateRoot}/${name}`, bytes: String(content.length), sha256: digest(content)};
        });
    for (const [record, name] of [[request.candidate.file, "MySpeed.exe"],
        [request.candidate.qualificationSummary, "qualification-summary.json"],
        [request.candidate.manifest, "qualification-manifest.json"]])
        declare({path: `${candidateRoot}/${name}`, bytes: record.bytes, sha256: record.sha256,
            ownership: ROOT_OWNERSHIP});

    const inspectOwned = target_ => {
        if (declared.has(target_)) return {...declared.get(target_), ownership: ROOT_OWNERSHIP};
        const record = files.get(target_);
        if (!record) throw new Error(`inert host has no file at ${target_}`);
        return {path: target_, bytes: record.bytes, sha256: record.sha256, ownership: ROOT_OWNERSHIP};
    };

    // ---- simulated guest ------------------------------------------------------------------
    const seedRoot = `${root}/seed-files`;
    const readSeed = name => {
        const record = files.get(`${seedRoot}/${name}`);
        if (!record?.content) throw new Error(`the seed does not carry ${name}`);
        return record.content;
    };
    /* Everything below is a JS simulation of what the Windows guest would do, not a real guest. */
    const simulateGuest = () => {
        for (const entry of PROBE_SEED_FILES) readSeed(entry.seedName);
        for (const name of NON_PROBE_GUEST_FILES) readSeed(name);
        readSeed("cpu-calibration.ps1");
        readSeed("baseline-bootstrap.ps1");
        readSeed("install-activation.ps1");
        readSeed("myspeed-baseline-cpu-handoff.json");
        // The collector hashes the two files the specialize-pass installer copied out of the seed.
        const activationFiles = {};
        for (const [key, name] of [["setupComplete", "SetupComplete.cmd"],
            ["dispatcher", "myspeed-msi-setupcomplete.ps1"]]) {
            const bytes = readSeed(name);
            activationFiles[key] = {path: `C:\\Windows\\Setup\\Scripts\\${name}`, bytes: bytes.length,
                sha256: digest(bytes)};
        }
        const startupTask = getCompletedWindowsMsiActivationEvidence(buildWindowsMsiSetupCompleteActivation({
            repository: context.repository, sourceSha: context.sourceSha, eventSha: context.eventSha,
            runId: context.runId, runAttempt: context.runAttempt, nonce: context.nonce})).startupTask;
        const cpuid = {schemaVersion: 1, kind: "cpuid", maxBasicLeaf: 7,
            leaf1: {eax: "0x00000000", ebx: "0x00000000", ecx: CPUID_LEAF1_ECX, edx: "0x00000000"},
            leaf7Subleaf0: {eax: "0x00000000", ebx: "0x00000000", ecx: "0x00000000", edx: "0x00000000"},
            xcr0: null, features: {sse42: true, popcnt: true, osxsave: false, avx: false, avx2: false}};
        const envelope = mutateGuestEnvelope({schemaVersion: 1, nonce: context.nonce, runs: [
            {role: "cpuid", exitCode: 0, stdoutBase64: Buffer.from(`${JSON.stringify(cpuid)}\n`).toString("base64"),
                stderrBase64: ""},
            ...Object.entries(CONTROL_RESULTS).map(([role, result]) => ({role,
                exitCode: role === "known-bad" ? KNOWN_BAD_EXIT : 0,
                stdoutBase64: Buffer.from(`${JSON.stringify({schemaVersion: 1, kind: role, result})}\n`)
                    .toString("base64"), stderrBase64: ""})),
            ...["illegal", "avx", "avx2"].map(role => ({role, exitCode: ILLEGAL_INSTRUCTION_EXIT,
                stdoutBase64: "", stderrBase64: ""}))],
        network: {hardwareNics: 0, enabledNonLoopbackInterfaces: 0, nonLoopbackRoutes: 0},
        activation: {state: "windows-setup-complete-startup-dispatch-ready", setupCompleted: true,
            startupTaskInstalled: true, nativeMsiExecutionStarted: false, files: activationFiles, startupTask},
        systemTools: WINDOWS_SYSTEM_TOOL_PATHS.map((tool, index) => ({role: tool.role, path: tool.path,
            bytes: String(index + 1), sha256: SHA(String((index + 1) % 10))}))});
        outputDisk.set(GUEST_RESULT_NAME, Buffer.from(JSON.stringify(envelope), "utf8"));
        outputDisk.set(BASELINE_RESULT_NAME, Buffer.from(JSON.stringify(
            stage2Fixture.completedResult.guestEvidence.result), "utf8"));
        return {cpuid, activationFiles};
    };

    // ---- doubled owned processes ----------------------------------------------------------
    const succeeded = {process: {exitCode: 0, signal: null, timedOut: false, cleanupProven: true,
        errorObserved: false, stdoutOverflow: false, stderrOverflow: false}};
    const observed = {launchArgv: null, seedNames: null, guest: null, screenshots: []};
    const runOwned = async (command, argv) => {
        assert.equal(command, toolchain.runtime.loader.path);
        const tool = argv[4];
        const rest = argv.slice(5);
        if (tool === toolchain.genisoimage.path) {
            const isoPath = rest[rest.indexOf("-o") + 1];
            const sourceRoot = rest.at(-1);
            const members = new Map();
            for (const [name, record] of files)
                if (name.startsWith(`${sourceRoot}/`)) members.set(name.slice(sourceRoot.length + 1), record);
            archives.set(isoPath, members);
            observed.seedNames = [...members.keys()].sort();
            putSized(isoPath, 1_048_576);
            return {...succeeded, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0)};
        }
        if (tool === toolchain.sevenZip.path) {
            const destination = rest.find(value => value.startsWith("-o")).slice(2);
            for (const [name, record] of archives.get(rest.at(-1))) files.set(`${destination}/${name}`, record);
            return {...succeeded, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0)};
        }
        // mformat and mcopy share one mtools binary, so dispatch on the invocation, not the path.
        if (tool === toolchain.mcopy.path && rest.some(value => value.startsWith("::") && value.length > 2)) {
            const member = rest.find(value => value.startsWith("::")).slice("::".length);
            const bytes = outputDisk.get(member);
            if (!bytes) throw new Error(`the guest published no ${member}`);
            put(rest.at(-1), bytes);
            return {...succeeded, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0)};
        }
        if (tool === toolchain.mformat.path) return {...succeeded, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0)};
        if (tool === toolchain.qemuImg.path) {
            if (rest[0] === "create") { putSized(rest[3], 8_388_608); return {...succeeded,
                stdout: Buffer.alloc(0), stderr: Buffer.alloc(0)}; }
            return {...succeeded, stdout: Buffer.from(JSON.stringify({format: "qcow2",
                "virtual-size": SYSTEM_DISK_VIRTUAL_BYTES})), stderr: Buffer.alloc(0)};
        }
        throw new Error(`inert host received an unexpected owned invocation: ${tool}`);
    };

    /*
     * The spawn double never ignores the vector it is handed. A QEMU that was not told to speak QMP
     * on stdio cannot complete the session the launcher always opens, so the double reports the same
     * qmp-failed termination the real launcher would rather than inventing a successful record.
     */
    const runMonitoredQemu = async monitorRequest => {
        const argv = mutateLaunchArgv([...monitorRequest.argv]);
        observed.launchArgv = argv;
        const process_ = {exitCode: 0, signal: null, timedOut: false, cleanupProven: true,
            errorObserved: false, stdoutOverflow: false, stderrOverflow: false};
        const identity = {pid: 4242, startTicks: "987654", processGroupId: 4242,
            executablePath: toolchain.runtime.loader.path};
        const speaksQmp = argv.some((value, index) => value === "-qmp" && argv[index + 1] === "stdio");
        if (!speaksQmp) return {observation: {process: process_, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0)},
            identity, absentAfter: true, processGroupGone: true, terminationReason: "qmp-failed", qmp: null};
        observed.guest = simulateGuest();
        /* The transport is doubled, not the authority: the paths the launcher chose still pass the
         * real shared validator before any frame is written. */
        for (const screenshot of validateScreenshots(monitorRequest.qmp.screenshotPaths)) {
            put(screenshot, PNG); observed.screenshots.push(screenshot);
        }
        return {observation: {process: process_, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0)}, identity,
            absentAfter: true, processGroupGone: true, terminationReason: null,
            qmp: {version: {major: 8, minor: 2, micro: 2}, status: "running", running: true,
                screenshotPaths: monitorRequest.qmp.screenshotPaths, inputSent: qmpInputSent}};
    };

    const native = {
        monotonicMilliseconds: () => 1_000,
        mkdirExclusive: () => undefined,
        writeExclusive: (target_, bytes) => put(target_.startsWith(`${seedRoot}/`) ?
            `${seedRoot}/${renameSeedEntry(target_.slice(seedRoot.length + 1))}` : target_, bytes),
        /* A copy keeps the source's identity, including for the two release artifacts whose real
         * bytes this inert host never has. */
        copyExclusive: (source, target_) => {
            const destination = target_.startsWith(`${seedRoot}/`) ?
                `${seedRoot}/${renameSeedEntry(target_.slice(seedRoot.length + 1))}` : target_;
            if (files.has(source)) { files.set(destination, files.get(source)); return; }
            const record = declared.get(source);
            if (!record) throw new Error(`inert host cannot copy ${source}`);
            declare({...record, path: destination});
            files.set(destination, {content: Buffer.from(`inert-release-artifact:${source}`),
                bytes: record.bytes, sha256: record.sha256});
        },
        makeSizedFile: (target_, bytes) => putSized(target_, Number(bytes)),
        removeOwned: target_ => files.delete(target_),
        pathExists: target_ => files.has(target_),
        inspectOwned,
        inspectDirectory: target_ => target_ === "/tmp" ?
            {path: "/tmp", uid: "0", gid: "0", mode: "1777", sticky: true, ordinaryUserWritable: true} :
            {path: target_, uid: "0", gid: "0", mode: "755", sticky: false, ordinaryUserWritable: false},
        readOwnedVerified: target_ => {
            const record = files.get(target_);
            if (!record?.content) throw new Error(`inert host cannot read ${target_}`);
            return {identity: {path: target_, bytes: record.bytes, sha256: record.sha256}, bytes: record.content};
        },
        validateOutputDisk: target_ => ({path: target_, bytes: String(OUTPUT_DISK_BYTES),
            sha256: files.get(target_)?.sha256 ?? SHA("0")}),
        runOwned, runMonitoredQemu
    };

    const operations = createHostedStage3Operations({context, paths: request.paths, guestFiles, dependencies: {
        deriveActualContext: () => structuredClone(context),
        unixMilliseconds: () => launchedAt,
        inspectFile: target_ => inspectOwned(target_),
        readJson: target_ => {
            if (target_ === request.stage2.result.path)
                return {identity: structuredClone(request.stage2.result),
                    bytesBase64: stage2Fixture.retainedStage2Bytes.toString("base64"), value: stage2};
            if (target_ === request.stage2.guestResult.path)
                return {identity: structuredClone(request.stage2.guestResult),
                    bytesBase64: stage2Fixture.retainedStage2GuestBytes.toString("base64"),
                    value: JSON.parse(stage2Fixture.retainedStage2GuestBytes.toString("utf8"))};
            const record = files.get(target_);
            if (!record?.content) throw new Error(`inert host cannot read JSON at ${target_}`);
            return {identity: {path: target_, bytes: record.bytes, sha256: record.sha256},
                bytesBase64: record.content.toString("base64"),
                value: JSON.parse(record.content.toString("utf8"))};
        },
        pathExists: target_ => files.has(target_),
        runOwned, native
    }});

    // The seed the real producer builds is only materialised once prepareBaselineMedia runs, so a
    // seed mutation has to be applied through the write seam rather than before the run.
    const result = await runWindowsCpuFloorStage3(request, operations);
    return {acquiredBinding, request, result, observed, portableRoot,
        retainedStage2Bytes: stage2Fixture.retainedStage2Bytes};
}

describe("Stage 3 inert native execution contract", () => {
    it("carries the real release request through the real chain into the real consumer", async () => {
        const run = await runInertStage3();
        assert.equal(run.result.status, "observed", run.result.failure);

        // The vector the launcher was actually handed.
        const argv = run.observed.launchArgv;
        assert.equal(argv.includes("-boot"), false);
        assert.ok(argv.some((value, index) => value === "-qmp" && argv[index + 1] === "stdio"));
        assert.ok(argv.includes("ide-hd,drive=osdisk,bus=sata.1,bootindex=0"));
        assert.ok(argv.includes("ide-cd,drive=install,bus=sata.2,bootindex=1"));
        assert.ok(argv.includes("usb-kbd,bus=usb0.0"));
        assert.ok(argv.includes("-L") && argv.includes(`${run.portableRoot}/usr/share/qemu`));

        // The seed the real producer built, as materialised for the ISO.
        assert.ok(run.observed.seedNames.includes("known-bad.exe"));
        assert.ok(run.observed.seedNames.includes("known-good.exe"));
        assert.equal(run.observed.seedNames.includes("known_bad.exe"), false);
        assert.ok(run.observed.seedNames.includes("baseline-bootstrap.ps1"));
        assert.ok(run.observed.seedNames.includes("install-activation.ps1"));
        assert.ok(run.observed.seedNames.includes("myspeed-baseline-cpu-handoff.json"));
        assert.equal(run.observed.seedNames.includes("bootstrap.ps1"), false);

        // The activation the simulated guest observed is the activation the seed installs.
        const expected = getCompletedWindowsMsiActivationEvidence(buildWindowsMsiSetupCompleteActivation({
            repository: run.request.context.repository, sourceSha: run.request.context.sourceSha,
            eventSha: run.request.context.eventSha, runId: run.request.context.runId,
            runAttempt: run.request.context.runAttempt, nonce: run.request.context.nonce}));
        assert.deepEqual(run.observed.guest.activationFiles, expected.files);

        // Early-boot evidence is bound to the Stage 3 root and denies input by statement.
        assert.deepEqual(run.result.earlyBoot.screenshots.map(value => value.path), run.observed.screenshots);
        assert.deepEqual(run.observed.screenshots, [`${run.request.paths.root}/early-boot-1.png`,
            `${run.request.paths.root}/early-boot-2.png`]);
        assert.equal(run.result.earlyBoot.inputSent, false);

        assert.equal(validateCompletedStage3Result(run.result, run.request, run.retainedStage2Bytes).accepted, true);
        const inspection = inspectV161PostReleaseCpuFloorEvidence({binding: run.acquiredBinding,
            request: run.request, result: run.result, retainedStage2Bytes: run.retainedStage2Bytes});
        assert.equal(inspection.accepted, true);
        assert.equal(inspection.qualifying, false);
        assert.equal(inspection.releaseGateCleared, false);
    });

    it("fails closed when the launcher is handed a vector that cannot speak QMP", async () => {
        const run = await runInertStage3({mutateLaunchArgv: argv =>
            argv.filter((value, index) => value !== "-qmp" && argv[index - 1] !== "-qmp")});
        assert.equal(run.result.status, "failed");
        assert.equal(run.result.stage, "qemu-launch");
        assert.match(run.result.failure, /envelope|early-boot|cleanup/u);
    });

    it("fails closed when the seed carries the release spelling the guest cannot open", async () => {
        const run = await runInertStage3({renameSeedEntry: name =>
            name === "known-bad.exe" ? "known_bad.exe" : name});
        assert.equal(run.result.status, "failed");
        assert.equal(run.result.stage, "media");
    });

    it("fails closed when the published envelope omits the post-setup observations", async () => {
        for (const field of ["activation", "systemTools"]) {
            const run = await runInertStage3({mutateGuestEnvelope: envelope => {
                const reduced = {...envelope};
                delete reduced[field];
                return reduced;
            }});
            assert.equal(run.result.status, "failed", field);
            assert.equal(run.result.stage, "qemu-launch");
        }
    });

    it("refuses an unauthorized installer keypress and admits an explicitly bound one", async () => {
        const confirmation = {kind: "installer-boot-confirmation", qcode: "ret", holdMilliseconds: 100,
            requestedOffsetMilliseconds: 2_000, sentOffsetMilliseconds: 2_100, acknowledged: true};
        const refused = await runInertStage3({qmpInputSent: confirmation});
        assert.equal(refused.result.status, "failed");
        const admitted = await runInertStage3({qmpInputSent: confirmation,
            installerConfirmation: INSTALLER_BOOT_CONFIRMATION});
        assert.equal(admitted.result.status, "observed", admitted.result.failure);
        assert.deepEqual(admitted.result.earlyBoot.inputSent, confirmation);
    });

    it("bounds the real launcher invocation by the declared budget, not the generic allowance", async () => {
        const run = await runInertStage3();
        assert.equal(run.result.status, "observed", run.result.failure);
        const bound = run.observed.launchArgv[run.observed.launchArgv.indexOf("--signal=KILL") + 1];
        assert.equal(bound, `${run.result.reservation.executionMilliseconds / 1_000}s`);
        assert.equal(bound, "3300s");
        assert.equal(run.observed.launchArgv.includes("16200s"), false);
        assert.deepEqual(run.result.reservation, {label: "cpu-floor-stage3-baseline",
            executionMilliseconds: 55 * 60_000, cleanupMilliseconds: 2 * 60_000});

        // Time already spent above comes off the bound rather than being handed back.
        const late = await runInertStage3({elapsedMilliseconds: 40 * 60_000});
        assert.equal(late.result.status, "observed", late.result.failure);
        assert.equal(late.result.reservation.executionMilliseconds, 36 * 60_000);
        assert.equal(late.observed.launchArgv[late.observed.launchArgv.indexOf("--signal=KILL") + 1], "2160s");
    });

    it("refuses to start a guest when the declared deadline can no longer hold one", async () => {
        const run = await runInertStage3({elapsedMilliseconds: 66 * 60_000});
        assert.equal(run.result.status, "failed");
        assert.equal(run.result.stage, "qemu-launch");
        assert.match(run.result.failure, /Stage 3 execution budget/u);
        assert.equal(run.observed.launchArgv, null);
    });
});
