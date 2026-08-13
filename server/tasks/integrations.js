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

/**
 * @param payload the failure as an object, carrying at least `error`.
 *
 * It used to be the bare message string, which every module then had to wrap
 * back into `{error}` before it could substitute it - so a failure notification
 * could name the reason and nothing else, not even which provider could not
 * complete, which is the first thing a reader of the error wants.
 */
export const sendError = async (payload = {error: "Unknown error"}) => {
    await triggerEvent("testFailed", payload);
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