import assert from "node:assert/strict";
import {describe, it} from "node:test";

import {admitWindowsMsiLifecycleSetup, chargeWindowsMsiContainmentPreflight,
    createWindowsMsiContainmentPreflightReservation, createWindowsMsiLifecycleBudget,
    validateWindowsMsiLifecycleBudgetLimits, validateWindowsMsiLifecycleJobBudget,
    WINDOWS_MSI_CONTAINMENT_PREFLIGHT_RESERVATION, WINDOWS_MSI_LIFECYCLE_BUDGET,
    WINDOWS_MSI_LIFECYCLE_JOB_LIMITS, WindowsMsiContainmentPreflightBudgetError,
    WindowsMsiLifecycleAdmissionError} from
    "../../scripts/qualification/windows-msi-lifecycle-budget.mjs";

const MINUTE = 60_000;
const SCENARIO_COUNT = 14;

const limits = (overrides = {}) => ({jobBudgetMilliseconds: 300 * MINUTE,
    rowAllowanceMilliseconds: 15 * MINUTE, rowCleanupMarginMilliseconds: 2 * MINUTE,
    finalMarginMilliseconds: 10 * MINUTE, ...overrides});

const clock = start => {
    const state = {now: start};
    return {state, monotonicMilliseconds: () => state.now};
};

