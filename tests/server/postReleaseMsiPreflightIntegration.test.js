/*
 * The containment preflight, end to end, through the controller that actually runs it.
 *
 * The chain this covers is the one the workflow used to stop in front of: the controller observes
 * the prepared artifact, seals the installed base, builds the preflight request from identities the
 * guest never chose, builds the real seed documents and envelope, boots a guest whose QEMU and
 * filesystem are injected but whose executor is the real one, puts the calibration it brings back
 * through the production prerequisite inspector, and only then binds the fourteen-row host request
 * with the record that inspection produced. The order is the point - the workflow used to demand
 * containment evidence before invoking the thing that creates it.
 *
 * Everything below the builders is injected: no QEMU is started, no disk is written, no MSI is
 * touched. A mocked preflight completes no native qualification and this file claims none.
 */
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {describe, it} from "node:test";

import {createPostReleaseMsiControllerFixture, decodedExecution, lifecycleInput} from
    "../helpers/post-release-msi-controller-fixture.mjs";
import {POST_RELEASE_MSI_LINUX_CONTROLLER_CONSTANTS,
    retainV161PostReleaseMsiControllerProgress, runV161PostReleaseMsiLinuxController,
    WindowsMsiContainmentPreflightRunError} from
    "../../scripts/release/post-release-msi-linux-controller.mjs";
import {createPostReleaseMsiEvidenceFixture, createZipBuffer} from
    "../helpers/post-release-msi-evidence-fixture.mjs";
import {verifyV161PostReleaseMsiEvidence} from
    "../../scripts/release/post-release-msi-verification.mjs";
import {canonicalizeWindowsMsiGuestLaunchInventory,
    executeWindowsMsiGuestPreflightEnvelope} from
    "../../scripts/qualification/windows-msi-guest-containment-preflight-executor.mjs";
import {WINDOWS_MSI_CONTAINMENT_PREFLIGHT_HOST} from
    "../../scripts/qualification/windows-msi-containment-preflight-host.mjs";

const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
const OUTPUT_DISK_BYTES = 268_435_456;

/*
 * The real guest executor, against injected containment operations. The helper proofs it is given
 * carry the inventory digest of the records it lists, exactly as the real helper's would, so the
 * executor's own binding of the two is exercised rather than stepped around.
 */
const runGuest = async (envelope, request, settings) => {
    const records = (settings.records ?? (nonce => [{
        name: `containment-launch-${nonce}-2140.json`,
        bytes: Buffer.from(JSON.stringify({schemaVersion: 1,
            kind: "myspeed-windows-msi-guest-containment-launch", nonce, processId: 2140,
            intercepted: true}), "utf8")}]))(request.nonce);
    const inventory = sha256(canonicalizeWindowsMsiGuestLaunchInventory(records.map(record =>
        ({name: record.name, bytes: String(record.bytes.length), sha256: sha256(record.bytes)}))));
    let produced = null;
    await executeWindowsMsiGuestPreflightEnvelope(envelope, {
        readBoundFile: async () => Buffer.from(JSON.stringify(request), "utf8"),
        writeCreateNew: async (_target, bytes) => { produced = bytes; },
        operationsFactory: () => ({
            boundary: async () => ({serial: settings.serial ?? request.guest.serial}),
            containment: async mode => ({status: "completed", mode,
                productCode: request.msi.productCode, ifeoActive: mode === "Install",
                oldPayloadExecutionCount: settings.oldPayloadExecutionCount ?? 0,
                registryRestored: mode === "Remove",
                launchInventorySha256: settings.launchInventorySha256 ?? inventory}),
            listLaunchRecords: async () => records
        })});
    return produced;
};

/*
 * A filesystem and an owned-command runner that record rather than act. Identities come from what
 * the controller itself asked to be staged, so "the helper was staged at the digest the closure
 * observed" is an observation, not a restatement of the fixture.
 */
