import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {describe, it} from "node:test";

import {createWindowsMsiPrerequisiteEvidenceFixture} from
    "../helpers/windows-msi-prerequisite-evidence-fixture.mjs";
import {createWindowsMsiGuestLifecycleEvidenceFixture, WINDOWS_MSI_GUEST_EVIDENCE_DEFAULT_IDENTITY} from
    "../helpers/windows-msi-guest-lifecycle-evidence-fixture.mjs";
import {inspectCompletedWindowsMsiGuestMatrixEvidence} from
    "../../scripts/qualification/windows-msi-guest-lifecycle-evidence.mjs";
import {buildWindowsMsiGuestSeedDocuments} from "../../scripts/qualification/windows-msi-guest-seed-documents.mjs";
import {createWindowsMsiLifecycleCandidateProvenanceFixture, createWindowsMsiLifecycleHostEvidenceFixture} from
    "../helpers/linux-windows-msi-lifecycle-host-fixture.mjs";
import {buildWindowsMsiLifecycleQemuArguments, createWindowsMsiLifecycleHostOperations,
    runWindowsMsiLifecycleHost,
    validateCompletedWindowsMsiLifecycleHostResult, validateWindowsMsiLifecycleHostRequest,
    WINDOWS_MSI_LIFECYCLE_OUTPUT_DISK_BYTES, WindowsMsiLifecycleRunError} from
    "../../scripts/qualification/linux-windows-msi-lifecycle-host.mjs";

const HASH = "a".repeat(64);
const HOST_ROOT = "/opt/myspeed/windows-msi";
const ROW_MILLISECONDS = 16_200_000;
const MINUTE = 60_000;
const MAX_PROGRESS_BYTES = 65_536;
const JOB_BUDGET = {jobBudgetMilliseconds: 300 * MINUTE, rowAllowanceMilliseconds: 15 * MINUTE,
    rowCleanupMarginMilliseconds: 2 * MINUTE, finalMarginMilliseconds: 10 * MINUTE};
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
const PNG_BYTES = Buffer.from("89504e470d0a1a0a", "hex");
const identity = (path, bytes = "4096", hash = HASH) => ({path, bytes, sha256: hash});
const ownedIdentity = (path, bytes = "4096", hash = HASH) => ({...identity(path, bytes, hash),
    ownership: {uid: "0", gid: "0", mode: "444", ordinaryUserWritable: false}});
const earlyBoot = rowRoot => ({schemaVersion: 1, kind: "qemu-early-boot-observation", inputSent: false,
    version: {major: 9, minor: 2, micro: 1}, status: "running", running: true,
    screenshots: [1, 2].map(index => ({path: `${rowRoot}/early-boot-${index}.png`,
        bytes: String(PNG_BYTES.length), sha256: sha256(PNG_BYTES), bytesBase64: PNG_BYTES.toString("base64")}))});