describe("Windows MSI lifecycle total-budget admission", () => {
    it("publishes the hosted job limit it refuses to exceed", () => {
        assert.equal(WINDOWS_MSI_LIFECYCLE_BUDGET.hostedJobLimitMilliseconds, 6 * 60 * MINUTE);
        assert.equal(WINDOWS_MSI_LIFECYCLE_BUDGET.scenarioCount, SCENARIO_COUNT);
        assert.equal(WINDOWS_MSI_LIFECYCLE_BUDGET.rowDeadlineMilliseconds, 16_200_000);
    });

    /*
     * The per-row QEMU deadline is a maximum, not a duration. Fourteen of them is sixty-three hours,
     * which no hosted job can hold, so an allowance that is merely "the deadline" has to be refused
     * rather than silently multiplied into a plan nobody measured.
     */
    it("refuses limits that cannot hold a single row or that exceed the hosted job limit", () => {
        assert.deepEqual(validateWindowsMsiLifecycleBudgetLimits(limits()), limits());
        for (const overrides of [{jobBudgetMilliseconds: 6 * 60 * MINUTE + 1},
            {rowAllowanceMilliseconds: WINDOWS_MSI_LIFECYCLE_BUDGET.rowDeadlineMilliseconds + 1},
            {rowAllowanceMilliseconds: 0}, {jobBudgetMilliseconds: 11 * MINUTE},
            {rowCleanupMarginMilliseconds: 0}, {finalMarginMilliseconds: 0},
            {jobBudgetMilliseconds: 2.5}, {rowAllowanceMilliseconds: "900000"}])
            assert.throws(() => validateWindowsMsiLifecycleBudgetLimits(limits(overrides)),
                /budget/i, JSON.stringify(overrides));
        assert.throws(() => validateWindowsMsiLifecycleBudgetLimits({...limits(), extra: 1}), /budget/i);
    });

    it("admits a row only while the remaining budget still covers cleanup and the final margin", () => {
        const {state, monotonicMilliseconds} = clock(5_000);
        const budget = createWindowsMsiLifecycleBudget({
            limits: limits({jobBudgetMilliseconds: 120 * MINUTE}), monotonicMilliseconds});
        for (let index = 0; index < 7; index += 1) {
            budget.admitRow(index);
            state.now += 15 * MINUTE;
            budget.completeRow(index);
        }
        /*
         * 120 minutes of budget, 15 minutes observed per row and a 27-minute requirement per row:
         * after seven rows only 15 minutes remain, so the eighth cannot be guaranteed its cleanup
         * margin and is refused before it starts rather than half way through.
         */
        assert.throws(() => budget.admitRow(7), WindowsMsiLifecycleAdmissionError);
    });

    it("charges observed time rather than the allowance", () => {
        const {state, monotonicMilliseconds} = clock(0);
        const budget = createWindowsMsiLifecycleBudget({
            limits: limits({jobBudgetMilliseconds: 60 * MINUTE}), monotonicMilliseconds});
        budget.admitRow(0);
        state.now += 40 * MINUTE;
        budget.completeRow(0);
        assert.throws(() => budget.admitRow(1), WindowsMsiLifecycleAdmissionError);
        const sealed = budget.seal();
        assert.equal(sealed.rowsAdmitted, 1);
        assert.equal(sealed.rowsCompleted, 1);
        assert.deepEqual(sealed.rows,
            [{scenarioIndex: 0, observedMilliseconds: 40 * MINUTE, overranAllowance: true}]);
        assert.equal(sealed.elapsedMilliseconds, 40 * MINUTE);
        assert.equal(sealed.remainingMilliseconds, 20 * MINUTE);
        assert.equal(sealed.exhausted, true);
    });

    it("reports the refusal as typed, bounded progress instead of an opaque failure", () => {
        const {state, monotonicMilliseconds} = clock(1_000);
        const budget = createWindowsMsiLifecycleBudget({
            limits: limits({jobBudgetMilliseconds: 40 * MINUTE}), monotonicMilliseconds});
        budget.admitRow(0);
        state.now += 20 * MINUTE;
        budget.completeRow(0);
        let error = null;
        try { budget.admitRow(1); } catch (thrown) { error = thrown; }
        assert.ok(error instanceof WindowsMsiLifecycleAdmissionError);
        assert.equal(error.scenarioIndex, 1);
        assert.equal(error.requiredMilliseconds, 27 * MINUTE);
        assert.equal(error.remainingMilliseconds, 20 * MINUTE);
        assert.deepEqual(error.progress, {schemaVersion: 1,
            kind: "myspeed-windows-msi-lifecycle-budget-observation", qualifying: false,
            status: "budget-exhausted", refusedScenarioIndex: 1, scenarioCount: SCENARIO_COUNT,
            rowsAdmitted: 1, rowsCompleted: 1, rowsOverranAllowance: 1,
            rows: [{scenarioIndex: 0, observedMilliseconds: 20 * MINUTE, overranAllowance: true}],
            limits: limits({jobBudgetMilliseconds: 40 * MINUTE}), elapsedMilliseconds: 20 * MINUTE,
            remainingMilliseconds: 20 * MINUTE, requiredMilliseconds: 27 * MINUTE, exhausted: true,
            allowanceEnforced: false,
            enforcedRowDeadlineMilliseconds: WINDOWS_MSI_LIFECYCLE_BUDGET.rowDeadlineMilliseconds,
            releaseGatesCleared: []});
    });

    it("keeps admission ordered and refuses a reused or skipped row", () => {
        const {state, monotonicMilliseconds} = clock(0);
        const budget = createWindowsMsiLifecycleBudget({limits: limits(), monotonicMilliseconds});
        assert.throws(() => budget.admitRow(1), /matrix order/i);
        budget.admitRow(0);
        assert.throws(() => budget.admitRow(1), /not completed/i);
        assert.throws(() => budget.completeRow(1), /matrix order/i);
        state.now += MINUTE;
        budget.completeRow(0);
        assert.throws(() => budget.completeRow(0), /matrix order/i);
        assert.throws(() => budget.admitRow(0), /matrix order/i);
    });

    it("seals a completed matrix as a bounded observation with no gates cleared", () => {
        const {state, monotonicMilliseconds} = clock(500);
        const budget = createWindowsMsiLifecycleBudget({limits: limits(), monotonicMilliseconds});
        for (let index = 0; index < SCENARIO_COUNT; index += 1) {
            budget.admitRow(index);
            state.now += 12 * MINUTE;
            budget.completeRow(index);
        }
        const sealed = budget.seal();
        assert.equal(sealed.status, "completed");
        assert.equal(sealed.rowsCompleted, SCENARIO_COUNT);
        assert.equal(sealed.refusedScenarioIndex, null);
        assert.equal(sealed.exhausted, false);
        assert.equal(sealed.elapsedMilliseconds, SCENARIO_COUNT * 12 * MINUTE);
        assert.deepEqual(sealed.releaseGatesCleared, []);
        assert.equal(Object.isFrozen(sealed), true);
    });

    /*
     * The job the workflow declares stops at its `timeout-minutes`, not at the six-hour platform
     * limit, and the last minutes of that job belong to bounding and uploading the evidence. A
     * dispatch budget that reaches the timeout leaves nothing to retain the run with, so the
     * accepted maximum is the timeout minus an explicit retention reserve.
     */
    it("caps the dispatch budget below the job timeout by an explicit retention reserve", () => {
        assert.equal(WINDOWS_MSI_LIFECYCLE_JOB_LIMITS.jobTimeoutMilliseconds, 350 * MINUTE);
        assert.equal(WINDOWS_MSI_LIFECYCLE_JOB_LIMITS.retentionReserveMilliseconds, 10 * MINUTE);
        assert.equal(WINDOWS_MSI_LIFECYCLE_JOB_LIMITS.maximumDispatchBudgetMilliseconds, 340 * MINUTE);
        assert.equal(WINDOWS_MSI_LIFECYCLE_JOB_LIMITS.maximumDispatchBudgetMilliseconds,
            WINDOWS_MSI_LIFECYCLE_JOB_LIMITS.jobTimeoutMilliseconds
                - WINDOWS_MSI_LIFECYCLE_JOB_LIMITS.retentionReserveMilliseconds);
        assert.ok(WINDOWS_MSI_LIFECYCLE_JOB_LIMITS.jobTimeoutMilliseconds
            < WINDOWS_MSI_LIFECYCLE_BUDGET.hostedJobLimitMilliseconds);
        /* The planning limits themselves may never exceed that maximum either. */
        assert.throws(() => validateWindowsMsiLifecycleBudgetLimits(
            limits({jobBudgetMilliseconds: 340 * MINUTE + 1})), /retention reserve/i);
        assert.deepEqual(validateWindowsMsiLifecycleBudgetLimits(limits({jobBudgetMilliseconds: 340 * MINUTE})),
            limits({jobBudgetMilliseconds: 340 * MINUTE}));
    });

    it("validates the dispatched job budget against the declared timeout before any setup runs", () => {
        const job = {jobBudgetMilliseconds: 340 * MINUTE, jobTimeoutMilliseconds: 350 * MINUTE,
            retentionReserveMilliseconds: 10 * MINUTE};
        const validated = {...job, maximumJobBudgetMilliseconds: 340 * MINUTE};
        assert.deepEqual(validateWindowsMsiLifecycleJobBudget(job), validated);
        /* Revalidating its own output has to succeed, and has to recheck the derived maximum. */
        assert.deepEqual(validateWindowsMsiLifecycleJobBudget(validated), validated);
        assert.throws(() => validateWindowsMsiLifecycleJobBudget(
            {...validated, maximumJobBudgetMilliseconds: 339 * MINUTE}), /maximum differs/i);
        for (const overrides of [{jobBudgetMilliseconds: 341 * MINUTE},
            {jobTimeoutMilliseconds: 6 * 60 * MINUTE + 1}, {retentionReserveMilliseconds: 0},
            {jobBudgetMilliseconds: 0}, {jobBudgetMilliseconds: 1.5},
            {jobTimeoutMilliseconds: 340 * MINUTE}, {retentionReserveMilliseconds: 350 * MINUTE}])
            assert.throws(() => validateWindowsMsiLifecycleJobBudget({...job, ...overrides}),
                /budget|reserve|timeout/i, JSON.stringify(overrides));
        assert.throws(() => validateWindowsMsiLifecycleJobBudget({...job, extra: 1}), /budget/i);
    });

    /*
     * Setup - Stage 2 above all - is charged to the same job. A run whose setup left less than one
     * row with its margins has to stop before it seals an installed base it can never use, and the
     * refusal has to name the measured setup rather than a planning figure.
     */
    it("refuses the run when measured setup has consumed the budget", () => {
        const planning = {rowAllowanceMilliseconds: 15 * MINUTE, rowCleanupMarginMilliseconds: 2 * MINUTE,
            finalMarginMilliseconds: 10 * MINUTE};
        const job = validateWindowsMsiLifecycleJobBudget({jobBudgetMilliseconds: 340 * MINUTE,
            jobTimeoutMilliseconds: 350 * MINUTE, retentionReserveMilliseconds: 10 * MINUTE});
        assert.deepEqual(admitWindowsMsiLifecycleSetup({job, elapsedMilliseconds: 40 * MINUTE,
            limits: planning}), {...planning, jobBudgetMilliseconds: 300 * MINUTE});
        assert.deepEqual(admitWindowsMsiLifecycleSetup({job, elapsedMilliseconds: 313 * MINUTE,
            limits: planning}), {...planning, jobBudgetMilliseconds: 27 * MINUTE});
        for (const elapsed of [313 * MINUTE + 1, 340 * MINUTE, 340 * MINUTE + 1])
            assert.throws(() => admitWindowsMsiLifecycleSetup({job, elapsedMilliseconds: elapsed,
                limits: planning}), /budget/i, String(elapsed));
        for (const elapsed of [-1, 1.5, "0", null])
            assert.throws(() => admitWindowsMsiLifecycleSetup({job, elapsedMilliseconds: elapsed,
                limits: planning}), /setup/i, JSON.stringify(elapsed));
    });

    /*
     * The allowance is a planning figure. Nothing stops a row at it: the only deadline anything
     * enforces is the launcher's own 270-minute one, so the observation says so rather than letting
     * a consumer read the cleanup margin as a reserve that was held open.
     */
    it("records an overrunning row and never claims the allowance was enforced", () => {
        const {state, monotonicMilliseconds} = clock(0);
        const budget = createWindowsMsiLifecycleBudget({
            limits: limits({jobBudgetMilliseconds: 200 * MINUTE}), monotonicMilliseconds});
        budget.admitRow(0);
        state.now += 15 * MINUTE;
        budget.completeRow(0);
        budget.admitRow(1);
        state.now += 15 * MINUTE + 1;
        budget.completeRow(1);
        const sealed = budget.seal();
        assert.equal(sealed.allowanceEnforced, false);
        assert.equal(sealed.enforcedRowDeadlineMilliseconds,
            WINDOWS_MSI_LIFECYCLE_BUDGET.rowDeadlineMilliseconds);
        assert.equal(sealed.rowsOverranAllowance, 1);
        assert.deepEqual(sealed.rows, [{scenarioIndex: 0, observedMilliseconds: 15 * MINUTE,
            overranAllowance: false},
        {scenarioIndex: 1, observedMilliseconds: 15 * MINUTE + 1, overranAllowance: true}]);
    });

    it("refuses a clock that moves backwards", () => {
        const {state, monotonicMilliseconds} = clock(10 * MINUTE);
        const budget = createWindowsMsiLifecycleBudget({limits: limits(), monotonicMilliseconds});
        budget.admitRow(0);
        state.now -= MINUTE;
        assert.throws(() => budget.completeRow(0), /monotonic/i);
    });
});


