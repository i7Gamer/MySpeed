import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {describe, it} from "node:test";

import {createWindowsMsiScenario0CalibrationFixture} from "../helpers/windows-msi-scenario0-calibration-fixture.mjs";
import {createWindowsMsiLifecycleHostEvidenceFixture} from "../helpers/linux-windows-msi-lifecycle-host-fixture.mjs";
import {validateCompletedWindowsMsiLifecycleHostResult} from "../../scripts/qualification/linux-windows-msi-lifecycle-host.mjs";
import {
    SCENARIO0_CALIBRATION_RESULT_KIND,
    SCENARIO0_CALIBRATION_PROGRESS_KIND,
    SCENARIO0_CALIBRATION_BUDGET_KIND,
    SCENARIO0_CALIBRATION_MAX_EXECUTION_MILLISECONDS,
    SCENARIO0_CALIBRATION_MAX_CLEANUP_MILLISECONDS,
    SCENARIO0_CALIBRATION_RETENTION_RESERVE_MILLISECONDS,
    SCENARIO0_CALIBRATION_MAX_JOB_MILLISECONDS,
    SCENARIO0_CALIBRATION_RESERVATION_LABEL,
    runWindowsMsiScenario0Calibration,
    validateWindowsMsiScenario0CalibrationRequest,
    validateCompletedWindowsMsiScenario0CalibrationResult,
    createWindowsMsiScenario0CalibrationOperations,
    WindowsMsiScenario0CalibrationRunError
} from "../../scripts/qualification/windows-msi-scenario0-calibration.mjs";

const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
const MINUTE = 60_000;
const retain = value => {
    const bytes = Buffer.from(JSON.stringify(value), "utf8");
    return {bytes: bytes.length, sha256: sha256(bytes), bytesBase64: bytes.toString("base64")};
};