const createHostFixture = async () => {
    const toolchain = Object.fromEntries(["runtimeLoader", "qemu", "qemuImg", "genisoimage", "mformat",
        "mcopy", "ovmfCode", "ovmfVarsTemplate"].map((name, index) => [name,
        ownedIdentity(`/opt/myspeed/tools/${name}`, String(4096 + index),
            String(index + 1).repeat(64).slice(0, 64))]));
    toolchain.portableRoot = "/opt/myspeed/tools";
    toolchain.libraryPath = ["/opt/myspeed/tools/lib"];
    toolchain.firmware = {searchPath: "/opt/myspeed/tools/usr/share/qemu",
        kvmvapic: ownedIdentity("/opt/myspeed/tools/usr/share/qemu/kvmvapic.bin", "4096", "8".repeat(64)),
        vga: ownedIdentity("/opt/myspeed/tools/usr/share/seabios/vgabios-stdvga.bin", "8192", "9".repeat(64))};
    const nonce = "9".repeat(32);
    const taskRoot = `${HOST_ROOT}/myspeed-windows-msi-${nonce}`;
    /*
     * The guest evidence fixture's own default identity. The prerequisite records are provenance-
     * bound to it, and the digests they yield are what the rows then carry, so both fixtures have
     * to agree on the execution context before either is built.
     */
    const executionContext = {...WINDOWS_MSI_GUEST_EVIDENCE_DEFAULT_IDENTITY, nonce};
    const prerequisites = createWindowsMsiPrerequisiteEvidenceFixture({context: executionContext});
    const buildRows = guest => guest.evidence.rows.map((guestRow, scenarioIndex) => {
        const rowRequestValue = JSON.parse(Buffer.from(guestRow.rowRequest.bytesBase64, "base64"));
        const rowNonce = rowRequestValue.nonce;
        const rowRoot = `${taskRoot}/row-${String(scenarioIndex).padStart(2, "0")}-${rowNonce}`;
        const seedRoot = `${rowRoot}/seed`;
        const executionValue = JSON.parse(Buffer.from(guestRow.executionManifest.bytesBase64, "base64"));
        const documents = buildWindowsMsiGuestSeedDocuments({rowRequest: rowRequestValue,
            executionManifest: executionValue, matrixRunner: {
                path: `${executionValue.seedRoot}\\windows-msi-guest-matrix-executor.mjs`,
                bytes: 14_000, sha256: "d".repeat(64)}, launcher: {
                path: `${executionValue.seedRoot}\\media-job-launcher.ps1`,
                bytes: 32_000, sha256: "e".repeat(64)}, observerSha256: "f".repeat(64),
            wallDeadlineUnixMilliseconds: 2_000_000_000_000});
        const retainedDocument = (name, document) => ({path: `${seedRoot}/${name}`, bytes: document.bytes,
            sha256: document.sha256, bytesBase64: document.bytesBase64});
        return {scenarioIndex, scenarioId: guestRow.scenarioId, nonce: rowNonce, rowRoot,
            overlayPath: `${rowRoot}/system-overlay.qcow2`, seedRoot, seedIsoPath: `${rowRoot}/seed.iso`,
            outputDiskPath: `${rowRoot}/output.img`, guestResultPath: `${rowRoot}/guest-result.json`,
            serialLogPath: `${rowRoot}/serial.log`, pidPath: `${rowRoot}/qemu.pid`,
            ovmfVarsPath: `${rowRoot}/OVMF_VARS.fd`,
            rowRequest: retainedDocument("row-request.json", documents.rowRequest),
            executionManifest: retainedDocument("execution-manifest.json", documents.executionManifest),
            guestEnvelope: retainedDocument("matrix-envelope.json", documents.envelope),
            launcherRequest: retainedDocument("launch-request.json", documents.launcherRequest),
            seedFiles: [{name: "node.exe", sourcePath: "/opt/myspeed/closure/node.exe",
                bytes: "85268464", sha256: "b".repeat(64)},
            {name: "windows-msi-guest-matrix-executor.mjs", sourcePath: "/opt/myspeed/closure/matrix.mjs",
                bytes: "14000", sha256: "d".repeat(64)},
            {name: "media-job-launcher.ps1", sourcePath: "/opt/myspeed/closure/launcher.ps1",
                bytes: "32000", sha256: "e".repeat(64)},
            {name: "windows-msi-guest-runner.ps1", sourcePath: "/opt/myspeed/closure/runner.ps1",
                bytes: "19000", sha256: "1".repeat(64)}]};
    });
    const buildRequest = (guest, rows) => ({schemaVersion: 1,
        kind: "myspeed-windows-msi-lifecycle-host-request", qualifying: false,
        context: {schemaVersion: 1, repository: "i7Gamer/MySpeed", sourceSha: guest.expected.sourceSha,
            eventSha: guest.expected.eventSha, runId: guest.expected.runId,
            runAttempt: guest.expected.runAttempt, nonce, environment: {GITHUB_ACTIONS: "true", CI: "true",
                RUNNER_OS: "Linux", RUNNER_ARCH: "X64", RUNNER_ENVIRONMENT: "github-hosted",
                ImageOS: "ubuntu24", ImageVersion: "20260914.1"}}, privilegeMode: "reviewed-sudo-kvm",
        repository: "i7Gamer/MySpeed", sourceSha: guest.expected.sourceSha, eventSha: guest.expected.eventSha,
        runId: guest.expected.runId, runAttempt: guest.expected.runAttempt, nonce, taskRoot,
        expected: guest.expected, candidateProvenance: createWindowsMsiLifecycleCandidateProvenanceFixture(guest),
        prerequisiteEvidence: {rollbackCalibration: prerequisites.rollbackCalibration,
            oldContainment: prerequisites.oldContainment},
        toolchain, toolchainSha256: sha256(Buffer.from(JSON.stringify(toolchain))),
        baseImage: ownedIdentity("/opt/myspeed/base/windows-modern.qcow2", "53687091200",
            guest.expected.baseImageSha256), rows,
        limits: {outputDiskBytes: WINDOWS_MSI_LIFECYCLE_OUTPUT_DISK_BYTES, rowMilliseconds: ROW_MILLISECONDS,
            budget: {...JOB_BUDGET}}});
    const guestSettings = {rollbackCalibrationSha256: prerequisites.rollbackCalibrationSha256,
        oldContainmentSha256: prerequisites.oldContainmentSha256};
    const firstGuest = await createWindowsMsiGuestLifecycleEvidenceFixture(guestSettings);
    const firstRows = buildRows(firstGuest);
    const firstRequest = buildRequest(firstGuest, firstRows);
    const overlayReceiptSha256ByScenario = firstRows.map(row => sha256(Buffer.from(row.nonce)));
    const qemuLaunchSha256ByScenario = firstRows.map(row => {
        const overlay = {path: row.overlayPath, format: "qcow2",
            backingBaseSha256: firstRequest.baseImage.sha256, createNew: true,
            receiptSha256: overlayReceiptSha256ByScenario[row.scenarioIndex]};
        const media = {seed: {path: row.seedIsoPath, bytes: "1048576", sha256: "c".repeat(64),
            manifestSha256: firstGuest.expected.closureSha256, readOnly: true, volumeLabel: "MYSPEEDSEED"},
        outputBefore: {path: row.outputDiskPath, bytes: String(WINDOWS_MSI_LIFECYCLE_OUTPUT_DISK_BYTES),
            sha256: "e".repeat(64), createNew: true, volumeLabel: "MYSPEEDOUT"},
        ovmfVarsSha256: firstRequest.toolchain.ovmfVarsTemplate.sha256};
        const argv = buildWindowsMsiLifecycleQemuArguments({request: firstRequest, row, overlay, media});
        return sha256(Buffer.from(JSON.stringify(argv)));
    });
    const guest = await createWindowsMsiGuestLifecycleEvidenceFixture({...guestSettings,
        overlayReceiptSha256ByScenario, qemuLaunchSha256ByScenario});
    const rows = buildRows(guest);
    const request = buildRequest(guest, rows);
    const calls = [];
    const operations = {
        inspectBase: async ({phase}) => { calls.push(`base:${phase}`); return {...request.baseImage,
            format: "qcow2", virtualBytes: "68719476736", sealedReadOnly: true}; },
        createOverlay: async ({row}) => { calls.push(`overlay:${row.scenarioIndex}`); return {
            path: row.overlayPath, format: "qcow2", backingBaseSha256: request.baseImage.sha256,
            createNew: true, receiptSha256: sha256(Buffer.from(row.nonce))}; },
        prepareMedia: async ({row}) => { calls.push(`media:${row.scenarioIndex}`); return {
            seed: {path: row.seedIsoPath, bytes: "1048576", sha256: "c".repeat(64),
                manifestSha256: guest.expected.closureSha256, readOnly: true, volumeLabel: "MYSPEEDSEED"},
            outputBefore: {path: row.outputDiskPath,
                bytes: String(WINDOWS_MSI_LIFECYCLE_OUTPUT_DISK_BYTES), sha256: "e".repeat(64),
                createNew: true, volumeLabel: "MYSPEEDOUT"},
            ovmfVarsSha256: request.toolchain.ovmfVarsTemplate.sha256}; },
        launchRow: async ({row, overlay, media}) => { calls.push(`launch:${row.scenarioIndex}`);
            const argv = buildWindowsMsiLifecycleQemuArguments({request, row, overlay, media});
            return {argv, argvSha256: sha256(Buffer.from(JSON.stringify(argv))),
                loaderPath: request.toolchain.runtimeLoader.path,
                loaderSha256: request.toolchain.runtimeLoader.sha256,
                qemuPath: request.toolchain.qemu.path, qemuSha256: request.toolchain.qemu.sha256,
                pid: 2000 + row.scenarioIndex, startTicks: String(5000 + row.scenarioIndex),
                processGroupId: 2000 + row.scenarioIndex, exitCode: 0, signal: null, timedOut: false,
                terminationReason: null, cleanupProven: true, treeGone: true, earlyBoot: earlyBoot(row.rowRoot)}; },
        readGuestResult: async ({row}) => { calls.push(`read:${row.scenarioIndex}`); return {
            bytes: Buffer.from(guest.evidence.rows[row.scenarioIndex].semanticResult.bytesBase64, "base64"),
            outputAfter: identity(row.outputDiskPath, String(WINDOWS_MSI_LIFECYCLE_OUTPUT_DISK_BYTES),
                String(row.scenarioIndex + 1).repeat(64).slice(0, 64))}; },
        cleanupRow: async ({row, groupZero}) => { calls.push(`cleanup:${row.scenarioIndex}`); return {
            groupZeroBeforeRemoval: groupZero, removed: true}; }
    };
    return {guest, request, operations, calls, prerequisites, executionContext};
};