/*
 * The containment preflight boots a guest before the matrix budget has admitted anything, so its
 * cost has to be reserved against the same allowances rather than fall through to the launcher's
 * generic 270-minute maximum - which a six-hour job could be entirely consumed by before a single
 * row was constructed.
 */
describe("Windows MSI containment preflight budget reservation", () => {
    const WALL_START = 1_800_000_000_000;

    const reservation = (overrides = {}, at = 0, wallOffset = 0) => {
        const time = clock(at);
        const wall = {now: WALL_START + wallOffset};
        const value = createWindowsMsiContainmentPreflightReservation({
            limits: limits(overrides.limits), monotonicMilliseconds: time.monotonicMilliseconds,
            unixMilliseconds: () => wall.now,
            wallDeadlineUnixMilliseconds: overrides.wallDeadlineUnixMilliseconds
                ?? WALL_START + 300 * MINUTE});
        const advance = milliseconds => { time.state.now += milliseconds; wall.now += milliseconds; };
        return {value, advance};
    };

    it("names its allowance and takes it from the existing row figures", () => {
        assert.equal(WINDOWS_MSI_CONTAINMENT_PREFLIGHT_RESERVATION.label, "containment-preflight");
        const {value} = reservation();
        const reserved = value.reserve();
        assert.equal(reserved.label, "containment-preflight");
        assert.equal(reserved.allowanceMilliseconds, 15 * MINUTE);
        assert.equal(reserved.cleanupMarginMilliseconds, 2 * MINUTE);
        /* What the matrix still needs afterwards: one row, its cleanup and the final margin. */
        assert.equal(reserved.matrixRequiredMilliseconds, 27 * MINUTE);
        const sealed = value.seal();
        assert.equal(sealed.kind, WINDOWS_MSI_CONTAINMENT_PREFLIGHT_RESERVATION.observationKind);
        assert.equal(sealed.qualifying, false);
        assert.deepEqual(sealed.releaseGatesCleared, []);
        assert.equal(sealed.launchAdmitted, false);
    });

    it("bounds owned commands and the QEMU process by what is left of the reservation", () => {
        const {value, advance} = reservation();
        value.reserve();
        assert.equal(value.commandMilliseconds(120_000), 120_000);
        advance(14 * MINUTE + 30_000);
        /* Thirty seconds of allowance remain, so a two-minute command may not claim two minutes. */
        assert.equal(value.commandMilliseconds(120_000), 30_000);
        const admitted = value.admitLaunch();
        assert.equal(admitted.label, "containment-preflight");
        assert.equal(admitted.executionMilliseconds, 30_000);
        assert.equal(admitted.cleanupMilliseconds, 2 * MINUTE);
        assert.equal(value.seal().launchAdmitted, true);
    });

    it("can only tighten the launcher deadline, never claim it", () => {
        const {value} = reservation({limits: {
            jobBudgetMilliseconds: WINDOWS_MSI_LIFECYCLE_JOB_LIMITS.maximumDispatchBudgetMilliseconds,
            rowAllowanceMilliseconds: WINDOWS_MSI_LIFECYCLE_BUDGET.rowDeadlineMilliseconds}});
        /* A preflight the size of the launcher's own maximum leaves no matrix behind it. */
        assert.throws(() => value.reserve(), /matrix/iu);
        const {value: fitted} = reservation();
        assert.ok(fitted.reserve().allowanceMilliseconds
            < WINDOWS_MSI_LIFECYCLE_BUDGET.rowDeadlineMilliseconds);
    });

    it("refuses before media creation when the matrix and its cleanup can no longer fit", () => {
        /* Room for the preflight and its cleanup, but then nothing left for a single row. */
        const {value} = reservation({limits: {jobBudgetMilliseconds: 30 * MINUTE}});
        assert.throws(() => value.reserve(), WindowsMsiContainmentPreflightBudgetError);
        assert.throws(() => value.reserve(), /matrix/iu);
    });

    it("refuses a launch once the preflight allowance is spent", () => {
        const {value, advance} = reservation();
        value.reserve();
        advance(15 * MINUTE);
        assert.throws(() => value.admitLaunch(), WindowsMsiContainmentPreflightBudgetError);
        assert.throws(() => value.commandMilliseconds(1_000), /allowance/iu);
    });

    /*
     * Reading the guest's output and re-inspecting the base happen after the QEMU that may have used
     * the whole allowance. They are what the cleanup margin is for, so they draw on it instead - and
     * when that is gone too, they stop rather than reach into what the matrix still needs.
     */
    it("charges post-launch commands to the cleanup margin rather than the spent allowance", () => {
        const {value, advance} = reservation();
        value.reserve();
        advance(15 * MINUTE);
        assert.equal(value.cleanupCommandMilliseconds(120_000), 2 * MINUTE);
        advance(MINUTE + 30_000);
        assert.equal(value.cleanupCommandMilliseconds(120_000), 30_000);
        advance(30_000);
        assert.throws(() => value.cleanupCommandMilliseconds(1_000), /cleanup/iu);
    });

    /*
     * The asymmetry is deliberate. Before the launch, a matrix that could not follow is a reason to
     * not start; after it, the guest has already run and its output still has to be read, so the
     * matrix's fit is settled by charging what was spent rather than by abandoning the cleanup.
     */
    it("stops starting work once the allowance is gone, but never stops finishing it", () => {
        const {value, advance} = reservation();
        value.reserve();
        value.admitLaunch();
        advance(15 * MINUTE);
        assert.throws(() => value.commandMilliseconds(1_000), /allowance/iu);
        /* What the launch left behind still has the cleanup margin to finish in. */
        assert.equal(value.cleanupCommandMilliseconds(1_000), 1_000);
    });

    /*
     * The condition the reservation exists to guarantee: a preflight that was admitted and stayed
     * inside its own allowance and cleanup margin cannot leave the matrix short, because the fit it
     * was admitted on already counted both. So the charge can only refuse a preflight that was never
     * reserved - which is why the reservation is required rather than advisory.
     */
    it("cannot leave the matrix short once it has been reserved", () => {
        const {value, advance} = reservation();
        const reserved = value.reserve();
        advance(reserved.allowanceMilliseconds + reserved.cleanupMarginMilliseconds);
        const charged = chargeWindowsMsiContainmentPreflight({limits: limits(),
            elapsedMilliseconds: value.seal().elapsedMilliseconds});
        assert.ok(charged.jobBudgetMilliseconds >= reserved.matrixRequiredMilliseconds);
        /* An unreserved preflight has no such promise, and the charge is what catches it. */
        assert.throws(() => chargeWindowsMsiContainmentPreflight({limits: limits(),
            elapsedMilliseconds: 290 * MINUTE}), /budget/iu);
    });

    it("refuses a launch the wall deadline cannot hold even when the job budget could", () => {
        const {value} = reservation({wallDeadlineUnixMilliseconds: WALL_START + 40 * MINUTE});
        assert.throws(() => value.reserve(), WindowsMsiContainmentPreflightBudgetError);
    });

    it("requires the reservation before a launch is admitted", () => {
        const {value} = reservation();
        assert.throws(() => value.admitLaunch(), /reserv/iu);
    });

    it("refuses a clock that runs backwards rather than handing back budget", () => {
        const {value, advance} = reservation();
        value.reserve();
        advance(-1);
        assert.throws(() => value.commandMilliseconds(1_000), /monotonic/iu);
    });

    it("charges the elapsed preflight into what the matrix may still claim", () => {
        const charged = chargeWindowsMsiContainmentPreflight({limits: limits(),
            elapsedMilliseconds: 17 * MINUTE});
        assert.deepEqual(charged, limits({jobBudgetMilliseconds: 283 * MINUTE}));
        /* A preflight that ate everything leaves a remainder no row could be admitted into. */
        assert.throws(() => chargeWindowsMsiContainmentPreflight({limits: limits(),
            elapsedMilliseconds: 280 * MINUTE}), /budget/iu);
        assert.throws(() => chargeWindowsMsiContainmentPreflight({limits: limits(),
            elapsedMilliseconds: -1}), /preflight/iu);
    });

    it("rejects a reservation it cannot measure", () => {
        assert.throws(() => createWindowsMsiContainmentPreflightReservation({limits: limits(),
            unixMilliseconds: () => WALL_START,
            wallDeadlineUnixMilliseconds: WALL_START + MINUTE}), /clock|monotonic/iu);
        assert.throws(() => createWindowsMsiContainmentPreflightReservation({limits: limits(),
            monotonicMilliseconds: () => 0, unixMilliseconds: () => WALL_START,
            wallDeadlineUnixMilliseconds: WALL_START - 1}), /wall/iu);
    });
});