const recorder = (identities, settings) => {
    const files = new Map(identities);
    /* Time only moves when a case asks it to, and only while the guest is notionally running. */
    const spend = () => { if (settings.clock) settings.clock.now += settings.clock.step; };
    const written = new Map();
    const staged = new Set();
    const commands = [];
    const directories = new Set();
    const removed = [];
    const filesystem = {
        constants: {COPYFILE_EXCL: 1},
        existsSync: target => files.has(target) || directories.has(target),
        mkdirSync: (target, options) => {
            if (directories.has(target) && options?.recursive !== true)
                throw new Error(`exists: ${target}`);
            directories.add(target);
        },
        openSync: target => {
            if (files.has(target)) throw new Error(`exists: ${target}`);
            staged.add(target);
            files.set(target, {bytes: "0", sha256: sha256(Buffer.alloc(0)), mode: 0o600});
            return target;
        },
        writeFileSync: (handle, bytes) => {
            written.set(handle, bytes);
            files.set(handle, {bytes: String(bytes.length), sha256: sha256(bytes), mode: 0o600,
                content: bytes});
        },
        ftruncateSync: (handle, size) => files.set(handle, {bytes: String(size),
            sha256: "c".repeat(64), mode: 0o600}),
        fsyncSync: () => undefined,
        closeSync: () => undefined,
        copyFileSync: (from, to) => {
            if (files.has(to)) throw new Error(`exists: ${to}`);
            staged.add(to);
            files.set(to, {...files.get(from)});
        },
        readFileSync: target => files.get(target)?.content ?? Buffer.alloc(0),
        rmSync: target => {
            removed.push(target);
            for (const key of [...files.keys()]) if (key.startsWith(`${target}/`)) files.delete(key);
            for (const key of [...directories]) if (key === target || key.startsWith(`${target}/`))
                directories.delete(key);
        }
    };
    const inspectFile = async target => {
        const item = files.get(target);
        if (!item) throw new Error(`MSI preflight inspected file is absent: ${target}`);
        return {path: target, bytes: item.bytes, sha256: item.sha256, mode: item.mode ?? 0o600,
            ownership: item.ownership ?? {uid: "0", gid: "0", mode: "555",
                ordinaryUserWritable: false}};
    };
    const done = (stdout = "") => ({process: {exitCode: 0, signal: null, timedOut: false,
        cleanupProven: true, errorObserved: false, stdoutOverflow: false, stderrOverflow: false},
    stdout: Buffer.from(stdout, "utf8"), stderr: Buffer.alloc(0)});
    const runOwned = async (_loader, argv) => {
        const toolPath = argv[2];
        const rest = argv.slice(3);
        commands.push([toolPath, ...rest].join(" "));
        if (toolPath.endsWith("/qemu-img") && rest[0] === "info")
            return done(JSON.stringify(rest[rest.length - 1] === settings.baseImagePath
                ? {format: "qcow2", "virtual-size": 68_719_476_736}
                : {format: "qcow2", "backing-filename": settings.baseImagePath}));
        if (toolPath.endsWith("/qemu-img") && rest[0] === "create") {
            files.set(rest[rest.length - 1], {bytes: "262144", sha256: "7".repeat(64), mode: 0o600});
            return done();
        }
        if (toolPath.endsWith("/genisoimage")) {
            files.set(rest[rest.indexOf("-o") + 1], {bytes: "1048576", sha256: "8".repeat(64),
                mode: 0o600});
            return done();
        }
        if (toolPath.endsWith("/mcopy")) {
            /* The guest's answer, produced by the real executor from the documents just staged. */
            const seedRoot = settings.seedRoot();
            const envelope = JSON.parse(written.get(`${seedRoot}/preflight-envelope.json`)
                .toString("utf8"));
            const request = JSON.parse(written.get(`${seedRoot}/preflight-request.json`)
                .toString("utf8"));
            const bytes = await runGuest(envelope, request, settings);
            files.set(rest[rest.length - 1], {bytes: String(bytes.length), sha256: sha256(bytes),
                mode: 0o600, content: bytes});
            return done();
        }
        return done();
    };
    const launched = [];
    const runQemu = async input => {
        launched.push(input);
        spend();
        if (settings.mutateBaseAfterLaunch) {
            const base = files.get(settings.baseImagePath);
            files.set(settings.baseImagePath, {...base, sha256: "4".repeat(64)});
        }
        const proven = settings.groupZero !== false;
        return {executionSucceeded: settings.executionSucceeded ?? proven,
            process: {qemuPid: 4242, qemuStartTicks: "900", processGroupId: 4242,
                exitCode: settings.qemuExitCode ?? 0, signal: null,
                timedOut: settings.timedOut ?? false, terminationReason: null, cleanupProven: proven,
                treeGone: proven, qemuPidAbsentAfter: proven}};
    };
    return {filesystem, inspectFile, runOwned, runQemu, commands, written, staged, launched, removed};
};