describe("NIC-free modern Windows MSI lifecycle host", () => {
    it("executes all fourteen fresh overlays and reads output only after QEMU group zero", async () => {
        const fixture = await createHostFixture();
        validateWindowsMsiLifecycleHostRequest(fixture.request);
        const result = await runWindowsMsiLifecycleHost(fixture.request, fixture.operations);
        assert.equal(result.status, "completed");
        assert.equal(result.qualifying, false);
        assert.equal(result.hostRows.length, 14);
        assert.equal(result.guestInspection.rows.length, 14);
        assert.deepEqual(result.releaseGatesCleared, []);
        assert.equal(fixture.calls[0], "base:before");
        assert.equal(fixture.calls.at(-1), "base:after");
        const argv = result.hostRows[0].qemu.argv;
        assert.deepEqual(argv.slice(argv.indexOf("-qmp"), argv.indexOf("-qmp") + 4),
            ["-qmp", "stdio", "-L", fixture.request.toolchain.firmware.searchPath]);
        assert.ok(argv.includes(`VGA,id=video0,romfile=${fixture.request.toolchain.firmware.vga.path}`));
        assert.ok(argv.includes("qemu-xhci,id=usb0"));
        assert.ok(argv.includes("usb-kbd,bus=usb0.0"));
        assert.equal(result.hostRows[0].qemu.earlyBoot.screenshots[0].path,
            `${fixture.request.rows[0].rowRoot}/early-boot-1.png`);
        for (let index = 0; index < 14; index += 1) {
            const ordered = ["overlay", "media", "launch", "read", "cleanup"]
                .map(name => fixture.calls.indexOf(`${name}:${index}`));
            assert.ok(ordered.every((position, operationIndex) => operationIndex === 0
                || position > ordered[operationIndex - 1]));
            const cpuIndex = result.hostRows[index].qemu.argv.indexOf("-cpu");
            assert.deepEqual(result.hostRows[index].qemu.argv.slice(cpuIndex, cpuIndex + 6),
                ["-cpu", "host", "-smp", "2,sockets=1,cores=2,threads=1", "-m", "6144M"]);
            assert.ok(result.hostRows[index].qemu.argv.includes("none"));
        }
    });

    it("accepts only the authenticated optional empty populated SQLite WAL", async () => {
        const fixture = await createHostFixture();
        const emptySha256 = sha256(Buffer.alloc(0));
        fixture.request.rows[0].seedFiles.push({name: "fixture/populated/data/storage.db-wal",
            sourcePath: "/opt/myspeed/appassets/files/baseline/fixture/populated/data/storage.db-wal",
            bytes: "0", sha256: emptySha256});
        assert.equal(validateWindowsMsiLifecycleHostRequest(fixture.request), fixture.request);
        for (const mutate of [
            file => { file.name = "fixture/populated/data/other"; },
            file => { file.sha256 = HASH; }
        ]) {
            const changed = structuredClone(fixture.request);
            const file = changed.rows[0].seedFiles.at(-1); mutate(file);
            assert.throws(() => validateWindowsMsiLifecycleHostRequest(changed), /seed|empty|WAL/i);
        }
    });

    it("binds the modern toolchain and rejects a forged or networked QEMU vector", async () => {
        for (const mutate of [
            fixture => { fixture.request.toolchain.qemu.ownership.ordinaryUserWritable = true;
                fixture.request.toolchainSha256 = sha256(Buffer.from(JSON.stringify(fixture.request.toolchain))); },
            fixture => { fixture.request.toolchain.portableRoot = "/opt/myspeed/foreign";
                fixture.request.toolchainSha256 = sha256(Buffer.from(JSON.stringify(fixture.request.toolchain))); },
            fixture => { fixture.request.toolchain.qemu.path += ",readonly=off";
                fixture.request.toolchainSha256 = sha256(Buffer.from(JSON.stringify(fixture.request.toolchain))); },
            fixture => { fixture.request.toolchain.firmware.vga.path = "/opt/myspeed/tools/usr/share/qemu/foreign.bin";
                fixture.request.toolchainSha256 = sha256(Buffer.from(JSON.stringify(fixture.request.toolchain))); },
            fixture => { fixture.request.context.sourceSha = "f".repeat(40); },
            fixture => { fixture.request.candidateProvenance.artifacts[0].msi.artifactId =
                fixture.request.candidateProvenance.preseal.artifactId; },
            fixture => { const original = fixture.operations.launchRow; fixture.operations.launchRow = async args => {
                const result = await original(args); result.argv = [...result.argv, "-net", "user"];
                result.argvSha256 = sha256(Buffer.from(JSON.stringify(result.argv))); return result; }; },
            fixture => { fixture.request.rows[1].nonce = fixture.request.rows[0].nonce; }
        ]) {
            const fixture = await createHostFixture();
            mutate(fixture);
            await assert.rejects(() => runWindowsMsiLifecycleHost(fixture.request, fixture.operations));
        }
    });

    /*
     * The guest proves it is the guest this run created by reading its own BIOS serial and comparing
     * it with the nonce the request named - the matrix boundary check and the containment helper both
     * do exactly that. Nothing was giving QEMU that serial, so the value the guest read could never
     * have matched the value it was checked against.
     */
    it("stamps the row nonce into SMBIOS so the guest reads the serial it is checked against", async () => {
        const {request} = await createHostFixture();
        const row = request.rows[0];
        const overlay = {path: row.overlayPath, format: "qcow2",
            backingBaseSha256: request.baseImage.sha256, createNew: true,
            receiptSha256: row.overlayReceiptSha256 ?? sha256(Buffer.from(row.nonce))};
        const media = {seed: {path: row.seedIsoPath, bytes: "1048576", sha256: "c".repeat(64),
            manifestSha256: request.expected.closureSha256, readOnly: true, volumeLabel: "MYSPEEDSEED"},
        outputBefore: {path: row.outputDiskPath,
            bytes: String(WINDOWS_MSI_LIFECYCLE_OUTPUT_DISK_BYTES), sha256: "e".repeat(64),
            createNew: true, volumeLabel: "MYSPEEDOUT"},
        ovmfVarsSha256: request.toolchain.ovmfVarsTemplate.sha256};
        const argv = buildWindowsMsiLifecycleQemuArguments({request, row, overlay, media});
        const index = argv.indexOf("-smbios");
        assert.notEqual(index, -1, "the vector names an SMBIOS table");
        assert.equal(argv[index + 1], `type=1,serial=${row.nonce}`);
        assert.equal(argv.filter(value => value === "-smbios").length, 1);
        /* It is the row's own nonce, not the host's, and it is what the row's guest request asks for. */
        assert.notEqual(row.nonce, request.nonce);
        assert.equal(argv.includes(`type=1,serial=${request.nonce}`), false);
        const guestRequest = JSON.parse(Buffer.from(row.rowRequest.bytesBase64, "base64").toString("utf8"));
        assert.equal(guestRequest.guest.serial, row.nonce);
    });

    it("replays the complete host and guest proof instead of trusting status", async () => {
        const mutations = [
            value => { const argv = [...value.hostRows[0].qemu.argv]; argv[11] = "Westmere-v2";
                value.hostRows[0].qemu.argv = argv; },
            value => { value.hostRows[0].qemu.cleanupProven = false; },
            value => { value.hostRows[0].qemu.earlyBoot.screenshots[0].path += ".foreign"; },
            value => { value.hostRows[0].media.outputAfter.sha256 = "f".repeat(64); },
            value => { value.hostRows[0].overlayCleanup.removed = false; },
            value => { value.hostRows[1].qemu.pid = value.hostRows[0].qemu.pid;
                value.hostRows[1].qemu.startTicks = value.hostRows[0].qemu.startTicks;
                value.hostRows[1].qemu.processGroupId = value.hostRows[0].qemu.processGroupId; },
            value => { value.guestEvidence.rows[0].semanticResult.bytesBase64 += "AA=="; },
            value => { value.candidateProvenance.preseal.artifactId = "999"; },
            value => { value.releaseGatesCleared.push("msiLifecycle"); }
        ];
        for (const mutate of mutations) {
            const fixture = await createHostFixture();
            const result = await runWindowsMsiLifecycleHost(fixture.request, fixture.operations);
            mutate(result);
            assert.throws(() => validateCompletedWindowsMsiLifecycleHostResult(result, fixture.request));
        }
        const fixture = await createHostFixture();
        const result = await runWindowsMsiLifecycleHost(fixture.request, fixture.operations);
        const foreign = await createWindowsMsiGuestLifecycleEvidenceFixture({
            rollbackCalibrationSha256: fixture.prerequisites.rollbackCalibrationSha256,
            oldContainmentSha256: fixture.prerequisites.oldContainmentSha256,
            overlayReceiptSha256ByScenario: Array.from({length: 14}, (_, index) =>
                sha256(Buffer.from(`foreign-overlay-${index}`))),
            qemuLaunchSha256ByScenario: Array.from({length: 14}, (_, index) =>
                sha256(Buffer.from(`foreign-launch-${index}`)))});
        result.guestEvidence.rows[0] = foreign.evidence.rows[0];
        result.guestInspection = inspectCompletedWindowsMsiGuestMatrixEvidence(result.guestEvidence,
            fixture.request.expected);
        assert.throws(() => validateCompletedWindowsMsiLifecycleHostResult(result, fixture.request),
            /host.*guest|binding/i);
    });

    it("fails closed yet cleans the row on launch, output, or base-immutability failure", async () => {
        for (const change of ["launch", "output", "base"]) {
            const fixture = await createHostFixture();
            if (change === "launch") fixture.operations.launchRow = async () => { throw new Error("launch failed"); };
            if (change === "output") fixture.operations.readGuestResult = async () => {
                throw new Error("output failed"); };
            if (change === "base") { const original = fixture.operations.inspectBase;
                fixture.operations.inspectBase = async args => ({...await original(args),
                    ...(args.phase === "after" ? {sha256: "f".repeat(64)} : {})}); }
            await assert.rejects(() => runWindowsMsiLifecycleHost(fixture.request, fixture.operations));
            if (change !== "base") assert.ok(fixture.calls.includes("cleanup:0"));
        }
    });

    it("provides concrete owned-command and monitored-QEMU handlers without executing them locally", async () => {
        const fixture = await createHostFixture();
        const invocations = [];
        const inspected = new Map(Object.values(fixture.request.toolchain)
            .filter(value => value && !Array.isArray(value) && value.path).map(value => [value.path, value]));
        inspected.set(fixture.request.baseImage.path, fixture.request.baseImage);
        const process = {exitCode: 0, signal: null, timedOut: false, cleanupProven: true,
            errorObserved: false, stdoutOverflow: false, stderrOverflow: false};
        const operations = createWindowsMsiLifecycleHostOperations({request: fixture.request, dependencies: {
            deriveActualContext: () => structuredClone(fixture.request.context),
            inspectFile: async target => ({...inspected.get(target), mode: 0o444}),
            runOwned: async (command, argv) => { invocations.push({command, argv}); return {process,
                stdout: Buffer.from('{\n "format": "qcow2", "virtual-size": 68719476736\n}\n'),
                stderr: Buffer.alloc(0)}; },
            runQemu: async request => { invocations.push(request); return {process: {exitCode: 0, signal: null,
                timedOut: false, cleanupProven: true, treeGone: true, qemuPid: 42,
                qemuStartTicks: "123", processGroupId: 42, qemuPidAbsentAfter: true,
                launcherExecutablePath: fixture.request.toolchain.runtimeLoader.path, terminationReason: null},
            argv: request.argv, executionSucceeded: true, processFlags: {errorObserved: false,
                stdoutOverflow: false, stderrOverflow: false}}; }
        }});
        const base = await operations.inspectBase({phase: "before"});
        assert.equal(base.sealedReadOnly, true);
        assert.deepEqual(invocations[0].argv.slice(0, 4), ["--library-path",
            fixture.request.toolchain.libraryPath.join(":"), fixture.request.toolchain.qemuImg.path, "info"]);
        const row = fixture.request.rows[0];
        const overlay = await fixture.operations.createOverlay({row});
        const media = await fixture.operations.prepareMedia({row});
        const launch = await operations.launchRow({row, overlay, media});
        assert.equal(launch.treeGone, true);
        assert.equal(invocations[1].privilegeMode, "reviewed-sudo-kvm");
        assert.equal(invocations[1].toolchain.qemu.path, fixture.request.toolchain.qemu.path);
        assert.ok(invocations[1].argv.includes("none"));
        inspected.set(row.guestResultPath, identity(row.guestResultPath, "2", sha256(Buffer.from("{}"))));
        inspected.set(row.outputDiskPath, identity(row.outputDiskPath,
            String(WINDOWS_MSI_LIFECYCLE_OUTPUT_DISK_BYTES), "e".repeat(64)));
        const mismatchedReadOperations = createWindowsMsiLifecycleHostOperations({request: fixture.request,
            dependencies: {deriveActualContext: () => structuredClone(fixture.request.context),
                inspectFile: async target => ({...inspected.get(target), mode: 0o444}),
                filesystem: {readFileSync: () => Buffer.from("[]")}, runOwned: async () => ({process,
                    stdout: Buffer.alloc(0), stderr: Buffer.alloc(0)}), runQemu: async request => ({
                    process: {exitCode: 0, signal: null, timedOut: false, cleanupProven: true, treeGone: true,
                        qemuPid: 42, qemuStartTicks: "123", processGroupId: 42, qemuPidAbsentAfter: true,
                        launcherExecutablePath: fixture.request.toolchain.runtimeLoader.path,
                        terminationReason: null}, argv: request.argv, executionSucceeded: true,
                    processFlags: {errorObserved: false, stdoutOverflow: false, stderrOverflow: false}})}});
        await mismatchedReadOperations.launchRow({row, overlay, media});
        await assert.rejects(() => mismatchedReadOperations.readGuestResult({row}), /result read/i);
    });

    it("provides a complete replayable host fixture with caller-supplied final-manifest bindings", async () => {
        const sourceSha = "6".repeat(40); const eventSha = "7".repeat(40);
        const candidateArtifacts = {"candidate-default": {msi: {bytes: 51_445_760,
            sha256: "8".repeat(64)}, exe: {bytes: 85_000_001, sha256: "9".repeat(64)}},
        "candidate-baseline": {msi: {bytes: 51_101_696, sha256: "a".repeat(64)},
            exe: {bytes: 84_000_001, sha256: "b".repeat(64)}}};
        const fixture = await createWindowsMsiLifecycleHostEvidenceFixture({sourceSha, eventSha,
            runId: "654321", runAttempt: "3", candidateManifestSha256: "c".repeat(64), candidateArtifacts});
        assert.equal(fixture.request.sourceSha, sourceSha);
        assert.equal(fixture.request.eventSha, eventSha);
        assert.equal(fixture.result.hostRows.length, 14);
        assert.deepEqual(fixture.result.candidateProvenance, fixture.request.candidateProvenance);
        assert.equal(validateCompletedWindowsMsiLifecycleHostResult(fixture.result, fixture.request), fixture.result);
        const execution = JSON.parse(Buffer.from(fixture.request.rows[0].executionManifest.bytesBase64,
            "base64"));
        assert.deepEqual(execution.artifacts.slice(0, 2).map(item => ({bindingId: item.bindingId,
            bytes: item.bytes, sha256: item.sha256, exeBytes: item.exeBytes, exeSha256: item.exeSha256})),
        [{bindingId: "candidate-default", bytes: 51_445_760, sha256: "8".repeat(64),
            exeBytes: 85_000_001, exeSha256: "9".repeat(64)},
        {bindingId: "candidate-baseline", bytes: 51_101_696, sha256: "a".repeat(64),
            exeBytes: 84_000_001, exeSha256: "b".repeat(64)}]);
    });

    /*
     * The concrete cleanupRow reports `removed:false` for a row root it never created, and
     * `groupZeroBeforeRemoval:true` for an owned row that never reached a QEMU attempt. Both
     * disagree with the runner's `groupZero` flag on a prelaunch failure, so the contract
     * comparison used to throw in place of the overlay or media error that actually stopped
     * the row. The comparison is a successful-launch proof; it must never replace the cause.
     */
    it("preserves a prelaunch overlay or media failure through the cleanup group-zero comparison", async () => {
        const cases = [
            {stage: "createOverlay", cleanup: {groupZeroBeforeRemoval: false, removed: false}},
            {stage: "prepareMedia", cleanup: {groupZeroBeforeRemoval: true, removed: true}}
        ];
        for (const {stage, cleanup} of cases) {
            const fixture = await createHostFixture();
            const failure = new Error(`${stage} failed`);
            fixture.operations[stage] = async () => { throw failure; };
            fixture.operations.cleanupRow = async ({row}) => { fixture.calls.push(`cleanup:${row.scenarioIndex}`);
                return {...cleanup}; };
            const observed = await runWindowsMsiLifecycleHost(fixture.request, fixture.operations)
                .then(() => null, error => error);
            assert.ok(observed instanceof WindowsMsiLifecycleRunError, `${stage} must fail the row`);
            const cause = observed.cause;
            const reported = cause instanceof AggregateError ? cause.errors : [cause];
            assert.ok(reported.includes(failure),
                `${stage} failure must survive cleanup, observed ${cause?.message}`);
            assert.ok([observed.progress.failure.message,
                ...observed.progress.failure.aggregated.map(entry => entry.message)]
                .includes(failure.message), `${stage} failure must be retained in the progress`);
            assert.ok(fixture.calls.includes("cleanup:0"), `${stage} must still clean the row`);
        }
    });

    it("aggregates a genuine cleanup failure with the primary row failure", async () => {
        const fixture = await createHostFixture();
        const primary = new Error("media failed");
        const cleanupFailure = new Error("cleanup failed");
        fixture.operations.prepareMedia = async () => { throw primary; };
        fixture.operations.cleanupRow = async () => { throw cleanupFailure; };
        const observed = await runWindowsMsiLifecycleHost(fixture.request, fixture.operations)
            .then(() => null, error => error);
        assert.ok(observed instanceof WindowsMsiLifecycleRunError);
        assert.ok(observed.cause instanceof AggregateError);
        assert.deepEqual(observed.cause.errors, [primary, cleanupFailure]);
    });

    /*
     * createHostedQemuProcessLauncher stamps its budget when it is constructed, so one launcher
     * shared by the factory hands every later row whatever is left of a single row budget. Each
     * row is its own QEMU stage and must be launched under its own fresh default launcher; the
     * whole-job bound is a separate admission obligation, not a shrinking per-row deadline.
     */
    it("gives every row its own default QEMU budget under a controlled clock", async () => {
        const fixture = await createHostFixture();
        const toolchain = fixture.request.toolchain;
        const owned = new Map([[toolchain.runtimeLoader.path, toolchain.runtimeLoader],
            [toolchain.qemu.path, toolchain.qemu], [toolchain.firmware.kvmvapic.path, toolchain.firmware.kvmvapic],
            [toolchain.firmware.vga.path, toolchain.firmware.vga]]);
        for (const tool of ["/usr/bin/sudo", "/usr/bin/timeout", "/usr/bin/kill", "/usr/bin/readlink"])
            owned.set(tool, {path: tool, bytes: "1024", sha256: "0".repeat(64),
                ownership: {uid: "0", gid: "0", mode: "755", ordinaryUserWritable: false}});
        let now = 1_000_000;
        const deadlines = [];
        const qemuDependencies = {
            monotonicMilliseconds: () => now,
            inspectDirectory: target => target === "/tmp"
                ? {path: "/tmp", uid: "0", gid: "0", mode: "1777", sticky: true, ordinaryUserWritable: true}
                : {path: target, uid: "0", gid: "0", mode: "755", sticky: false, ordinaryUserWritable: false},
            inspectOwned: target => {
                const value = owned.get(target);
                if (!value) throw new Error(`unexpected owned inspection ${target}`);
                return {path: value.path, bytes: value.bytes, sha256: value.sha256,
                    ownership: value.ownership};
            },
            pathExists: () => false,
            readOwnedVerified: target => ({identity: {path: target, bytes: String(PNG_BYTES.length),
                sha256: sha256(PNG_BYTES)}, bytes: PNG_BYTES}),
            runMonitoredQemu: async request => {
                deadlines.push({launchedAt: now, executionDeadline: request.executionDeadline});
                return {observation: {process: {exitCode: 0, signal: null, timedOut: false, cleanupProven: true,
                    errorObserved: false, stdoutOverflow: false, stderrOverflow: false},
                stderr: Buffer.alloc(0)},
                identity: {pid: 42, startTicks: "123", executablePath: toolchain.runtimeLoader.path,
                    processGroupId: 42}, absentAfter: true, processGroupGone: true, terminationReason: null,
                monitorFailure: null, qmp: {inputSent: false, running: true, status: "running",
                    version: {major: 9, minor: 2, micro: 1}, screenshotPaths: request.qmp.screenshotPaths}};
            }
        };
        const operations = createWindowsMsiLifecycleHostOperations({request: fixture.request, dependencies: {
            deriveActualContext: () => structuredClone(fixture.request.context),
            inspectFile: async target => ({...owned.get(target), mode: 0o444}), qemuDependencies}});
        const vectors = async row => ({row, overlay: await fixture.operations.createOverlay({row}),
            media: await fixture.operations.prepareMedia({row})});
        const first = await operations.launchRow(await vectors(fixture.request.rows[0]));
        assert.equal(first.treeGone, true);
        now += ROW_MILLISECONDS;
        const second = await operations.launchRow(await vectors(fixture.request.rows[1]));
        assert.equal(second.treeGone, true);
        assert.deepEqual(deadlines, [
            {launchedAt: 1_000_000, executionDeadline: 1_000_000 + ROW_MILLISECONDS},
            {launchedAt: 1_000_000 + ROW_MILLISECONDS,
                executionDeadline: 1_000_000 + 2 * ROW_MILLISECONDS}]);
    });

    it("uses an injected QEMU launcher for every row instead of building a default one", async () => {
        const fixture = await createHostFixture();
        const seen = [];
        const toolchainByPath = new Map([fixture.request.toolchain.runtimeLoader,
            fixture.request.toolchain.qemu].map(tool => [tool.path, tool]));
        const operations = createWindowsMsiLifecycleHostOperations({request: fixture.request, dependencies: {
            deriveActualContext: () => structuredClone(fixture.request.context),
            inspectFile: async target => ({...toolchainByPath.get(target), mode: 0o444}),
            qemuDependencies: {monotonicMilliseconds: () => { throw new Error("default launcher constructed"); }},
            runQemu: async request => { seen.push(request.paths.root); return {process: {exitCode: 0,
                signal: null, timedOut: false, cleanupProven: true, treeGone: true, qemuPid: 42,
                qemuStartTicks: "123", processGroupId: 42, qemuPidAbsentAfter: true,
                launcherExecutablePath: fixture.request.toolchain.runtimeLoader.path,
                terminationReason: null}, argv: request.argv, executionSucceeded: true,
            processFlags: {errorObserved: false, stdoutOverflow: false, stderrOverflow: false}}; }}});
        for (const row of fixture.request.rows.slice(0, 3))
            await operations.launchRow({row, overlay: await fixture.operations.createOverlay({row}),
                media: await fixture.operations.prepareMedia({row})});
        assert.deepEqual(seen, fixture.request.rows.slice(0, 3).map(row => row.rowRoot));
    });

    /*
     * The rows carry `rollbackCalibrationSha256` and `oldContainmentSha256`, and until the request
     * carried the producers' own documents those two fields accepted any hexadecimal string. Every
     * validation now re-derives them from the retained bytes, so the host refuses to execute a row
     * whose prerequisite digest did not come out of evidence it just inspected.
     */
    it("derives both row prerequisite digests from inspected retained evidence", async () => {
        const fixture = await createHostFixture();
        assert.equal(fixture.request.expected.rollbackCalibrationSha256,
            sha256(Buffer.from(fixture.request.prerequisiteEvidence.rollbackCalibration.document.bytesBase64,
                "base64")));
        assert.equal(fixture.request.expected.oldContainmentSha256,
            sha256(Buffer.from(fixture.request.prerequisiteEvidence.oldContainment.document.bytesBase64,
                "base64")));
        assert.equal(validateWindowsMsiLifecycleHostRequest(fixture.request), fixture.request);
        const result = await runWindowsMsiLifecycleHost(fixture.request, fixture.operations);
        assert.equal(result.status, "completed");
    });

    it("refuses an arbitrary prerequisite digest, a helper source pin and unexecuted evidence", async () => {
        const mutations = [
            ["arbitrary rollback digest",
                request => { request.expected.rollbackCalibrationSha256 = "1".repeat(64); }],
            ["arbitrary containment digest",
                request => { request.expected.oldContainmentSha256 = "2".repeat(64); }],
            ["helper source pin",
                request => { request.prerequisiteEvidence.rollbackCalibration.producer = "helper-source-pin"; }],
            ["absent evidence", request => { request.prerequisiteEvidence.oldContainment = null; }],
            ["unaccepted calibration", request => {
                const record = request.prerequisiteEvidence.rollbackCalibration;
                const value = JSON.parse(Buffer.from(record.document.bytesBase64, "base64"));
                value.accepted = false;
                const bytes = Buffer.from(JSON.stringify(value), "utf8");
                record.document = {bytes: String(bytes.length), sha256: sha256(bytes),
                    bytesBase64: bytes.toString("base64")};
                request.expected.rollbackCalibrationSha256 = record.document.sha256;
            }],
            ["old payload executed while contained", request => {
                const record = request.prerequisiteEvidence.oldContainment;
                const value = JSON.parse(Buffer.from(record.document.bytesBase64, "base64"));
                value.install.oldPayloadExecutionCount = 1;
                const bytes = Buffer.from(JSON.stringify(value), "utf8");
                record.document = {bytes: String(bytes.length), sha256: sha256(bytes),
                    bytesBase64: bytes.toString("base64")};
                request.expected.oldContainmentSha256 = record.document.sha256;
            }],
            ["containment produced by another run", request => {
                request.prerequisiteEvidence.oldContainment.provenance.runId = "34900000099"; }]
        ];
        for (const [name, mutate] of mutations) {
            const fixture = await createHostFixture();
            mutate(fixture.request);
            assert.throws(() => validateWindowsMsiLifecycleHostRequest(fixture.request), Error, name);
            await assert.rejects(() => runWindowsMsiLifecycleHost(fixture.request, fixture.operations),
                Error, name);
        }
    });

    /*
     * Fourteen rows at the 270-minute row deadline is sixty-three hours, and the job stops at six.
     * The run therefore admits each row against observed elapsed time and refuses to start one whose
     * cleanup margin it cannot guarantee, rather than discovering the limit mid-row. The refusal is
     * retained as typed progress so a feasibility claim rests on what was measured.
     */
    it("refuses to start a row the remaining job budget cannot finish and cleans up", async () => {
        const fixture = await createHostFixture();
        let now = 0;
        fixture.request.limits.budget = {jobBudgetMilliseconds: 40 * MINUTE,
            rowAllowanceMilliseconds: 10 * MINUTE, rowCleanupMarginMilliseconds: 2 * MINUTE,
            finalMarginMilliseconds: 5 * MINUTE};
        const launch = fixture.operations.launchRow;
        fixture.operations.launchRow = async args => { now += 12 * MINUTE; return launch(args); };
        const observed = await runWindowsMsiLifecycleHost(fixture.request, fixture.operations,
            {monotonicMilliseconds: () => now}).then(() => null, error => error);
        assert.ok(observed instanceof WindowsMsiLifecycleRunError, String(observed));
        assert.equal(observed.progress.kind, "myspeed-windows-msi-lifecycle-host-progress");
        assert.equal(observed.progress.status, "budget-exhausted");
        assert.equal(observed.progress.qualifying, false);
        assert.deepEqual(observed.progress.releaseGatesCleared, []);
        assert.equal(observed.progress.scenarioCount, 14);
        assert.equal(observed.progress.completedRows.length, 2);
        assert.equal(observed.progress.refusedScenarioIndex, 2);
        assert.equal(observed.progress.budget.rowsCompleted, 2);
        assert.deepEqual(observed.progress.completedRows.map(row => row.scenarioIndex), [0, 1]);
        assert.deepEqual(fixture.calls.filter(call => call.startsWith("cleanup")),
            ["cleanup:0", "cleanup:1"]);
        assert.ok(!fixture.calls.includes("launch:2"));
    });

    it("retains typed bounded progress for a row that failed rather than an opaque rejection", async () => {
        const fixture = await createHostFixture();
        fixture.operations.readGuestResult = async () => { throw new Error("guest result unreadable"); };
        const observed = await runWindowsMsiLifecycleHost(fixture.request, fixture.operations)
            .then(() => null, error => error);
        assert.ok(observed instanceof WindowsMsiLifecycleRunError, String(observed));
        assert.equal(observed.progress.status, "failed");
        assert.equal(observed.progress.refusedScenarioIndex, null);
        assert.equal(observed.progress.failedScenarioIndex, 0);
        assert.equal(observed.progress.failedScenarioId, "clean-default");
        assert.deepEqual(observed.progress.completedRows, []);
        assert.equal(observed.progress.failure.message, "guest result unreadable");
        assert.deepEqual(observed.progress.failure.aggregated, []);
        assert.equal(observed.cause.message, "guest result unreadable");
        assert.equal(JSON.stringify(observed.progress).length < MAX_PROGRESS_BYTES, true);
    });

    it("aggregates a row failure with its cleanup failure inside the retained progress", async () => {
        const fixture = await createHostFixture();
        fixture.operations.prepareMedia = async () => { throw new Error("media failed"); };
        fixture.operations.cleanupRow = async () => { throw new Error("cleanup failed"); };
        const observed = await runWindowsMsiLifecycleHost(fixture.request, fixture.operations)
            .then(() => null, error => error);
        assert.ok(observed instanceof WindowsMsiLifecycleRunError, String(observed));
        assert.deepEqual(observed.progress.failure.aggregated.map(entry => entry.message),
            ["media failed", "cleanup failed"]);
    });

    it("seals the whole-job budget observation into the completed result", async () => {
        const fixture = await createHostFixture();
        const result = await runWindowsMsiLifecycleHost(fixture.request, fixture.operations);
        assert.equal(result.budget.kind, "myspeed-windows-msi-lifecycle-budget-observation");
        assert.equal(result.budget.status, "completed");
        assert.equal(result.budget.rowsCompleted, 14);
        assert.equal(result.budget.refusedScenarioIndex, null);
        assert.deepEqual(result.budget.limits, fixture.request.limits.budget);
        assert.equal(validateCompletedWindowsMsiLifecycleHostResult(result, fixture.request), result);
        for (const mutate of [
            value => { value.budget.rowsCompleted = 13; },
            value => { value.budget.status = "budget-exhausted"; },
            value => { value.budget.refusedScenarioIndex = 3; },
            value => { value.budget.rows = value.budget.rows.slice(1); },
            value => { value.budget.releaseGatesCleared = ["msiLifecycle"]; },
            value => { value.budget.limits = {...value.budget.limits, jobBudgetMilliseconds: 1}; }
        ]) {
            const changed = structuredClone(result);
            mutate(changed);
            assert.throws(() => validateCompletedWindowsMsiLifecycleHostResult(changed, fixture.request));
        }
    });
    /*
     * A QEMU process that exited non-zero did not run the row: the exit status was bounded to a byte
     * but never required to be success, so a failed launch satisfied the shared acceptance helper.
     */
    it("refuses a row whose QEMU process exited non-zero", async () => {
        const fixture = await createWindowsMsiLifecycleHostEvidenceFixture({});
        assert.equal(validateCompletedWindowsMsiLifecycleHostResult(fixture.result, fixture.request),
            fixture.result);
        for (const exitCode of [1, 137, 255]) {
            const failed = structuredClone(fixture.result);
            failed.hostRows[0].qemu.exitCode = exitCode;
            assert.throws(() => validateCompletedWindowsMsiLifecycleHostResult(failed, fixture.request),
                /QEMU exit differs/u, String(exitCode));
        }
    });
});
