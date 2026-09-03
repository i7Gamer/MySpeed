import * as pauseController from '../controller/pause.js';
import * as config from '../controller/config.js';
import schedule from 'node-schedule';
import { isValidCron } from "cron-validator";
import { CronExpressionParser } from "cron-parser";
import { create as createSpeedtest } from './speedtest.js';
import { runDigest } from './digestReport.js';
import { isQuietHour } from '../util/quietHours.js';
import { serverZone, zoneFromName } from '../util/timezone.js';
import errorHandler from "../util/errorHandler.js";

const MS_PER_MINUTE = 60_000;

/**
 * Whether a stored `timezone` is one to hand to the schedule at all.
 *
 * The off sentinel and anything unusable both answer false, which leaves the
 * host clock in charge - the behaviour every instance had before the setting
 * existed. zoneFromName makes the same judgement for the window; this one exists
 * because node-schedule and cron-parser want the *name*, not a zone object.
 */
const isValidTimezone = (timezone) => zoneFromName(timezone) !== serverZone;

/**
 * The cron spellings the door is asked about, held to what the scheduler
 * actually runs.
 *
 * Out of the box cron-validator refuses day names and 7-for-Sunday, and both
 * engines behind it take them: node-schedule schedules `0 0 * * MON`, and the
 * cron-parser the frequency dialog validates with parses it - so the dialog
 * drew a "next test" line, enabled Save, and the PATCH came back 400 on a
 * standard crontab.guru expression the dialog itself links to.
 *
 * It lives here, beside the schedule these options describe, and the
 * controller's door reads it from here: the three places that ask - startTimer
 * and nextRun below, and validateInput in controller/config.js - have to ask
 * the same question, or which spellings an instance takes depends on which
 * door the value arrived through.
 *
 * Deliberately no `seconds`. Both engines read a six-field expression, but
 * everything around them is minute-granular: OFFSET_MIN_DELAY_MS is half the
 * tightest interval five fields can express, and MAX_QUIET_OCCURRENCES is 480
 * occurrences of a minutely cron but only 25 minutes of a per-second one, so
 * nextRun would answer null - no test is coming - for a schedule that fires
 * perfectly well. Presets are out of reach either way: cron-validator has no
 * support for them at all and refuses anything under five fields, so `@hourly`
 * stays refused whatever is passed here.
 */
export const CRON_OPTIONS = {alias: true, allowSevenAsSunday: true};

let job;
let currentCron;

/**
 * The zone the running schedule was built in, as its stored name.
 *
 * Held beside the cron for the same reason the cron is: nextRun answers what the
 * *running* schedule will do next, and reading the setting again would describe
 * a schedule that has not been started yet. Changing it restarts the timer -
 * routes/config.js and controller/config.js both do - so this only ever holds
 * what node-schedule was actually given.
 */
let currentTimezone;

/**
 * Bumped every time the schedule is torn down, so a run can tell whether the
 * schedule it belongs to still exists.
 *
 * With the offset enabled a run spends up to five minutes asleep before it
 * tests anything, and stopTimer() had no reference to that sleep - it cancelled
 * the job and returned, and the run woke up afterwards and tested anyway. The
 * pause check on the far side does not catch it: changing the cron pauses
 * nothing, so a reschedule was reliably followed by one last speedtest from the
 * schedule that had just been replaced.
 */
let generation = 0;

// The offset delays that have not yet elapsed, so stopTimer() can release them
// rather than leave them to fire into a schedule that is gone.
const pendingDelays = new Set();

export const scheduleGeneration = () => generation;

export const pendingDelayCount = () => pendingDelays.size;

/** Whether the schedule has been stopped or replaced since `startedIn`. */
export const scheduleChangedSince = (startedIn) => startedIn !== generation;

/** The scheduled job, for the tests that assert it was cancelled. */
export const currentJob = () => job;

/**
 * Sleeps, but wakes at once if the schedule is torn down meanwhile.
 *
 * Cut short rather than left pending: abandoning the promise would strand the
 * run that awaits it, holding the latch tasks/speedtest.js drops in its
 * `finally` for as long as the process lives. It resolves either way, and the
 * caller decides what to do about it by asking scheduleChangedSince.
 */
