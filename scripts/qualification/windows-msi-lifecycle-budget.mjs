/*
 * Total-budget admission for the Windows MSI lifecycle matrix.
 *
 * A hosted job stops at six hours. The per-row QEMU deadline is 270 minutes, which is a maximum the
 * launcher enforces, not a duration anything has measured; fourteen of them is sixty-three hours, so
 * multiplying the deadline by the row count produces a plan that no job can hold and that no
 * observation supports. The matrix is also not divisible: the installed base and every overlay row
 * have to stay in one job, so there is no second job to spill into.
 *
 * What this does instead is admit rows one at a time against observed elapsed time. Before a row
 * starts, the remaining budget must still cover that row's allowance, the cleanup that has to follow
 * it, and the final margin the run needs after the last row for base re-inspection and evidence
 * sealing. A row whose margins no longer fit is refused before it starts, and the refusal is a
 * typed, bounded observation naming exactly how far the run got - which is the measurement a
 * feasibility claim needs, rather than a partial run that looks like a completed one.
 *
 * The allowance is a planning figure and nothing here enforces it. The only deadline anything stops
 * a row at is the launcher's own 270-minute one, so a row may overrun its allowance and be charged
 * the time it actually took; the observation says `allowanceEnforced: false`, names the deadline that
 * is enforced, and flags every row that overran, rather than letting a consumer read the cleanup
 * margin as a reserve that was held open for it.
 *
 * The job also stops at its declared `timeout-minutes` well before the platform's six-hour limit, and
 * the end of that job belongs to bounding and uploading the evidence. A dispatch budget is therefore
 * capped at the timeout minus an explicit retention reserve, checked before any expensive setup, and
 * the measured setup is subtracted from it before the matrix is admitted at all.
 */

const SCHEMA_VERSION = 1;
const OBSERVATION_KIND = "myspeed-windows-msi-lifecycle-budget-observation";
const MINUTE_MILLISECONDS = 60_000;

/*
 * https://docs.github.com/en/actions/reference/limits, confirmed 2026-09-14: a job on a
 * GitHub-hosted runner is cancelled at six hours.
 */
const HOSTED_JOB_LIMIT_MILLISECONDS = 6 * 60 * MINUTE_MILLISECONDS;

/*
 * The launcher's own per-row deadline. It is the only per-row stop anything enforces, so an
 * allowance may never exceed it and the observation reports it as the enforced bound.
 */
const ROW_DEADLINE_MILLISECONDS = 16_200_000;
const SCENARIO_COUNT = 14;
const MINIMUM_MARGIN_MILLISECONDS = 1;

/*
 * `timeout-minutes` on the execution job, and the part of it reserved for bounding, sealing and
 * uploading the retained evidence after the controller returns. A dispatch may claim the rest.
 */
const JOB_TIMEOUT_MILLISECONDS = 350 * MINUTE_MILLISECONDS;
const RETENTION_RESERVE_MILLISECONDS = 10 * MINUTE_MILLISECONDS;
const MAXIMUM_DISPATCH_BUDGET_MILLISECONDS = JOB_TIMEOUT_MILLISECONDS - RETENTION_RESERVE_MILLISECONDS;

export const WINDOWS_MSI_LIFECYCLE_JOB_LIMITS = Object.freeze({
    jobTimeoutMilliseconds: JOB_TIMEOUT_MILLISECONDS,
    retentionReserveMilliseconds: RETENTION_RESERVE_MILLISECONDS,
    maximumDispatchBudgetMilliseconds: MAXIMUM_DISPATCH_BUDGET_MILLISECONDS
});

/*
 * The containment preflight is the one guest that boots before the matrix exists, so it is the one
 * cost the row-by-row admission above cannot see. Left alone it falls through to the launcher's
 * generic per-row deadline, and a six-hour job can be spent on it before a row is constructed. It is
 * therefore reserved against these same allowances, under its own name, before any media is written.
 */
const PREFLIGHT_LABEL = "containment-preflight";
const PREFLIGHT_OBSERVATION_KIND = "myspeed-windows-msi-containment-preflight-reservation";

export const WINDOWS_MSI_CONTAINMENT_PREFLIGHT_RESERVATION = Object.freeze({
    label: PREFLIGHT_LABEL,
    observationKind: PREFLIGHT_OBSERVATION_KIND
});

export const WINDOWS_MSI_LIFECYCLE_BUDGET = Object.freeze({
    hostedJobLimitMilliseconds: HOSTED_JOB_LIMIT_MILLISECONDS,
    rowDeadlineMilliseconds: ROW_DEADLINE_MILLISECONDS,
    scenarioCount: SCENARIO_COUNT,
    observationKind: OBSERVATION_KIND
});