const drive = async (settings = {}, calls = []) => {
    const value = await createPostReleaseMsiControllerFixture();
    const input = lifecycleInput(value, decodedExecution(value.host.request.rows[0]));
    const seal = input.installedBaseSeal;
    const identities = [[seal.image.path, {bytes: seal.image.bytes, sha256: seal.image.sha256,
        mode: 0o444, ownership: seal.image.ownership}]];
    for (const item of Object.values(input.stage2Result.toolchain)) {
        if (item?.path) identities.push([item.path, {bytes: item.bytes, sha256: item.sha256,
            mode: 0o555, ownership: item.ownership}]);
        for (const nested of Object.values(item ?? {}))
            if (nested?.path && nested?.sha256) identities.push([nested.path, {bytes: nested.bytes,
                sha256: nested.sha256, mode: 0o555, ownership: nested.ownership}]);
    }
    for (const source of Object.values(input.sources))
        identities.push([source.path, {bytes: String(source.bytes), sha256: source.sha256,
            mode: 0o444}]);
    const msi = input.observedPreparation.execution.files
        .find(file => file.bindingId === "authentic-1.6.0-default-msi" && file.role === "msi");
    identities.push([msi.path, {bytes: String(msi.bytes), sha256: msi.sha256, mode: 0o444}]);
    const guestNonce = WINDOWS_MSI_CONTAINMENT_PREFLIGHT_HOST.deriveGuestNonce(input.context.nonce);
    const recorded = recorder(identities, {...settings, baseImagePath: seal.image.path,
        seedRoot: () => `${input.taskRoot}/containment-preflight/seed`});
    settings.capture?.(recorded);
    const seen = {};
    const result = await runV161PostReleaseMsiLinuxController({
        context: input.context, taskRoot: input.taskRoot,
        artifactRoot: `${input.taskRoot}/appassets`,
        artifact: {repository: "i7Gamer/MySpeed", id: "7001",
            name: "post-release-v1.6.1-msi-appassets", bytes: "400000000",
            digest: `sha256:${"e".repeat(64)}`, runId: input.context.runId,
            runAttempt: input.context.runAttempt, headSha: input.context.sourceSha},
        closureRoot: input.closureRoot, stage2Paths: {root: input.taskRoot},
        stage2Result: input.stage2Result,
        installedBaseHelperSource: {path: "scripts/qualification/windows-msi-installed-base.mjs",
            bytes: "4096", sha256: "b".repeat(64)},
        prerequisiteEvidence: {rollbackCalibration: settings.rollbackCalibration
            ? settings.rollbackCalibration(input.prerequisiteEvidence.rollbackCalibration)
            : input.prerequisiteEvidence.rollbackCalibration},
        budget: settings.budget ? settings.budget(input.budget) : input.budget,
        wallDeadlineUnixMilliseconds: settings.wallDeadlineUnixMilliseconds
            ?? input.wallDeadlineUnixMilliseconds,
        hostRequestPath: `${input.taskRoot}/msi-host-request.json`
    }, {
        observePreparation: async () => { calls.push("observe-preparation");
            return input.observedPreparation; },
        prepareLinuxFixture: async () => { calls.push("prepare-fixture"); return input.linuxFixture; },
        sealInstalledBase: async () => { calls.push("seal-base"); return seal; },
        observeSources: async () => { calls.push("observe-sources"); return input.sources; },
        onPreflight: outcome => { calls.push("run-preflight"); seen.preflight = outcome; },
        preflightDependencies: {filesystem: recorded.filesystem, inspectFile: recorded.inspectFile,
            runOwned: recorded.runOwned, runQemu: recorded.runQemu,
            limits: {outputDiskBytes: OUTPUT_DISK_BYTES},
            ...(settings.clock ? {monotonicMilliseconds: () => settings.clock.now,
                unixMilliseconds: () => settings.clock.unix + settings.clock.now} : {})},
        retainHostRequest: request => { calls.push("retain-host-request");
            seen.hostRequest = request; },
        runHost: async request => { calls.push("run-matrix"); seen.matrixRequest = request;
            return {status: "completed", rows: request.rows.length}; }
    });
    return {calls, seen, input, recorded, guestNonce, result};
};