export const delayRun = (ms) => new Promise((resolve) => {
    // The wake moment travels with the handle so pendingRunAt below can name
    // it; the status bar has no other way to know a run is merely asleep.
    const entry = {resolve, until: Date.now() + ms};

    entry.id = setTimeout(() => {
        pendingDelays.delete(entry);
        resolve();
    }, ms);

    pendingDelays.add(entry);
});

/**
 * When the run currently sleeping its schedule offset will wake, or null when
 * none is.
 *
 * The status bar's countdown is cron arithmetic from now, and the offset makes
 * that wrong for the whole of the sleep: the 19:00 job has fired, the run is
 * asleep until 19:03, and the cron's next occurrence is already 19:30 - so the
 * bar rolled to the next slot while the 19:00 test was still on its way, which
 * read as it having been skipped. /status asks this first and only falls back
 * to the cron when nothing is pending.
 *
 * The earliest entry answers, though the set only ever holds one today: there
 * is a single job, and every teardown releases the delays it started.
 */
export const pendingRunAt = () => {
    let earliest = null;

    for (const {until} of pendingDelays)
        if (earliest === null || until < earliest) earliest = until;

    return earliest === null ? null : new Date(earliest).toISOString();
};

// Exported for its test. The delay it bounds must stay well inside the
// interval, or a run offset near the cap lands on the next tick and is dropped
// as an overlap.
export const calculateMaxDelay = (cron) => {
    try {
        const parser = CronExpressionParser.parse(cron);
        const next1 = parser.next().getTime();
        const next2 = parser.next().getTime();
        const intervalMs = next2 - next1;
        const intervalMinutes = intervalMs / MS_PER_MINUTE;

        // The interval-agnostic tier, the same steps as before. Nothing is said
        // here about intervals of a minute or less: half of one is already at or
        // below the floor the return applies, so the floor decides those
        // whatever cap they are handed, and a tier of their own only looked as
        // though it were the thing deciding them.
        let cap;
        if (intervalMinutes <= 30) cap = 2 * MS_PER_MINUTE;
        else if (intervalMinutes <= 60) cap = 3 * MS_PER_MINUTE;
        else cap = 5 * MS_PER_MINUTE;

        // Never more than half the interval - the cap the minutely branch
        // already was, generalised: a flat two minutes overshot every interval
        // between one and four minutes, so a */2 cron could be delayed by its
        // whole gap and run at half its rate. Never below the floor either, or
        // getRandomDelay's range turns inside out.
        return Math.max(OFFSET_MIN_DELAY_MS, Math.min(cap, intervalMs / 2));
    } catch {
        return 2 * MS_PER_MINUTE; // Default to 2 minutes if parsing fails
    }
};

/**
 * The least the schedule offset ever delays a run.
 *
 * Half of the tightest interval a five-field cron can express: for a minutely
 * schedule calculateMaxDelay answers this same value, leaving no random range
 * at all, and a larger floor would overshoot that cap and turn the range
 * inside out. Exported so the test harness can recognise the offset's sleep
 * by its length rather than keep a copy of this number that goes stale.
 */
export const OFFSET_MIN_DELAY_MS = 30 * 1000;

const getRandomDelay = (cron) => {
    const maxDelay = calculateMaxDelay(cron);
    return Math.floor(Math.random() * (maxDelay - OFFSET_MIN_DELAY_MS + 1)) + OFFSET_MIN_DELAY_MS;
};

/**
 * The digests' fixed schedules: Monday and the first of the month, at eight
 * on the configured zone's clock. Constants rather than settings for v1 -
 * the opt-in lives per integration - and exported for the suite that holds
 * them to being valid crons.
 */
export const DIGEST_WEEKLY_CRON = "0 8 * * 1";
export const DIGEST_MONTHLY_CRON = "0 8 1 * *";

const DIGEST_KINDS = [["weekly", DIGEST_WEEKLY_CRON], ["monthly", DIGEST_MONTHLY_CRON]];

let digestJobs = [];

const stopDigests = () => {
    for (const digest of digestJobs) digest.cancel();
    digestJobs = [];
};