const PLANNING_NAMES = Object.freeze(["rowAllowanceMilliseconds", "rowCleanupMarginMilliseconds",
    "finalMarginMilliseconds"]);
const LIMIT_NAMES = Object.freeze(["jobBudgetMilliseconds", ...PLANNING_NAMES]);

const isObject = value => value !== null && typeof value === "object" && !Array.isArray(value);

export const validateWindowsMsiLifecycleBudgetLimits = value => {
    if (!isObject(value)) throw new TypeError("MSI lifecycle budget limits differ");
    const actual = Object.keys(value).sort();
    const wanted = [...LIMIT_NAMES].sort();
    if (actual.length !== wanted.length || actual.some((name, index) => name !== wanted[index]))
        throw new TypeError("MSI lifecycle budget limits differ");
    for (const name of LIMIT_NAMES)
        if (!Number.isSafeInteger(value[name]) || value[name] < MINIMUM_MARGIN_MILLISECONDS)
            throw new TypeError(`MSI lifecycle budget limit ${name} differs`);
    if (value.jobBudgetMilliseconds > MAXIMUM_DISPATCH_BUDGET_MILLISECONDS)
        throw new Error("MSI lifecycle budget exceeds the job timeout less its retention reserve");
    if (value.rowAllowanceMilliseconds > ROW_DEADLINE_MILLISECONDS)
        throw new Error("MSI lifecycle budget row allowance exceeds the row deadline");
    if (value.jobBudgetMilliseconds < value.rowAllowanceMilliseconds + value.rowCleanupMarginMilliseconds
        + value.finalMarginMilliseconds)
        throw new Error("MSI lifecycle budget cannot hold a single row with its margins");
    return {...value};
};


const JOB_BUDGET_NAMES = Object.freeze(["jobBudgetMilliseconds", "jobTimeoutMilliseconds",
    "retentionReserveMilliseconds"]);
const DERIVED_NAME = "maximumJobBudgetMilliseconds";

const exactKeys = (value, names, label) => {
    if (!isObject(value)) throw new TypeError(`${label} differ`);
    const actual = Object.keys(value).sort();
    const wanted = [...names].sort();
    if (actual.length !== wanted.length || actual.some((name, index) => name !== wanted[index]))
        throw new TypeError(`${label} differ`);
    return value;
};

/*
 * Checked before the job spends anything: the declared timeout must fit inside the platform limit,
 * the reserve must leave the run something, and the dispatched budget may not reach into the
 * reserve. Nothing here has measured a completion time - this only refuses a budget the job could
 * never retain its own evidence within.
 */
export const validateWindowsMsiLifecycleJobBudget = value => {
    /*
     * Revalidating this function's own output has to succeed, because the workflow validates the
     * dispatch early and admits the setup later from the same record - and revalidating it has to
     * recheck the derived maximum rather than trust the caller's copy of it.
     */
    const derived = isObject(value) && Object.hasOwn(value, DERIVED_NAME);
    exactKeys(value, derived ? [...JOB_BUDGET_NAMES, DERIVED_NAME] : JOB_BUDGET_NAMES,
        "MSI lifecycle job budget");
    for (const name of Object.keys(value))
        if (!Number.isSafeInteger(value[name]) || value[name] < MINIMUM_MARGIN_MILLISECONDS)
            throw new TypeError(`MSI lifecycle job budget ${name} differs`);
    if (value.jobTimeoutMilliseconds > HOSTED_JOB_LIMIT_MILLISECONDS)
        throw new Error("MSI lifecycle job timeout exceeds the hosted job limit");
    const maximumJobBudgetMilliseconds = value.jobTimeoutMilliseconds - value.retentionReserveMilliseconds;
    if (maximumJobBudgetMilliseconds < MINIMUM_MARGIN_MILLISECONDS)
        throw new Error("MSI lifecycle retention reserve leaves the job no budget");
    if (value.jobBudgetMilliseconds > maximumJobBudgetMilliseconds)
        throw new Error("MSI lifecycle job budget reaches into the retention reserve");
    if (derived && value[DERIVED_NAME] !== maximumJobBudgetMilliseconds)
        throw new Error("MSI lifecycle job budget maximum differs");
    return {...value, maximumJobBudgetMilliseconds};
};

/*
 * Setup - Stage 2 above all - is charged to the same job, so the matrix only ever gets what is left
 * of the dispatched budget after the time this job has already spent. A remainder that cannot hold
 * one row with its margins is refused here, before an installed base is sealed that nothing could
 * use.
 */
