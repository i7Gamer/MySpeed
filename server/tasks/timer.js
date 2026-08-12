import * as pauseController from '../controller/pause.js';
import * as config from '../controller/config.js';
import schedule from 'node-schedule';
import { isValidCron } from "cron-validator";
import { CronExpressionParser } from "cron-parser";
import { create as createSpeedtest } from './speedtest.js';

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

const getRandomDelay = (cron) => {
    const minDelay = 30 * 1000;
    const maxDelay = calculateMaxDelay(cron);
    return Math.floor(Math.random() * (maxDelay - minDelay + 1)) + minDelay;
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
    job = schedule.scheduleJob(cron, () => runTask());
};

/**
 * When the schedule will next fire, or null if none is running.
 *
 * Approximate when the schedule offset is enabled: that deliberately delays each
 * run by up to a few minutes to avoid every instance testing on the same tick.
 */
export const nextRun = (cron = currentCron) => {
    if (!cron || !isValidCron(cron)) return null;

    try {
        return CronExpressionParser.parse(cron).next().toISOString();
    } catch (e) {
        return null;
    }
};

export const runTask = async () => {
    if (pauseController.currentState) {
        console.warn("Speedtests currently paused. Trying again later...");
        return;
    }

    // Captured before the first await, so a teardown during either the config
    // read or the delay counts against this run.
    const startedIn = generation;

    const scheduleOffset = await config.getValue("scheduleOffset");

    if (scheduleOffset === "true" && currentCron) {
        const delay = getRandomDelay(currentCron);
        console.log(`Schedule offset enabled. Delaying speedtest by ${Math.round(delay / 1000)} seconds...`);
        await delayRun(delay);

        if (scheduleChangedSince(startedIn)) {
            console.warn("The schedule changed during the delay. Skipping this test...");
            return;
        }

        if (pauseController.currentState) {
            console.warn("Speedtests paused during delay. Skipping this test...");
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