/**
 * Armed and cancelled from inside startTimer/stopTimer on purpose: the six
 * places that must manage this lifecycle - boot, the timezone PATCH, a
 * config import, a factory reset, the shutdown's onStop, and every test
 * teardown that already calls stopTimer - all reach these two functions
 * today, so the digest cannot be the job one of them forgets. The zone is
 * the digests' only input, and it rides in with the cron they ignore.
 */
const startDigests = (timezone) => {
    stopDigests();

    // Filtered rather than stored as it comes. The two rules are fixed and
    // valid, but scheduleJob still answers null for a spec it cannot compile -
    // here that means a zone it will not take - and a null in this list makes
    // the next stopDigests throw on `digest.cancel()`. That teardown is the
    // shutdown's as much as every reschedule's, so a zone nobody can schedule
    // would have taken the clean shutdown down with the digests.
    digestJobs = DIGEST_KINDS.map(([kind, cron]) => schedule.scheduleJob(
        isValidTimezone(timezone) ? {rule: cron, tz: timezone} : cron,
        () => runDigest(kind, {timezone}).catch(err =>
            errorHandler(err, {fatal: false, context: `The scheduled ${kind} digest failed`}))))
        .filter(Boolean);
};

export const startTimer = (cron, timezone) => {
    /*
     * An invalid cron means different things depending on what is running.
     * With a schedule up, refusing it and keeping the running one is the
     * protection: the operator's working schedule survives a bad reschedule.
     * With nothing up - the boot path, handed a stored value validateInput
     * never saw, from a hand-edited database or one written before validation
     * existed - the same refusal used to be silent and total: no schedule
     * existed at all, tests never ran again, and nothing said why. The stored
     * value is left alone either way, for the operator to see and fix.
     */
    if (!isValidCron(cron, CRON_OPTIONS)) {
        // `if (job)` rather than a comparison against undefined: node-schedule
        // answers null for a rule it cannot compile, and a null job is no
        // schedule at all - printing "keeping the running schedule" over one
        // was the least of it, since there was nothing to keep.
        if (job) {
            console.warn(`The cron "${cron}" is not valid; keeping the running schedule.`);
            // The digests still re-arm: they run on their own fixed rules,
            // and the refused cron must neither take the weekly summary down
            // nor keep it on the old timezone.
            startDigests(timezone);
            return;
        }

        console.warn(`The stored cron "${cron}" is not valid; ` +
            `scheduling the default "${config.configDefaults.cron}" instead.`);
        cron = config.configDefaults.cron;
    }

    // Before the assignment, not left to the caller. Every caller happens to
    // stop first today, but the module holds exactly one job reference and
    // overwriting it drops the only handle that could cancel what it replaced -
    // node-schedule keeps firing it, so a changed cron would have run both
    // schedules for the rest of the process.
    stopTimer();

    // After the stop, which cancels the previous pair along with the job -
    // and on every path that leaves a schedule running, so a timezone change
    // moves the digests with it.
    startDigests(timezone);

    /*
     * `{rule, tz}` rather than the bare expression whenever a zone is
     * configured, so "0 3 * * *" is three in the morning where the operator
     * lives rather than wherever the host thinks it is - which the Docker image
     * pins to Etc/UTC (upstream #1115).
     *
     * The bare expression is kept when nothing is set, rather than passing the
     * host zone explicitly: node-schedule reads a bare one on the host clock
     * already, and naming a zone would route it through cron-parser's tz
     * handling for no change in meaning.
     */
    const spec = (expression) => isValidTimezone(timezone) ? {rule: expression, tz: timezone} : expression;

    // Caught here, because nothing else does. create() guards its own work, but
    // runTask reaches it through the pause state, the quiet hours check and the
    // schedule offset - three config reads, any of which can reject on a
    // database that has gone away or one a shutdown already under way has
    // closed. Uncaught, that reached index.js's unhandledRejection handler as a
    // bare server fault with no mention of the schedule that produced it, and
    // it repeats on every tick of the cron. index.js catches the startup run
    // for the same reason; this one it handed to node-schedule did not.
    //
    // Reported through errorHandler rather than console.error, so it still
    // reaches data/logs/error.log - the file the log's own header points bug
    // reports at, and where the unhandledRejection route used to put it.
    const run = () => runTask().catch(err =>
        errorHandler(err, {fatal: false, context: "The scheduled speedtest failed"}));

    /*
     * node-schedule's own answer is the only authority on whether an
     * expression can be scheduled, so it is asked rather than pre-checked.
     * Four parsers are involved here and they disagree: node-schedule carries
     * a bundled cron-parser 4, which applies the day-of-month AND day-of-week
     * rule where the cron-parser 5 nextRun and the frequency dialog use
     * applies OR - so "0 0 31 4 1" walks through the dialog, the door and the
     * countdown and compiles to nothing at all here. A pre-check with either
     * validator cannot see that.
     *
     * It says so with null - not undefined, and not a throw. Stored as it
     * came, that null was no schedule with nothing said, and it walked
     * straight through the two `!== undefined` guards: every later cron or
     * timezone PATCH threw on null.cancel() after the new value had already
     * been written, and so did the shutdown's own stopTimer, before it could
     * close the database or kill the running child.
     */
    let scheduled = schedule.scheduleJob(spec(cron), run);

    if (!scheduled) {
        console.warn(`The cron "${cron}" cannot be scheduled; ` +
            `scheduling the default "${config.configDefaults.cron}" instead.`);
        cron = config.configDefaults.cron;
        scheduled = schedule.scheduleJob(spec(cron), run);
    }

    // After the fallback has had its say, or /status goes on counting down to
    // the expression that was refused - and cron-parser 5 happily names a
    // moment for it, so the dashboard announced a test that could never run.
    currentCron = cron;
    currentTimezone = timezone;

    // The fallback can compile to nothing too - an unusable zone answers null
    // whatever the rule is - and then there is honestly no schedule. Never a
    // null in the handle either way: `??` leaves the absence spelled the one
    // way the rest of this module reads it.
    job = scheduled ?? undefined;
};