export const admitWindowsMsiLifecycleSetup = ({job, elapsedMilliseconds, limits}) => {
    const validatedJob = validateWindowsMsiLifecycleJobBudget(job);
    if (!Number.isSafeInteger(elapsedMilliseconds) || elapsedMilliseconds < 0)
        throw new TypeError("MSI lifecycle measured setup differs");
    exactKeys(limits, PLANNING_NAMES, "MSI lifecycle planning limits");
    const jobBudgetMilliseconds = validatedJob.jobBudgetMilliseconds - elapsedMilliseconds;
    if (jobBudgetMilliseconds < MINIMUM_MARGIN_MILLISECONDS)
        throw new Error("MSI lifecycle setup consumed the whole dispatched budget");
    return validateWindowsMsiLifecycleBudgetLimits({...limits, jobBudgetMilliseconds});
};

export class WindowsMsiLifecycleAdmissionError extends Error {
    constructor(progress) {
        super(`MSI lifecycle budget refused scenario ${progress.refusedScenarioIndex}: `
            + `${progress.remainingMilliseconds}ms remain of the ${progress.requiredMilliseconds}ms required`);
        this.name = "WindowsMsiLifecycleAdmissionError";
        this.scenarioIndex = progress.refusedScenarioIndex;
        this.remainingMilliseconds = progress.remainingMilliseconds;
        this.requiredMilliseconds = progress.requiredMilliseconds;
        this.progress = progress;
    }
}

export const createWindowsMsiLifecycleBudget = ({limits: input, monotonicMilliseconds}) => {
    const limits = validateWindowsMsiLifecycleBudgetLimits(input);
    if (typeof monotonicMilliseconds !== "function")
        throw new TypeError("MSI lifecycle budget needs a monotonic clock");
    const required = limits.rowAllowanceMilliseconds + limits.rowCleanupMarginMilliseconds
        + limits.finalMarginMilliseconds;
    const rows = [];
    let observedNow = monotonicMilliseconds();
    if (!Number.isFinite(observedNow)) throw new TypeError("MSI lifecycle budget clock differs");
    const started = observedNow;
    let open = null;
    let refusedScenarioIndex = null;

    /*
     * Every reading is compared with the previous one. A clock that goes backwards would hand the
     * run budget it never had, so it is refused rather than clamped.
     */
    const read = () => {
        const now = monotonicMilliseconds();
        if (!Number.isFinite(now) || now < observedNow)
            throw new Error("MSI lifecycle budget clock is not monotonic");
        observedNow = now;
        return now;
    };
    const elapsed = () => observedNow - started;
    const remaining = () => limits.jobBudgetMilliseconds - elapsed();

    const observe = (status, refused, requiredMilliseconds) => Object.freeze({
        schemaVersion: SCHEMA_VERSION, kind: OBSERVATION_KIND, qualifying: false, status,
        refusedScenarioIndex: refused, scenarioCount: SCENARIO_COUNT, rowsAdmitted: rows.length,
        rowsCompleted: rows.filter(row => row.observedMilliseconds !== null).length,
        rowsOverranAllowance: rows.filter(row => row.observedMilliseconds !== null
            && row.observedMilliseconds > limits.rowAllowanceMilliseconds).length,
        rows: Object.freeze(rows.filter(row => row.observedMilliseconds !== null)
            .map(row => Object.freeze({scenarioIndex: row.scenarioIndex,
                observedMilliseconds: row.observedMilliseconds,
                overranAllowance: row.observedMilliseconds > limits.rowAllowanceMilliseconds}))),
        limits: Object.freeze({...limits}), elapsedMilliseconds: elapsed(),
        remainingMilliseconds: remaining(), requiredMilliseconds, exhausted: remaining() < required,
        /*
         * Said out loud so no consumer reads the allowance as a stop: the launcher deadline below is
         * the only per-row bound anything enforces.
         */
        allowanceEnforced: false, enforcedRowDeadlineMilliseconds: ROW_DEADLINE_MILLISECONDS,
        releaseGatesCleared: Object.freeze([])
    });

    return Object.freeze({
        admitRow(scenarioIndex) {
            if (open !== null) throw new Error("MSI lifecycle budget row is not completed");
            if (!Number.isInteger(scenarioIndex) || scenarioIndex !== rows.length)
                throw new Error("MSI lifecycle budget rows must be admitted in matrix order");
            read();
            if (remaining() < required) {
                refusedScenarioIndex = scenarioIndex;
                throw new WindowsMsiLifecycleAdmissionError(
                    observe("budget-exhausted", scenarioIndex, required));
            }
            open = {scenarioIndex, startedMilliseconds: observedNow, observedMilliseconds: null};
            rows.push(open);
            return Object.freeze({scenarioIndex, remainingMilliseconds: remaining(),
                requiredMilliseconds: required});
        },
        completeRow(scenarioIndex) {
            if (open === null || open.scenarioIndex !== scenarioIndex)
                throw new Error("MSI lifecycle budget rows must be completed in matrix order");
            const now = read();
            open.observedMilliseconds = now - open.startedMilliseconds;
            open = null;
            return Object.freeze({scenarioIndex, remainingMilliseconds: remaining()});
        },
        /*
         * Sealing an abandoned row is allowed: a run that failed mid-row still has to report how far
         * it got. The row stays out of `rows` because nothing observed its duration, and
         * `rowsAdmitted` still counts it, so the difference names the row that did not finish.
         */
        seal() {
            read();
            return observe(refusedScenarioIndex === null ? "completed" : "budget-exhausted",
                refusedScenarioIndex, required);
        }
    });
};