describe("Windows MSI Scenario 0 calibration", () => {
    it("runs the real factory, survives a JSON round trip and is accepted by the real consumer", async () => {
        const fixture = await createWindowsMsiScenario0CalibrationFixture();
        assert.equal(fixture.result.kind, SCENARIO0_CALIBRATION_RESULT_KIND);
        assert.equal(fixture.result.status, "completed");
        assert.equal(fixture.result.qualifying, false);
        assert.deepEqual(fixture.result.releaseGatesCleared, []);
        assert.equal(fixture.result.rowProof.scenarioIndex, 0);
        assert.equal(fixture.result.rowProof.scenarioId, "clean-default");
        assert(fixture.result.timing.observedDurationMilliseconds > 0);

        /*
         * The controller writes the result as JSON and a later step reads it back, so the delivered
         * document is the one that survived that trip. A Buffer would arrive as {type,data} and the
         * consumer would reject it; the retained guest result is base64 text for exactly that reason.
         */
        assert.deepEqual(fixture.serialized, fixture.result);
        assert.equal(typeof fixture.result.rowProof.guestResult.bytesBase64, "string");
        assert.deepEqual(Object.keys(fixture.result.rowProof.guestResult).sort(),
            ["bytes", "bytesBase64", "path", "sha256"]);
        assert.equal(fixture.result.rowProof.guestResult.path, fixture.request.row.guestResultPath);
        assert.equal(validateCompletedWindowsMsiScenario0CalibrationResult(fixture.serialized, fixture.request),
            fixture.serialized);

        const tools = fixture.invocations.filter(entry => entry.argv).map(entry => entry.argv?.[2]);
        for (const name of ["qemuImg", "genisoimage", "mformat", "mcopy"])
            assert.ok(tools.includes(fixture.request.toolchain[name].path), name);
    });

    it("hands the launcher seam the reservation the budget granted and spawns no native process", async () => {
        const fixture = await createWindowsMsiScenario0CalibrationFixture();
        assert.equal(fixture.launcherCalls.length, 1);
        const reservation = fixture.launcherCalls[0];
        assert.equal(reservation.label, SCENARIO0_CALIBRATION_RESERVATION_LABEL);
        assert.equal(reservation.executionMilliseconds, SCENARIO0_CALIBRATION_MAX_EXECUTION_MILLISECONDS);
        assert.equal(reservation.cleanupMilliseconds, SCENARIO0_CALIBRATION_MAX_CLEANUP_MILLISECONDS);
        assert.deepEqual(fixture.result.timing.reservation, reservation);
        for (const invocation of fixture.invocations)
            if (invocation.options) assert.ok(invocation.options.timeoutMs
                <= fixture.request.limits.commandMilliseconds);
    });

    it("parses the retained raw guest result instead of a separately supplied projection", async () => {
        const fixture = await createWindowsMsiScenario0CalibrationFixture();

        /*
         * The exact defect this path was rejected for: substitute the raw bytes for an empty object and
         * recompute both digests. Nothing about the hashes is wrong afterwards, so only a consumer that
         * replays the guest semantics from those bytes can still refuse it.
         */
        const substituted = structuredClone(fixture.result);
        substituted.rowProof.guestResult = {path: fixture.request.row.guestResultPath, ...retain({})};
        substituted.rowProof.guestResultSha256 = substituted.rowProof.guestResult.sha256;
        assert.throws(() => validateCompletedWindowsMsiScenario0CalibrationResult(substituted, fixture.request),
            /guest semantic result/u);

        const withProjection = structuredClone(fixture.result);
        withProjection.rowProof.guestResult.parsed = {status: "completed", matrixPassed: true};
        assert.throws(() => validateCompletedWindowsMsiScenario0CalibrationResult(withProjection, fixture.request),
            /retained guest result keys differ/u);

        const movedPath = structuredClone(fixture.result);
        movedPath.rowProof.guestResult.path = `${fixture.request.row.rowRoot}/elsewhere.json`;
        assert.throws(() => validateCompletedWindowsMsiScenario0CalibrationResult(movedPath, fixture.request),
            /guest result binding differs/u);
    });

    it("rejects tampered guest bytes, stale digests and a guest row that did not pass", async () => {
        const fixture = await createWindowsMsiScenario0CalibrationFixture();

        const tampered = structuredClone(fixture.result);
        const raw = Buffer.from(tampered.rowProof.guestResult.bytesBase64, "base64");
        raw[raw.length - 2] ^= 0xff;
        tampered.rowProof.guestResult.bytesBase64 = raw.toString("base64");
        assert.throws(() => validateCompletedWindowsMsiScenario0CalibrationResult(tampered, fixture.request),
            /retained guest result identity differs/u);

        const failed = JSON.parse(fixture.guestResultBytes.toString("utf8"));
        failed.matrixPassed = false;
        failed.status = "failed";
        failed.rowResult.rowPassed = false;
        failed.rowResult.status = "failed";
        const rewritten = structuredClone(fixture.result);
        rewritten.rowProof.guestResult = {path: fixture.request.row.guestResultPath, ...retain(failed)};
        rewritten.rowProof.guestResultSha256 = rewritten.rowProof.guestResult.sha256;
        assert.throws(() => validateCompletedWindowsMsiScenario0CalibrationResult(rewritten, fixture.request),
            /guest semantic result/u);

        const staleDigest = structuredClone(fixture.result);
        staleDigest.rowProof.guestResultSha256 = "0".repeat(64);
        assert.throws(() => validateCompletedWindowsMsiScenario0CalibrationResult(staleDigest, fixture.request),
            /guest result hash differs/u);
    });

    it("checks every overlay, media, launch and cross-bound digest in the row proof", async () => {
        const fixture = await createWindowsMsiScenario0CalibrationFixture();
        const reject = (mutate, pattern) => {
            const mutated = structuredClone(fixture.result);
            mutate(mutated);
            assert.throws(() => validateCompletedWindowsMsiScenario0CalibrationResult(mutated, fixture.request),
                pattern);
        };
        reject(value => { value.rowProof.overlay.backingBaseSha256 = "0".repeat(64); }, /overlay differs/u);
        reject(value => { value.rowProof.overlay.path = "/tmp/elsewhere.qcow2"; }, /overlay differs/u);
        reject(value => { value.rowProof.overlayReceiptSha256 = "0".repeat(64); }, /launch binding differs/u);
        reject(value => { value.rowProof.media.seed.volumeLabel = "OTHER"; }, /seed ISO differs/u);
        reject(value => { value.rowProof.media.outputBefore.bytes = "1024"; }, /output disk differs/u);
        reject(value => { value.rowProof.media.outputAfter.sha256 = "0".repeat(64); },
            /output disk proof differs/u);
        reject(value => { value.rowProof.outputAfterSha256 = "0".repeat(64); }, /output disk proof differs/u);
        reject(value => { value.rowProof.qemu.argv = [...value.rowProof.qemu.argv, "-snapshot"]; },
            /QEMU invocation differs/u);
        reject(value => { value.rowProof.qemuLaunchSha256 = "0".repeat(64); }, /launch binding differs/u);
        reject(value => { value.rowProof.rowRequestSha256 = "0".repeat(64); }, /retained inputs differ/u);
        reject(value => { value.rowProof.executionManifestSha256 = "0".repeat(64); }, /retained inputs differ/u);
    });

    it("rejects an incomplete or unproven QEMU launch record", async () => {
        const fixture = await createWindowsMsiScenario0CalibrationFixture();
        for (const [name, value] of [["exitCode", 1], ["signal", "SIGTERM"], ["timedOut", true],
            ["cleanupProven", false], ["treeGone", false], ["qemuPidAbsentAfter", false]]) {
            const mutated = structuredClone(fixture.result);
            mutated.rowProof.qemu[name] = value;
            assert.throws(() => validateCompletedWindowsMsiScenario0CalibrationResult(mutated, fixture.request),
                /QEMU (?:row did not stop cleanly|exit differs|execution proof differs)/u);
        }
        const absent = structuredClone(fixture.result);
        delete absent.rowProof.qemu.qemuPidAbsentAfter;
        assert.throws(() => validateCompletedWindowsMsiScenario0CalibrationResult(absent, fixture.request),
            /QEMU result keys differ/u);
        for (const name of ["pid", "processGroupId"]) {
            const zeroed = structuredClone(fixture.result);
            zeroed.rowProof.qemu[name] = 0;
            assert.throws(() => validateCompletedWindowsMsiScenario0CalibrationResult(zeroed, fixture.request),
                /QEMU/u);
        }
    });

    it("carries authentic process identity out of the launcher rather than a default", async () => {
        const proven = await createWindowsMsiScenario0CalibrationFixture();
        assert.equal(proven.result.rowProof.qemu.qemuPidAbsentAfter, true);
        assert.equal(proven.result.rowProof.qemu.pid, 4242);

        for (const monitoredProcess of [{qemuPidAbsentAfter: false}, {treeGone: false},
            {qemuPid: undefined}, {qemuStartTicks: undefined}]) {
            await assert.rejects(() => createWindowsMsiScenario0CalibrationFixture({monitoredProcess}),
                error => error instanceof WindowsMsiScenario0CalibrationRunError);
        }
    });

    it("never lets a caller flag or a returned call authorize deletion", async () => {
        const rowRootOf = fixture => fixture.request.row.rowRoot;
        const present = fixture => [...fixture.disk.entries.keys(), ...fixture.disk.directories]
            .some(name => name === rowRootOf(fixture) || name.startsWith(`${rowRootOf(fixture)}/`));

        /*
         * Four ways a row can end without proof that its QEMU is gone. None of them may delete the
         * task state a later authenticated cleanup still needs, and a forged caller flag changes none
         * of the four: the authority is the recorded process identity, never the argument.
         */
        for (const monitoredProcess of [{treeGone: false}, {qemuPidAbsentAfter: false},
            {cleanupProven: false}]) {
            const fixture = await createWindowsMsiScenario0CalibrationFixture({run: false, monitoredProcess});
            const row = fixture.request.row;
            const overlay = await fixture.operations.createOverlay({row});
            const media = await fixture.operations.prepareMedia({row});
            await assert.rejects(() => fixture.operations.launchRow({row, overlay, media,
                reservation: fixture.request.reservation}), /QEMU/u);
            assert.deepEqual(await fixture.operations.cleanupRow({row, groupZero: true}),
                {groupZeroBeforeRemoval: false, removed: false});
            assert.equal(present(fixture), true);
        }

        const exploded = await createWindowsMsiScenario0CalibrationFixture({run: false,
            runQemu: async () => { throw new Error("launcher refused the reservation"); }});
        const row = exploded.request.row;
        const overlay = await exploded.operations.createOverlay({row});
        const media = await exploded.operations.prepareMedia({row});
        await assert.rejects(() => exploded.operations.launchRow({row, overlay, media,
            reservation: exploded.request.reservation}), /launcher refused the reservation/u);
        assert.deepEqual(await exploded.operations.cleanupRow({row, groupZero: true, launchAttempted: true}),
            {groupZeroBeforeRemoval: false, removed: false});
        assert.equal(present(exploded), true);
    });

    it("builds the published-provenance activation handoff from the calibration request", async () => {
        const fixture = await createWindowsMsiScenario0CalibrationFixture({publishedProvenance: true});
        const handoff = fixture.result.rowProof.media.seed.activationHandoffSha256;
        assert.match(handoff, /^[0-9a-f]{64}$/u);
        assert.equal(validateCompletedWindowsMsiScenario0CalibrationResult(fixture.serialized,
            fixture.request), fixture.serialized);
    });

    it("removes exactly the files it owns when the row failed before any launch", async () => {
        const fixture = await createWindowsMsiScenario0CalibrationFixture({run: false});
        const row = fixture.request.row;
        await fixture.operations.createOverlay({row});
        await fixture.operations.prepareMedia({row});
        assert.deepEqual(await fixture.operations.cleanupRow({row}),
            {groupZeroBeforeRemoval: false, removed: true});
        assert.equal(fixture.disk.entries.has(row.overlayPath), false);
        assert.equal(fixture.disk.directories.has(row.rowRoot), false);

        const stray = await createWindowsMsiScenario0CalibrationFixture({run: false});
        const strayRow = stray.request.row;
        await stray.operations.createOverlay({row: strayRow});
        const overlay = stray.disk.entries.get(strayRow.overlayPath).sha256;
        stray.disk.place(`${strayRow.rowRoot}/unexpected.bin`, Buffer.from("stray"));
        await assert.rejects(() => stray.operations.cleanupRow({row: strayRow}), /unexpected entry/u);
        assert.equal(stray.disk.entries.has(`${strayRow.rowRoot}/unexpected.bin`), true);
        assert.equal(stray.disk.entries.get(strayRow.overlayPath).sha256, overlay);
    });

    it("removes the owned row once the recorded process proves group zero", async () => {
        const fixture = await createWindowsMsiScenario0CalibrationFixture();
        assert.deepEqual(fixture.result.rowProof.overlayCleanup,
            {groupZeroBeforeRemoval: true, removed: true});
        assert.equal(fixture.disk.directories.has(fixture.request.row.rowRoot), false);
        assert.equal([...fixture.disk.entries.keys()]
            .some(name => name.startsWith(`${fixture.request.row.rowRoot}/`)), false);
    });

    it("shares one budget across the factory and the runner and refuses an unbound runner", async () => {
        const fixture = await createWindowsMsiScenario0CalibrationFixture();
        assert.equal(typeof fixture.operations.budget, "object");
        await assert.rejects(() => runWindowsMsiScenario0Calibration(fixture.request,
            {...fixture.operations, budget: undefined}), /budget/u);

        const observation = fixture.result.timing.budget;
        assert.equal(observation.kind, SCENARIO0_CALIBRATION_BUDGET_KIND);
        assert.equal(observation.status, "completed");
        assert.equal(observation.exhausted, false);
        assert.equal(observation.jobBudgetMilliseconds, SCENARIO0_CALIBRATION_MAX_JOB_MILLISECONDS);
        assert.equal(observation.wallDeadlineUnixMilliseconds, fixture.request.wallDeadlineUnixMilliseconds);
        assert.ok(observation.elapsedMilliseconds >= fixture.result.timing.observedDurationMilliseconds);
        assert.ok(observation.remainingMilliseconds >= SCENARIO0_CALIBRATION_RETENTION_RESERVE_MILLISECONDS);
    });

    it("charges setup, preparation, launch, extraction and cleanup to the same deadline", async () => {
        const exhaustedBySetup = await createWindowsMsiScenario0CalibrationFixture({run: false});
        exhaustedBySetup.advance(SCENARIO0_CALIBRATION_MAX_JOB_MILLISECONDS - (10 * MINUTE));
        await assert.rejects(() => runWindowsMsiScenario0Calibration(exhaustedBySetup.request,
            exhaustedBySetup.operations), error => {
            assert.ok(error instanceof WindowsMsiScenario0CalibrationRunError);
            assert.equal(error.progress.kind, SCENARIO0_CALIBRATION_PROGRESS_KIND);
            assert.equal(error.progress.status, "budget-exhausted");
            assert.equal(error.progress.budget.exhausted, true);
            return true;
        });
        assert.equal(exhaustedBySetup.launcherCalls.length, 0);

        /*
         * A launch that overran leaves the job with less than the retention reserve. Finishing the
         * document would spend the time the evidence upload needs, so the run stops with a budget
         * observation instead of a completed result.
         */
        const overran = await createWindowsMsiScenario0CalibrationFixture({run: false,
            dependencies: {}});
        const original = overran.operations.launchRow;
        overran.operations.launchRow = async input => {
            const launch = await original(input);
            overran.advance(SCENARIO0_CALIBRATION_MAX_JOB_MILLISECONDS - (5 * MINUTE));
            return launch;
        };
        await assert.rejects(() => runWindowsMsiScenario0Calibration(overran.request, overran.operations),
            error => error instanceof WindowsMsiScenario0CalibrationRunError
                && error.progress.status === "budget-exhausted");
    });

    it("bounds every blocking command by the remaining phase allowance", async () => {
        const fixture = await createWindowsMsiScenario0CalibrationFixture({run: false});
        await fixture.operations.inspectBase({phase: "before"});
        assert.equal(fixture.invocations[0].options.timeoutMs, fixture.request.limits.commandMilliseconds);

        const reserves = SCENARIO0_CALIBRATION_MAX_CLEANUP_MILLISECONDS
            + SCENARIO0_CALIBRATION_RETENTION_RESERVE_MILLISECONDS;
        fixture.advance(SCENARIO0_CALIBRATION_MAX_JOB_MILLISECONDS - reserves - 30_000);
        fixture.invocations.length = 0;
        await fixture.operations.inspectBase({phase: "before"});
        assert.ok(fixture.invocations[0].options.timeoutMs <= 30_000);

        fixture.advance(30_000);
        await assert.rejects(() => fixture.operations.inspectBase({phase: "before"}), /budget/u);

        /*
         * The closing inspection is still affordable at the same instant the execution phase is not:
         * it spends what cleanup may spend, and only the retention reserve is held back from it.
         */
        const closing = await createWindowsMsiScenario0CalibrationFixture({run: false});
        closing.advance(SCENARIO0_CALIBRATION_MAX_JOB_MILLISECONDS
            - SCENARIO0_CALIBRATION_RETENTION_RESERVE_MILLISECONDS - 30_000);
        await assert.rejects(() => closing.operations.inspectBase({phase: "before"}), /budget/u);
        assert.equal((await closing.operations.inspectBase({phase: "after"})).sealedReadOnly, true);
    });

    it("stops on the wall deadline even when little monotonic time has passed", async () => {
        const fixture = await createWindowsMsiScenario0CalibrationFixture({run: false});
        fixture.clock.wall = fixture.request.wallDeadlineUnixMilliseconds - 1_000;
        await assert.rejects(() => runWindowsMsiScenario0Calibration(fixture.request, fixture.operations),
            error => error instanceof WindowsMsiScenario0CalibrationRunError
                && error.progress.status === "budget-exhausted");
    });

    it("rejects invalid budget, deadline and reservation values in the request", async () => {
        const fixture = await createWindowsMsiScenario0CalibrationFixture({run: false});
        const reject = (mutate, pattern) => {
            const mutated = structuredClone(fixture.request);
            mutate(mutated);
            assert.throws(() => validateWindowsMsiScenario0CalibrationRequest(mutated), pattern);
        };
        reject(value => { value.limits.jobBudgetMilliseconds = -1; }, /job budget/u);
        reject(value => { value.limits.jobBudgetMilliseconds = 1.5; }, /job budget/u);
        reject(value => { value.limits.jobBudgetMilliseconds = Number.MAX_SAFE_INTEGER; }, /job budget/u);
        reject(value => { value.limits.maxExecutionMilliseconds
            = SCENARIO0_CALIBRATION_MAX_EXECUTION_MILLISECONDS + 1; }, /max execution/u);
        reject(value => { value.limits.maxCleanupMilliseconds
            = SCENARIO0_CALIBRATION_MAX_CLEANUP_MILLISECONDS + 1; }, /max cleanup/u);
        reject(value => { value.wallDeadlineUnixMilliseconds = 0; }, /wall deadline/u);
        reject(value => { value.wallDeadlineUnixMilliseconds = 1.5; }, /wall deadline/u);
        reject(value => { delete value.wallDeadlineUnixMilliseconds; }, /request keys differ/u);
        reject(value => { value.reservation.executionMilliseconds = value.limits.jobBudgetMilliseconds; },
            /execution reservation/u);
        reject(value => { value.reservation.label = "other"; }, /reservation label differs/u);
    });

    it("rejects a completed result whose budget observation or reservation is not bound to the request",
        async () => {
            const fixture = await createWindowsMsiScenario0CalibrationFixture();
            const reject = (mutate, pattern) => {
                const mutated = structuredClone(fixture.result);
                mutate(mutated);
                assert.throws(() =>
                    validateCompletedWindowsMsiScenario0CalibrationResult(mutated, fixture.request), pattern);
            };
            reject(value => { value.timing.budget.exhausted = true; }, /budget observation differs/u);
            reject(value => { value.timing.budget.status = "failed"; }, /budget observation differs/u);
            reject(value => { value.timing.budget.remainingMilliseconds = 1_000; },
                /budget observation differs/u);
            reject(value => { value.timing.budget.wallDeadlineUnixMilliseconds = 1; },
                /budget observation differs/u);
            reject(value => { value.timing.budget.elapsedMilliseconds = 0; }, /budget observation differs/u);
            reject(value => { value.timing.reservation.label = "other"; }, /reservation differs/u);
            reject(value => {
                value.timing.reservation.executionMilliseconds
                    = SCENARIO0_CALIBRATION_MAX_EXECUTION_MILLISECONDS + 1;
            }, /reservation/u);
            reject(value => { value.timing.observedDurationMilliseconds = 0; }, /observed duration/u);
            reject(value => {
                value.timing.completedMonotonicMilliseconds
                    = value.timing.startedMonotonicMilliseconds + 500;
            }, /timing interval recomputation differs/u);
        });

    it("retains a typed nonqualifying progress document when the row fails", async () => {
        const fixture = await createWindowsMsiScenario0CalibrationFixture({run: false});
        const failing = {...fixture.operations,
            launchRow: async () => { throw new Error("Simulated QEMU launch refusal"); }};
        await assert.rejects(() => runWindowsMsiScenario0Calibration(fixture.request, failing), error => {
            assert.ok(error instanceof WindowsMsiScenario0CalibrationRunError);
            assert.equal(error.progress.kind, SCENARIO0_CALIBRATION_PROGRESS_KIND);
            assert.equal(error.progress.status, "failed");
            assert.equal(error.progress.qualifying, false);
            assert.equal(error.progress.scenarioIndex, 0);
            assert.ok(JSON.stringify(error.progress).includes("Simulated QEMU launch refusal"));
            return true;
        });
    });

    it("keeps the calibration artifact and the fourteen-row artifact mutually unacceptable", async () => {
        const fullFixture = await createWindowsMsiLifecycleHostEvidenceFixture();
        const calibration = await createWindowsMsiScenario0CalibrationFixture();
        assert.throws(() =>
            validateCompletedWindowsMsiLifecycleHostResult(calibration.result, fullFixture.request),
        /MSI lifecycle host result keys differ/u);
        assert.throws(() =>
            validateCompletedWindowsMsiScenario0CalibrationResult(fullFixture.result, calibration.request),
        /MSI scenario0 calibration result keys differ/u);
    });

    it("refuses an operations set that is missing a member or its budget", async () => {
        const fixture = await createWindowsMsiScenario0CalibrationFixture({run: false});
        await assert.rejects(() => runWindowsMsiScenario0Calibration(fixture.request,
            {...fixture.operations, cleanupRow: undefined}), /operation/u);
        assert.throws(() => createWindowsMsiScenario0CalibrationOperations({request: fixture.request,
            dependencies: {deriveActualContext: () => ({...fixture.request.context, nonce: "0".repeat(32)})}}),
        /actual hosted context differs/u);
    });
});