/**
 * When the schedule will next fire, or null if none is running.
 *
 * Approximate when the schedule offset is enabled: that deliberately delays each
 * run by up to a few minutes to avoid every instance testing on the same tick.
 */
/**
 * How many scheduled occurrences are stepped over before giving up.
 *
 * A window can swallow a long run of them - a minutely cron under an eight-hour
 * quiet window is 480 - and a pair that swallows every one of them must end the
 * search rather than walk the schedule forever. Answering null then is honest:
 * no test is going to run.
 */
const MAX_QUIET_OCCURRENCES = 1500;

/**
 * When the schedule will next actually fire, or null if none is running.
 *
 * `quietHours` is optional and defaults to none, so a caller that has no
 * business reading the configuration still gets the plain cron answer.
 *
 * Occurrences inside the quiet window are stepped over rather than reported:
 * runTask refuses them, so announcing one meant the dashboard counted down to a
 * test that never happened, then silently reset to the next - all night, with
 * nothing saying why.
 */
export const nextRun = (cron = currentCron, quietHours = null, timezone = currentTimezone) => {
    if (!cron || !isValidCron(cron, CRON_OPTIONS)) return null;

    try {
        // The same zone the job itself was scheduled in, or this announces a
        // different moment from the one that will happen - and the countdown on
        // the status bar is built from exactly this answer.
        const schedule = CronExpressionParser.parse(cron,
            isValidTimezone(timezone) ? {tz: timezone} : undefined);
        const zone = zoneFromName(timezone);

        for (let stepped = 0; stepped < MAX_QUIET_OCCURRENCES; stepped++) {
            const occurrence = schedule.next().toDate();

            if (!isQuietHour(occurrence, quietHours?.start, quietHours?.end, zone))
                return occurrence.toISOString();
        }

        return null;
    } catch {
        return null;
    }
};

/**
 * Whether now falls inside the daily window the operator set aside.
 *
 * Read fresh on every run rather than held: the window can be changed between
 * two tests, and a cached copy would go on silencing the old hours.
 *
 * Exported for the round loop in tasks/speedtest.js, which asks it again
 * between members - the window can begin during a round the same way it can
 * begin during the schedule offset's sleep. That import closes a module cycle
 * (this file imports the round's create), which is safe because both sides
 * only call across it at runtime, never while the modules are still loading.
 */