export class WindowsMsiContainmentPreflightBudgetError extends Error {
    constructor(message, observation) {
        super(message);
        this.name = "WindowsMsiContainmentPreflightBudgetError";
        this.observation = observation;
    }
}

/*
 * The preflight's reservation, opened at the moment the preflight starts.
 *
 * It borrows the row figures rather than inventing its own: the preflight boots one guest on one
 * disposable overlay, which is what a row is, and a second set of numbers would be a second thing to
 * keep honest. What it adds is the condition that makes it safe to spend them at all - after the
 * preflight and its cleanup, the matrix must still fit. A reservation that cannot promise that is
 * refused before any media is written, so the guest that could not have been followed by a matrix is
 * never started.
 *
 * The allowance can only tighten the launcher's own deadline: `validateWindowsMsiLifecycleBudgetLimits`
 * already refuses a row allowance above it, and the fit condition below refuses one anywhere near it.
 */
export const createWindowsMsiContainmentPreflightReservation = ({limits: input, monotonicMilliseconds,
    unixMilliseconds, wallDeadlineUnixMilliseconds}) => {
    const limits = validateWindowsMsiLifecycleBudgetLimits(input);
    if (typeof monotonicMilliseconds !== "function" || typeof unixMilliseconds !== "function")
        throw new TypeError("MSI containment preflight reservation needs a monotonic clock");
    if (!Number.isSafeInteger(wallDeadlineUnixMilliseconds))
        throw new TypeError("MSI containment preflight wall deadline differs");
    const allowanceMilliseconds = limits.rowAllowanceMilliseconds;
    const cleanupMarginMilliseconds = limits.rowCleanupMarginMilliseconds;
    const matrixRequiredMilliseconds = limits.rowAllowanceMilliseconds
        + limits.rowCleanupMarginMilliseconds + limits.finalMarginMilliseconds;

    let observedNow = monotonicMilliseconds();
    if (!Number.isFinite(observedNow))
        throw new TypeError("MSI containment preflight reservation clock differs");
    const started = observedNow;
    const wallStarted = unixMilliseconds();
    if (!Number.isFinite(wallStarted) || wallDeadlineUnixMilliseconds - wallStarted
        < MINIMUM_MARGIN_MILLISECONDS)
        throw new Error("MSI containment preflight wall deadline has already passed");
    let reserved = false;
    let launchAdmitted = false;

    /* A clock that goes backwards would hand the preflight budget it never had. */
    const read = () => {
        const now = monotonicMilliseconds();
        if (!Number.isFinite(now) || now < observedNow)
            throw new Error("MSI containment preflight reservation clock is not monotonic");
        observedNow = now;
        return now;
    };
    const elapsed = () => observedNow - started;
    const allowanceRemaining = () => allowanceMilliseconds - elapsed();
    /*
     * After the launch the allowance may be entirely gone - that is what it was for. The cleanup
     * margin is what funds proving the group is gone, extracting the guest's output and re-inspecting
     * the base, so post-launch work draws on the two together rather than on an allowance it would
     * always find empty.
     */
    const cleanupRemaining = () => allowanceMilliseconds + cleanupMarginMilliseconds - elapsed();
    /* Whichever runs out first: what is left of the dispatched budget, or of the wall clock. */
    const remaining = () => Math.min(limits.jobBudgetMilliseconds - elapsed(),
        wallDeadlineUnixMilliseconds - (wallStarted + elapsed()));

    const observe = () => Object.freeze({schemaVersion: SCHEMA_VERSION,
        kind: PREFLIGHT_OBSERVATION_KIND, qualifying: false, label: PREFLIGHT_LABEL,
        allowanceMilliseconds, cleanupMarginMilliseconds, matrixRequiredMilliseconds,
        elapsedMilliseconds: elapsed(), remainingMilliseconds: remaining(),
        allowanceRemainingMilliseconds: allowanceRemaining(),
        cleanupRemainingMilliseconds: cleanupRemaining(), launchAdmitted,
        releaseGatesCleared: Object.freeze([])});

    const assertRequested = requested => {
        if (!Number.isSafeInteger(requested) || requested < MINIMUM_MARGIN_MILLISECONDS)
            throw new TypeError("MSI containment preflight command bound differs");
    };

    const refuse = message => {
        throw new WindowsMsiContainmentPreflightBudgetError(
            `MSI containment preflight budget ${message}`, observe());
    };

    const assertMatrixFits = headroom => {
        if (remaining() < headroom + matrixRequiredMilliseconds)
            refuse(`leaves the matrix ${remaining()}ms of the `
                + `${headroom + matrixRequiredMilliseconds}ms it requires`);
    };

    /*
     * The one condition, checked wherever the preflight is about to spend something: its own
     * allowance must have time left, and what remains after that allowance and the cleanup that has
     * to follow it must still hold the matrix.
     */
    const assertFits = () => {
        read();
        if (allowanceRemaining() < MINIMUM_MARGIN_MILLISECONDS)
            refuse(`allowance of ${allowanceMilliseconds}ms is spent`);
        assertMatrixFits(allowanceRemaining() + cleanupMarginMilliseconds);
    };

    /*
     * After the launch the matrix fit is no longer a decision this can make. The overlay exists, the
     * guest has run, and its output still has to be read and its root still has to come down;
     * refusing that would abandon work already paid for and leave the overlay behind. So the only
     * bound here is the cleanup headroom itself, which stops a hung extraction from eating the job.
     * Whether the matrix can still follow is settled afterwards, by charging what was spent.
     */
    const assertCleanupFits = () => {
        read();
        if (cleanupRemaining() < MINIMUM_MARGIN_MILLISECONDS)
            refuse(`cleanup headroom of ${cleanupMarginMilliseconds}ms is spent`);
    };

    return Object.freeze({
        label: PREFLIGHT_LABEL,
        /* Called before any media is created, so a refusal costs nothing but the check. */
        reserve() {
            assertFits();
            reserved = true;
            return Object.freeze({label: PREFLIGHT_LABEL, allowanceMilliseconds,
                cleanupMarginMilliseconds, matrixRequiredMilliseconds,
                remainingMilliseconds: remaining()});
        },
        /* An owned command may never be given longer than the preflight has left to give. */
        commandMilliseconds(requested) {
            assertRequested(requested);
            assertFits();
            return Math.min(requested, allowanceRemaining());
        },
        /* The same, for the work that only happens once the QEMU it follows has stopped. */
        cleanupCommandMilliseconds(requested) {
            assertRequested(requested);
            assertCleanupFits();
            return Math.min(requested, cleanupRemaining());
        },
        /*
         * The deadlines the launcher is given. The cleanup margin is handed over separately rather
         * than folded into the execution bound, so the process and its group have headroom to be
         * proven gone after the execution deadline stops them.
         */
        admitLaunch() {
            if (!reserved) refuse("was not reserved before the launch");
            assertFits();
            launchAdmitted = true;
            return Object.freeze({label: PREFLIGHT_LABEL,
                executionMilliseconds: allowanceRemaining(),
                cleanupMilliseconds: cleanupMarginMilliseconds});
        },
        seal() { read(); return observe(); }
    });
};

/*
 * What the preflight actually took comes off what the matrix may claim. The remainder goes back
 * through the same limit validation, so a preflight that left too little for one row with its
 * margins stops the run here rather than inside the matrix.
 */
export const chargeWindowsMsiContainmentPreflight = ({limits: input, elapsedMilliseconds}) => {
    const limits = validateWindowsMsiLifecycleBudgetLimits(input);
    if (!Number.isSafeInteger(elapsedMilliseconds) || elapsedMilliseconds < 0)
        throw new TypeError("MSI lifecycle measured containment preflight differs");
    return validateWindowsMsiLifecycleBudgetLimits({...limits,
        jobBudgetMilliseconds: limits.jobBudgetMilliseconds - elapsedMilliseconds});
};
