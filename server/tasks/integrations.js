import schedule from 'node-schedule';
import { triggerEvent } from "../controller/integrations.js";

let currentState = "ping";
let job;

export const setState = (state = "ping") => {
    currentState = state;
};

export const sendPing = async (type, message) => {
    await triggerEvent("minutePassed", {type, message});
};

export const sendCurrent = async () => {
    if (currentState === "ping") await sendPing();
};

export const sendError = async (error = "Unknown error") => {
    await triggerEvent("testFailed", error);
};

export const sendRunning = async () => {
    await triggerEvent("testStarted");
};

export const sendFinished = async (data) => {
    await triggerEvent("testFinished", data);
};

/** The scheduled job, for the tests that assert it was cancelled. */
export const currentJob = () => job;

export const startTimer = () => {
    // Same reason as the speedtest timer: the module holds one job reference,
    // and overwriting it leaves the old minute job in node-schedule's registry
    // pinging every integration a second time, every minute, forever.
    stopTimer();

    job = schedule.scheduleJob('* * * * *', () => sendCurrent());
};

export const stopTimer = () => {
    if (job !== undefined) {
        job.cancel();
        job = undefined;
    }
};