export const withinQuietHours = async () => isQuietHour(new Date(),
    await config.getValue("quietHoursStart"), await config.getValue("quietHoursEnd"),
    // Read fresh alongside the window, not taken from currentTimezone: the two
    // are always changed together (a timezone change restarts the schedule), and
    // reading the same source as the window keeps them from disagreeing if that
    // ever stops being true.
    zoneFromName(await config.getValue("timezone")));

// `options` is unpacked inside the body rather than destructured in the
// signature, for the reason tasks/speedtest.js's create() gives: the suite
// reads this function through bodyOf(), which balances the first brace after
// the declaration.
export const runTask = async (options = undefined) => {
    // A run asked for now - RUN_TEST_ON_STARTUP - rather than one the schedule
    // reached. It takes no offset: the offset spreads a fleet's ticks across
    // the hour, and a boot is not a tick - sleeping up to five minutes here
    // only let a real tick land first and drop this one as an overlap. Every
    // other guard still holds. The pause is someone asking for no tests at
    // all, and the quiet hours bind the round itself, member by member, for
    // an "auto" run - so waving it through here would only move the refusal.
    const immediate = options?.immediate === true;

    if (pauseController.currentState) {
        console.warn("Speedtests currently paused. Trying again later...");
        return;
    }

    // Captured before the first await, so a teardown during any of the config
    // reads or the delay counts against this run. It has to precede the quiet
    // hours check below rather than follow it: that check awaits two config
    // reads of its own, and a schedule replaced while they were in flight would
    // otherwise be captured here as the new generation - leaving this run
    // looking current and firing one test from a schedule that no longer
    // exists, which is the whole thing the counter exists to catch.
    const startedIn = generation;

    // Only the scheduled runs are held to the quiet hours. A test started by
    // hand is someone asking for one now, and create() is reached directly for
    // those - refusing it here would be a fault rather than a courtesy.
    if (await withinQuietHours()) {
        console.warn("Within the configured quiet hours. Skipping this test...");
        return;
    }

    // The rate-limit holds are consulted inside the round rather than here:
    // they are per provider, and a mixed round should skip only the provider
    // that refused, not the iperf3 box standing next to it.
    // Not even read for an immediate run: the answer would not be consulted.
    const scheduleOffset = immediate ? undefined : await config.getValue("scheduleOffset");

    if (scheduleOffset === "true" && currentCron) {
        const delay = getRandomDelay(currentCron);
        console.log(`Schedule offset enabled. Delaying speedtest by ${Math.round(delay / 1000)} seconds...`);
        await delayRun(delay);

        // Checked again on the far side for the same reason the pause is: the
        // offset sleeps for up to five minutes, which is long enough for a run
        // that started just before the quiet hours to wake up inside them.
        //
        // Read before the two guards rather than after them, because reading it
        // is two config reads: asking afterwards left an await between the last
        // guard and the speedtest, so a reschedule or a pause landing while
        // those reads were in flight was seen by no guard at all and one test
        // still fired from the schedule that had just been replaced.
        const quietHoursBegan = await withinQuietHours();

        if (scheduleChangedSince(startedIn)) {
            console.warn("The schedule changed during the delay. Skipping this test...");
            return;
        }

        if (pauseController.currentState) {
            console.warn("Speedtests paused during delay. Skipping this test...");
            return;
        }

        if (quietHoursBegan) {
            console.warn("Quiet hours began during delay. Skipping this test...");
            return;
        }
    }

    await createSpeedtest("auto");
};

export const stopTimer = () => {
    generation++;

    for (const entry of pendingDelays) {
        clearTimeout(entry.id);
        entry.resolve();
    }
    pendingDelays.clear();

    // Truthiness rather than a comparison against undefined, for the reason
    // startTimer gives: node-schedule's null is an absent schedule too, and it
    // walked past this guard into a TypeError that took the shutdown's
    // remaining work - the round's writes, the database close, the child kill -
    // with it.
    if (job) {
        job.cancel();
        job = undefined;
    }

    stopDigests();
};