const seedFile = (name, overrides = {}) => ({name, sourcePath: "/opt/myspeed/closure/node.exe",
    bytes: "85268464", sha256: "b".repeat(64), ...overrides});

describe("Windows MSI Scenario 0 calibration seed paths and cleanup preflight", () => {
    /*
     * The seed file set is the one part of the request that names paths the host then interpolates
     * into the seed root, so an unvalidated entry is a write primitive. The fourteen-row validator has
     * always bounded it; the calibration only looked two names up in it.
     */
    it("refuses a seed file name that escapes the seed root, before anything is written", async () => {
        const fixture = await createWindowsMsiScenario0CalibrationFixture({compose: false,
            extraSeedFiles: [{name: "../../outside-proof.txt", sourcePath: "/inert/source", bytes: "1",
                sha256: "a".repeat(64)}]});
        assert.throws(() => validateWindowsMsiScenario0CalibrationRequest(fixture.request),
            /seed file name differs/u);
        assert.throws(() => createWindowsMsiScenario0CalibrationOperations({request: fixture.request}),
            /seed file name differs/u);
        assert.deepEqual([...fixture.disk.directories]
            .filter(name => name.startsWith(fixture.request.row.rowRoot)), []);
        assert.deepEqual([...fixture.disk.entries.keys()]
            .filter(name => name.startsWith(`${fixture.request.row.rowRoot}/`)), []);
    });

    it("refuses a seed entry whose shape, length, digest or uniqueness differs", async () => {
        const cases = [
            [[seedFile("extra.txt", {mode: "600"})], /seed file keys differ/u],
            [[seedFile("empty.txt", {bytes: "0"})], /seed bytes differs/u],
            [[seedFile("digest.txt", {sha256: "not-a-digest"})], /seed SHA-256 differs/u],
            [[seedFile("node.exe")], /seed file is duplicated/u],
            [[seedFile("tools"), seedFile("tools/inner.txt")], /seed file is duplicated/u],
            [[seedFile("/absolute.txt")], /seed file name differs/u],
            [[seedFile("nested/../escape.txt")], /seed file name differs/u]
        ];
        for (const [extraSeedFiles, expected] of cases) {
            const fixture = await createWindowsMsiScenario0CalibrationFixture({compose: false,
                extraSeedFiles});
            assert.throws(() => validateWindowsMsiScenario0CalibrationRequest(fixture.request), expected,
                extraSeedFiles.map(entry => entry.name).join());
        }
    });

    it("refuses a seed file that collides with a document the host itself generates", async () => {
        for (const name of ["seed-manifest.json", "bootstrap.ps1", "myspeed-msi-handoff.json",
            "row-request.json", "execution-manifest.json", "matrix-envelope.json", "launch-request.json",
            "seed-manifest.json/nested.txt", "myspeed-msi-handoff.json/nested.txt"]) {
            const fixture = await createWindowsMsiScenario0CalibrationFixture({compose: false,
                extraSeedFiles: [seedFile(name)]});
            assert.throws(() => validateWindowsMsiScenario0CalibrationRequest(fixture.request),
                /seed file is reserved/u, name);
        }
    });

    it("prepares seed media with canonical seed-manifest.json and myspeed-msi-handoff.json matching guest contract", async () => {
        const fixture = await createWindowsMsiScenario0CalibrationFixture({publishedProvenance: true, run: false});
        const row = fixture.request.row;
        await fixture.operations.createOverlay({row});
        await fixture.operations.prepareMedia({row});

        // Canonical names must exist; legacy/reverted names must NOT exist
        assert.equal(fixture.disk.entries.has(`${row.seedRoot}/seed-manifest.json`), true);
        assert.equal(fixture.disk.entries.has(`${row.seedRoot}/seed.json`), false);
        assert.equal(fixture.disk.entries.has(`${row.seedRoot}/myspeed-msi-handoff.json`), true);
        assert.equal(fixture.disk.entries.has(`${row.seedRoot}/activation-handoff.json`), false);
        assert.equal(fixture.disk.entries.has(`${row.seedRoot}/bootstrap.ps1`), true);

        // Manifest content and binding
        const manifestRecord = fixture.disk.entries.get(`${row.seedRoot}/seed-manifest.json`);
        const manifest = JSON.parse(manifestRecord.content.toString("utf8"));
        assert.equal(manifest.sourceSha, fixture.request.sourceSha);
        assert.equal(manifest.hostNonce, fixture.request.nonce);
        assert.equal(manifest.rowNonce, row.nonce);
        assert.equal(manifest.scenarioIndex, 0);
        assert.equal(manifest.scenarioId, "clean-default");

        // Bootstrap script must bind seed-manifest.json hash
        const bootstrapRecord = fixture.disk.entries.get(`${row.seedRoot}/bootstrap.ps1`);
        const bootstrapText = bootstrapRecord.content.toString("utf8");
        const manifestSha256 = sha256(manifestRecord.content);
        assert.ok(bootstrapText.includes(manifestSha256), "bootstrap must bind seed-manifest sha256");
        assert.ok(bootstrapText.includes("seed-manifest.json"), "bootstrap must target seed-manifest.json");
        assert.ok(!bootstrapText.includes("'seed.json'"), "bootstrap must not target seed.json");

        // Published handoff content and dispatcher compatibility
        const handoffRecord = fixture.disk.entries.get(`${row.seedRoot}/myspeed-msi-handoff.json`);
        const handoff = JSON.parse(handoffRecord.content.toString("utf8"));
        assert.equal(handoff.schemaVersion, 1);
        assert.equal(handoff.kind, "myspeed-windows-msi-setupcomplete-handoff");
        assert.equal(handoff.bootstrap.name, "bootstrap.ps1");
        assert.equal(handoff.bootstrap.sha256, sha256(bootstrapRecord.content));
        assert.equal(handoff.row.scenarioIndex, 0);
        assert.equal(handoff.row.scenarioId, "clean-default");

        // Guest SetupComplete dispatcher candidate filenames check
        const guestCandidateFilenames = [
            "myspeed-base-calibration-handoff.json",
            "myspeed-msi-handoff.json",
            "myspeed-baseline-cpu-handoff.json"
        ];
        const matchingHandoffs = guestCandidateFilenames.filter(name =>
            fixture.disk.entries.has(`${row.seedRoot}/${name}`));
        assert.equal(matchingHandoffs.length, 1);
        assert.equal(matchingHandoffs[0], "myspeed-msi-handoff.json");

        // Prove reverted names fail the guest contract
        const revertedBootstrapTarget = "seed.json";
        assert.ok(!bootstrapText.includes(revertedBootstrapTarget), "reverted seed.json must not be targeted");
        const revertedHandoffNames = ["activation-handoff.json"];
        const revertedMatches = revertedHandoffNames.filter(name =>
            guestCandidateFilenames.includes(name));
        assert.equal(revertedMatches.length, 0, "reverted activation-handoff.json is not recognized by guest dispatcher");
    });

    /*
     * `mkdirSync(parent, {recursive: true})` creates ancestors the task never records, and cleanup
     * then cannot empty the seed root it did record. Every level is created and owned explicitly.
     */
    it("creates and owns every ancestor of a nested seed path without a recursive mkdir", async () => {
        const fixture = await createWindowsMsiScenario0CalibrationFixture({extraSeedFiles: [
            seedFile("tools/inner/helper.txt"), seedFile("tools/inner/second.txt"),
            seedFile("tools/sibling.txt")]});
        assert.equal(fixture.result.status, "completed");
        assert.deepEqual(fixture.disk.mkdirCalls.filter(call => call.options?.recursive === true), []);
        assert.deepEqual(fixture.result.rowProof.overlayCleanup,
            {groupZeroBeforeRemoval: true, removed: true});
        assert.deepEqual([...fixture.disk.directories]
            .filter(name => name.startsWith(fixture.request.row.rowRoot)), []);
        assert.deepEqual([...fixture.disk.entries.keys()]
            .filter(name => name.startsWith(`${fixture.request.row.rowRoot}/`)), []);
    });

    /*
     * Cleanup used to unlink the whole owned inventory and only then discover the unexpected entry
     * while removing directories, by which point the overlay, the serial log and the guest result were
     * already gone. The inventory is now read before the first unlink.
     */
    it("keeps every recorded file byte-identical when an unexpected entry appears", async () => {
        const strays = [
            ["file", (disk, row) => disk.place(`${row.rowRoot}/unexpected.bin`, Buffer.from("stray"))],
            ["directory", (disk, row) => disk.filesystem.mkdirSync(`${row.seedRoot}/unexpected-directory`)],
            ["symlink", (disk, row) => disk.placeSymlink(`${row.rowRoot}/unexpected-link`)]
        ];
        for (const [label, stray] of strays) {
            const fixture = await createWindowsMsiScenario0CalibrationFixture({run: false,
                afterLaunch: stray});
            const row = fixture.request.row;
            const snapshot = () => new Map([...fixture.disk.entries]
                .filter(([name]) => name.startsWith(`${row.rowRoot}/`))
                .map(([name, entry]) => [name, entry.sha256]));
            let before = null;
            const error = await runWindowsMsiScenario0Calibration(fixture.request,
                {...fixture.operations,
                    cleanupRow: async input => {
                        before ??= snapshot();
                        return fixture.operations.cleanupRow(input);
                    }}).then(() => null, value => value);

            assert.ok(error instanceof WindowsMsiScenario0CalibrationRunError, label);
            assert.match(error.message, /unexpected entry/u, label);
            assert.ok(before.has(row.overlayPath) && before.has(row.serialLogPath)
                && before.has(row.guestResultPath), label);
            assert.deepEqual(snapshot(), before, label);
            assert.equal(fixture.disk.directories.has(row.rowRoot), true, label);
        }
    });

    it("refuses a substituted row root before it can inspect or remove owned paths", async () => {
        for (const [label, replace] of [
            ["symlink", (disk, row) => disk.replaceSymlink(row.rowRoot)],
            ["different directory", (disk, row) => disk.replaceDirectory(row.rowRoot)]
        ]) {
            const fixture = await createWindowsMsiScenario0CalibrationFixture({run: false});
            const row = fixture.request.row;
            await fixture.operations.createOverlay({row});
            await fixture.operations.prepareMedia({row});
            const before = new Map([...fixture.disk.entries]
                .filter(([name]) => name.startsWith(`${row.rowRoot}/`))
                .map(([name, entry]) => [name, entry.sha256]));
            replace(fixture.disk, row);

            await assert.rejects(() => fixture.operations.cleanupRow({row}), /directory identity differs/u,
                label);
            assert.deepEqual(new Map([...fixture.disk.entries]
                .filter(([name]) => name.startsWith(`${row.rowRoot}/`))
                .map(([name, entry]) => [name, entry.sha256])), before, label);
        }
    });
});
