import * as pauseController from '../controller/pause.js';
import * as config from '../controller/config.js';
import schedule from 'node-schedule';
import { isValidCron } from "cron-validator";
import { CronExpressionParser } from "cron-parser";
import { create as createSpeedtest } from './speedtest.js';
import { isQuietHour } from '../util/quietHours.js';
import errorHandler from "../util/errorHandler.js";

let job;
let currentCron;

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
    const entry = {resolve};

    entry.id = setTimeout(() => {
        pendingDelays.delete(entry);
        resolve();
    }, ms);

    pendingDelays.add(entry);
});

const calculateMaxDelay = (cron) => {
    try {
        const parser = CronExpressionParser.parse(cron);
        const next1 = parser.next().getTime();
        const next2 = parser.next().getTime();
        const intervalMs = next2 - next1;
        const intervalMinutes = intervalMs / 60000;

        if (intervalMinutes <= 1) {
            return 30 * 1000; // 30 seconds
        } else if (intervalMinutes <= 30) {
            return 2 * 60 * 1000; // 2 minutes
        } else if (intervalMinutes <= 60) {
            return 3 * 60 * 1000; // 3 minutes
        } else {
            return 5 * 60 * 1000; // 5 minutes
        }
    } catch {
        return 2 * 60 * 1000; // Default to 2 minutes if parsing fails
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

export const startTimer = (cron) => {
    if (!isValidCron(cron)) return;

    // Before the assignment, not left to the caller. Every caller happens to
    // stop first today, but the module holds exactly one job reference and
    // overwriting it drops the only handle that could cancel what it replaced -
    // node-schedule keeps firing it, so a changed cron would have run both
    // schedules for the rest of the process.
    stopTimer();

    currentCron = cron;

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
    job = schedule.scheduleJob(cron, () => runTask().catch(err =>
        errorHandler(err, {fatal: false, context: "The scheduled speedtest failed"})));
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
export const nextRun = (cron = currentCron, quietHours = null) => {
    if (!cron || !isValidCron(cron)) return null;

    try {
        const schedule = CronExpressionParser.parse(cron);

        for (let stepped = 0; stepped < MAX_QUIET_OCCURRENCES; stepped++) {
            const occurrence = schedule.next().toDate();

            if (!isQuietHour(occurrence, quietHours?.start, quietHours?.end))
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
 */
const withinQuietHours = async () => isQuietHour(new Date(),
    await config.getValue("quietHoursStart"), await config.getValue("quietHoursEnd"));

export const runTask = async () => {
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

    const scheduleOffset = await config.getValue("scheduleOffset");

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

    if (job !== undefined) {
        job.cancel();
        job = undefined;
    }
};

export { job };