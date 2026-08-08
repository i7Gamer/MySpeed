import * as pauseController from '../controller/pause.js';
import * as config from '../controller/config.js';
import schedule from 'node-schedule';
import { isValidCron } from "cron-validator";
import { CronExpressionParser } from "cron-parser";
import { create as createSpeedtest } from './speedtest.js';

let job;
let currentCron;

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

    const scheduleOffset = await config.getValue("scheduleOffset");
    
    if (scheduleOffset === "true" && currentCron) {
        const delay = getRandomDelay(currentCron);
        console.log(`Schedule offset enabled. Delaying speedtest by ${Math.round(delay / 1000)} seconds...`);
        await new Promise(resolve => setTimeout(resolve, delay));

        if (pauseController.currentState) {
            console.warn("Speedtests paused during delay. Skipping this test...");
            return;
        }
    }

    await createSpeedtest("auto");
};

export const stopTimer = () => {
    if (job !== undefined) {
        job.cancel();
        job = undefined;
    }
};

export { job };