const driveFailure = async (settings, label) => {
    const calls = [];
    try {
        await drive(settings, calls);
    } catch (error) {
        return {error, calls};
    }
    assert.fail(`${label} did not fail`);
};

describe("post-release MSI containment preflight integration", () => {
    it("produces the containment evidence it needs before it binds the matrix that needs it",
        async () => {
            const {calls, seen, guestNonce} = await drive();
            /*
             * The order is the correction itself: the preflight runs after the base is sealed and
             * before the host request is bound, so the record fourteen rows name is one this run made.
             */
            assert.deepEqual(calls, ["observe-preparation", "prepare-fixture", "seal-base",
                "observe-sources", "run-preflight", "retain-host-request", "run-matrix"]);
            const bound = seen.matrixRequest.prerequisiteEvidence.oldContainment;
            assert.equal(bound.prerequisiteId, "authentic-old-ifeo-containment");
            assert.equal(bound.producer, "in-guest-calibration");
            assert.equal(bound.provenance.guestSerial, guestNonce);
            const calibration = JSON.parse(Buffer.from(bound.document.bytesBase64, "base64")
                .toString("utf8"));
            assert.equal(calibration.kind, "myspeed-windows-msi-guest-containment-calibration");
            assert.equal(calibration.install.oldPayloadExecutionCount, 0);
            assert.equal(calibration.launchRecords.length, 1);
            /* Blocked attempts and executions stay separate all the way through the chain. */
            assert.equal(seen.preflight.semantics.interceptedLaunchCount, 1);
            assert.equal(seen.preflight.semantics.oldPayloadExecutionCount, 0);
            /* Every row names that document's digest, and the retained request is the bound one. */
            assert.equal(seen.matrixRequest.expected.oldContainmentSha256, bound.document.sha256);
            assert.equal(seen.matrixRequest.rows.length, 14);
            assert.deepEqual(seen.hostRequest, seen.matrixRequest);
        });

    it("boots one disposable overlay of the sealed base and cleans it up", async () => {
        const {recorded, input} = await drive();
        const root = `${input.taskRoot}/containment-preflight`;
        assert.equal(recorded.launched.length, 1);
        assert.ok(recorded.commands.some(value =>
            value.includes(`create -f qcow2 -F qcow2 -b ${input.installedBaseSeal.image.path}`)));
        assert.deepEqual(recorded.removed, [root]);
        /* The vector is NIC-free and carries the serial the guest is checked against. */
        const [{argv}] = recorded.launched;
        assert.equal(argv[argv.indexOf("-smbios") + 1],
            `type=1,serial=${WINDOWS_MSI_CONTAINMENT_PREFLIGHT_HOST.deriveGuestNonce(input.context.nonce)}`);
        assert.equal(argv.includes("-netdev"), false);
        assert.equal(argv.includes("-nic"), true);
    });

    it("builds the guest request and seed from identities the guest never chose", async () => {
        const {recorded, input, guestNonce} = await drive();
        const seedRoot = `${input.taskRoot}/containment-preflight/seed`;
        const preflightRequest = JSON.parse(recorded.written.get(`${seedRoot}/preflight-request.json`)
            .toString("utf8"));
        const observedMsi = input.observedPreparation.execution.files
            .find(file => file.bindingId === "authentic-1.6.0-default-msi" && file.role === "msi");
        /* The MSI digest is the observed preparation's; the helper digest is the sealed closure's. */
        assert.equal(preflightRequest.msi.sha256, observedMsi.sha256);
        assert.equal(preflightRequest.helper.sha256, input.sources.containment.sha256);
        assert.equal(preflightRequest.guest.serial, guestNonce);
        assert.notEqual(preflightRequest.guest.serial, input.context.nonce);
        assert.equal(preflightRequest.nonce, input.context.nonce);
        assert.equal(preflightRequest.qualifying, false);
        /* The envelope binds the request bytes, and the launch request binds the envelope. */
        const envelope = JSON.parse(recorded.written.get(`${seedRoot}/preflight-envelope.json`)
            .toString("utf8"));
        assert.equal(envelope.preflightRequest.sha256,
            sha256(recorded.written.get(`${seedRoot}/preflight-request.json`)));
        const launch = JSON.parse(recorded.written.get(`${seedRoot}/launch-request.json`)
            .toString("utf8"));
        assert.equal(launch.files.semanticRequest.sha256,
            sha256(recorded.written.get(`${seedRoot}/preflight-envelope.json`)));
        /* Its seed is a preflight seed, not a matrix row's. */
        const manifest = JSON.parse(recorded.written.get(`${seedRoot}/seed-manifest.json`)
            .toString("utf8"));
        assert.equal(manifest.kind, "myspeed-windows-msi-containment-preflight-seed");
        assert.equal(Object.hasOwn(manifest, "scenarioIndex"), false);
        /* And the helper and the authentic MSI were staged from where they were observed. */
        assert.ok(recorded.staged.has(`${seedRoot}/windows-msi-guest-containment.ps1`));
        assert.ok(recorded.staged.has(`${seedRoot}/authentic-1.6.0-default-msi.msi`));
        assert.ok(recorded.staged.has(
            `${seedRoot}/windows-msi-guest-containment-preflight-executor.mjs`));
    });

    /*
     * Every way the preflight can fail to prove what it claims has to stop the matrix. A run that
     * launched fourteen rows on evidence that was never produced, or that another guest produced,
     * would be worth less than a run that produced nothing at all.
     */
    it("never launches the matrix when the preflight did not prove what it claims", async () => {
        const cases = {
            "a QEMU whose process group was never proven gone": {groupZero: false},
            "a reusable base that changed underneath the preflight": {mutateBaseAfterLaunch: true},
            "a rollback record the inspector refuses": {rollbackCalibration: record =>
                ({...record, provenance: {...record.provenance, runAttempt: "2"}})},
            "a budget this job could never finish in": {budget: value =>
                ({...value, jobBudgetMilliseconds: value.rowAllowanceMilliseconds})},
            "another guest answering": {serial: "6".repeat(32)},
            "an inventory digest no retained record produces": {launchInventorySha256: "b".repeat(64)},
            "an old payload that actually executed": {oldPayloadExecutionCount: 1},
            "a launch record another run's nonce named": {records: () => [{
                name: `containment-launch-${"1".repeat(32)}-2140.json`,
                bytes: Buffer.from(JSON.stringify({schemaVersion: 1,
                    kind: "myspeed-windows-msi-guest-containment-launch", nonce: "1".repeat(32),
                    processId: 2140, intercepted: true}), "utf8")}]},
            "a stub reporting it did not intercept": {records: nonce => [{
                name: `containment-launch-${nonce}-2140.json`,
                bytes: Buffer.from(JSON.stringify({schemaVersion: 1,
                    kind: "myspeed-windows-msi-guest-containment-launch", nonce, processId: 2140,
                    intercepted: false}), "utf8")}]}
        };
        for (const [name, settings] of Object.entries(cases)) {
            const calls = [];
            await assert.rejects(drive(settings, calls), error => {
                assert.ok(error instanceof Error, name);
                return true;
            }, name);
            /* The matrix never started, and nothing was retained that could stand in for evidence. */
            assert.equal(calls.includes("run-matrix"), false, name);
            assert.equal(calls.includes("retain-host-request"), false, name);
            /* It did get as far as sealing the base, so these are failures of the run, not of setup. */
            assert.equal(calls.includes("seal-base"), true, name);
        }
    });

    /*
     * The controller CLI only ever retained `WindowsMsiLifecycleRunError`. A preflight throws an
     * ordinary Error - or an AggregateError when its cleanup failed too - so a run that stopped
     * inside the preflight used to retain no typed progress at all, and the claim that it did was
     * false. What it retains now is failure evidence and nothing that could pass for a matrix.
     */
    it("retains typed, bounded progress for a preflight that failed, and nothing else", async () => {
        const {error, calls} = await driveFailure({groupZero: false}, "an unproven process group");
        assert.ok(error instanceof WindowsMsiContainmentPreflightRunError);
        const {progress} = error;
        assert.equal(progress.kind, POST_RELEASE_MSI_LINUX_CONTROLLER_CONSTANTS.PREFLIGHT_PROGRESS_KIND);
        assert.equal(progress.status,
            POST_RELEASE_MSI_LINUX_CONTROLLER_CONSTANTS.PREFLIGHT_PROGRESS_STATUS);
        assert.equal(progress.qualifying, false);
        /* The stage it stopped at, and the fact that the stage itself returned. */
        assert.equal(progress.stage, "cleanupOverlay");
        assert.ok(POST_RELEASE_MSI_LINUX_CONTROLLER_CONSTANTS.PREFLIGHT_STAGES.includes(progress.stage));
        assert.deepEqual(progress.stagesCompleted,
            ["inspectBase", "createOverlay", "prepareMedia", "launchPreflight", "cleanupOverlay"]);
        /*
         * Both causes survive: the launch that could not prove its group gone, and the cleanup that
         * refused to remove an overlay a QEMU might still have been holding.
         */
        assert.equal(progress.failure.category, "AggregateError");
        assert.match(progress.failure.primary.detail, /process tree exit|group zero/iu);
        assert.match(progress.failure.cleanup.detail, /cleanup differs/iu);
        for (const entry of [progress.failure, progress.failure.primary, progress.failure.cleanup])
            assert.ok(entry.detail.length
                <= POST_RELEASE_MSI_LINUX_CONTROLLER_CONSTANTS.MAX_FAILURE_CHARACTERS);
        /* Nothing in it could stand in for a completed matrix. */
        assert.equal(progress.matrixLaunched, false);
        assert.deepEqual(progress.completedRows, []);
        assert.deepEqual(progress.releaseGatesCleared, []);
        for (const name of ["result", "hostRows", "guestEvidence", "guestInspection", "budget",
            "accepted", "record"])
            assert.equal(Object.hasOwn(progress, name), false, name);
        assert.equal(calls.includes("retain-host-request"), false);
        assert.equal(calls.includes("run-matrix"), false);
        /* And it says how much of its own reservation the failed preflight had used. */
        assert.equal(progress.reservation.label, "containment-preflight");
        assert.equal(progress.reservation.launchAdmitted, true);
        assert.equal(progress.reservation.qualifying, false);
    });

    it("names a single cause as the primary one with no cleanup failure beside it", async () => {
        const {error} = await driveFailure({oldPayloadExecutionCount: 1}, "an executed old payload");
        assert.ok(error instanceof WindowsMsiContainmentPreflightRunError);
        assert.notEqual(error.progress.failure.category, "AggregateError");
        assert.equal(error.progress.failure.cleanup, null);
        assert.equal(error.progress.failure.primary.detail, error.progress.failure.detail);
        /* The overlay came down cleanly, so the failure is the guest's alone. */
        assert.equal(error.progress.stagesCompleted.includes("cleanupOverlay"), true);
    });

    it("is what the controller CLI writes to its progress path, and only that", async () => {
        const {error} = await driveFailure({groupZero: false}, "an unproven process group");
        const written = [];
        assert.equal(retainV161PostReleaseMsiControllerProgress(error,
            value => written.push(value)), true);
        assert.deepEqual(written, [error.progress]);
        /* A failure that is neither typed run error retains nothing rather than something untyped. */
        assert.equal(retainV161PostReleaseMsiControllerProgress(new Error("plain"),
            () => assert.fail("an untyped failure was retained")), false);
        /* It serializes the way the CLI writes it, and stays inside the controller's bound. */
        const bytes = Buffer.from(`${JSON.stringify(error.progress)}\n`, "utf8");
        assert.deepEqual(JSON.parse(bytes.toString("utf8")), error.progress);
        assert.ok(bytes.length
            < POST_RELEASE_MSI_LINUX_CONTROLLER_CONSTANTS.MAX_CONTROLLER_DOCUMENT_BYTES);
    });

    it("retains typed admission failure before any preflight launch or matrix evidence", async () => {
        const expiredUnixMilliseconds = 1_800_000_000_000;
        const cases = {
            "expired wall deadline": {wallDeadlineUnixMilliseconds: expiredUnixMilliseconds,
                clock: {now: 0, unix: expiredUnixMilliseconds}},
            "invalid lifecycle budget": {budget: value => ({...value, jobBudgetMilliseconds: 0})}
        };
        for (const [name, settings] of Object.entries(cases)) {
            let recorded;
            const {error, calls} = await driveFailure({...settings,
                capture: value => { recorded = value; }}, name);
            assert.ok(error instanceof WindowsMsiContainmentPreflightRunError, name);
            const written = [];
            assert.equal(retainV161PostReleaseMsiControllerProgress(error,
                value => written.push(value)), true, name);
            assert.deepEqual(written, [error.progress], name);
            assert.equal(error.progress.status, "preflight-failure", name);
            assert.equal(error.progress.matrixLaunched, false, name);
            assert.deepEqual(error.progress.completedRows, [], name);
            assert.equal(Object.hasOwn(error.progress, "result"), false, name);
            assert.equal(calls.includes("retain-host-request"), false, name);
            assert.equal(calls.includes("run-matrix"), false, name);
            assert.equal(recorded.launched.length, 0, name);
            assert.deepEqual(recorded.commands, [], name);
        }
    });

    /*
     * The consumer's side of it, fed the real document rather than a fabricated one: evidence that
     * retains a preflight failure is not completed evidence, whatever else the archive holds.
     */
    it("is refused by the production consumer when it reaches the retained evidence", async () => {
        const {error} = await driveFailure({groupZero: false}, "an unproven process group");
        const fixture = await createPostReleaseMsiEvidenceFixture();
        const verify = files => {
            const archiveBytes = createZipBuffer(files.map(([name, data]) => ({name, data})));
            return verifyV161PostReleaseMsiEvidence({archiveBytes,
                artifactMetadata: {...fixture.artifactMetadata, size_in_bytes: archiveBytes.length,
                    digest: `sha256:${sha256(archiveBytes)}`},
            expectedExecution: fixture.expectedExecution,
            workflowRunRecord: {id: Number(fixture.expectedExecution.runId),
                run_attempt: Number(fixture.expectedExecution.runAttempt),
                head_sha: fixture.expectedExecution.sourceSha,
                repository: {full_name: fixture.expectedExecution.repository},
            path: `.github/workflows/${fixture.expectedExecution.workflow}`}});
        };
        /*
         * The control: repacked and unchanged, this archive is accepted. So the refusal below is
         * the retained preflight failure and not an artefact of rebuilding the archive.
         */
        assert.equal((await verify([...fixture.files])).status, "accepted");
        await assert.rejects(verify([...fixture.files, ["msi-lifecycle-progress.json",
            Buffer.from(`${JSON.stringify(error.progress)}\n`, "utf8")]]), /progress/iu);
    });

    /*
     * The preflight is charged to the same job the matrix runs in, so whatever it took has to come
     * off what the matrix may claim. Otherwise the fourteen rows are admitted against a budget that
     * was already partly spent on the guest that came before them.
     */
    it("charges the elapsed preflight into the budget the matrix is admitted against", async () => {
        const clock = {now: 0, unix: 1_800_000_000_000, step: 11 * 60_000};
        const {seen, input} = await drive({clock});
        assert.equal(seen.preflight.reservation.elapsedMilliseconds, clock.step);
        assert.equal(seen.matrixRequest.limits.budget.jobBudgetMilliseconds,
            input.budget.jobBudgetMilliseconds - clock.step);
        /* Only the job budget moves: the planning figures the rows are measured against do not. */
        for (const name of ["rowAllowanceMilliseconds", "rowCleanupMarginMilliseconds",
            "finalMarginMilliseconds"])
            assert.equal(seen.matrixRequest.limits.budget[name], input.budget[name], name);
    });

    /*
     * A preflight that spends its whole allowance and its whole cleanup margin still leaves the
     * matrix everything it was promised - which is what the reservation was for. The charge is not a
     * second gate here; it is the arithmetic that makes the promise true.
     */
    it("leaves the matrix the room the reservation promised it, even at the limit", async () => {
        const clock = {now: 0, unix: 1_800_000_000_000, step: 17 * 60_000 - 1_000};
        const {seen, input, calls} = await drive({clock});
        assert.equal(calls.includes("run-matrix"), true);
        const budget = seen.matrixRequest.limits.budget;
        assert.equal(budget.jobBudgetMilliseconds,
            input.budget.jobBudgetMilliseconds - clock.step);
        assert.ok(budget.jobBudgetMilliseconds >= budget.rowAllowanceMilliseconds
            + budget.rowCleanupMarginMilliseconds + budget.finalMarginMilliseconds);
    });

    it("stops a preflight whose cleanup margin is gone before it reads anything", async () => {
        const clock = {now: 0, unix: 1_800_000_000_000, step: 17 * 60_000};
        const calls = [];
        await assert.rejects(drive({clock}, calls), /cleanup headroom/iu);
        assert.equal(calls.includes("run-matrix"), false);
        assert.equal(calls.includes("retain-host-request"), false);
    });
});
