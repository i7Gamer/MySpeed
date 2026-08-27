import schedule from 'node-schedule';
import { triggerEvent } from "../controller/integrations.js";
import { getLatest, latestOfTargets } from "../controller/speedtests.js";
import * as targetsController from "../controller/targets.js";
import { isFailedTest } from "../util/testOutcome.js";
import errorHandler from "../util/errorHandler.js";

let currentState = "ping";
let job;

export const setState = (state = "ping") => {
    currentState = state;
};

/**
 * Whether a failure that was actually reported is still standing.
 *
 * This used to be a bare getLatest(): the newest row of the instance, which
 * with one provider was the same question. It is not with targets. The two
 * per-test events are gated on `target.alerts` (tasks/speedtest.js), so the
 * diagnostic iperf3 box models/Targets.js describes can fail because the
 * machine is asleep, notify nobody by design, and still be the newest row in
 * the table - and the keep-alive then pinged /fail once a minute on its behalf,
 * taking down the check that watches the line somebody actually cares about,
 * for the whole hour until the next round.
 *
 * So the scope is the targets whose results the alerting speaks for, and the
 * row is the newest among them - not the newest of one chosen member of them.
 * healthChecks sends testFailed to /fail and testFinished to the root URL, so
 * the check already carries whichever of those fired last; reading one target
 * would have the keep-alive take back a /fail that a *second* alerting target
 * had just earned, which is the overwrite that routing exists to prevent.
 *
 * alertingScope answers null only when there is no target at all - the
 * pre-migration install, and the demo, whose rows carry no targetId - and there
 * the instance-wide latest is the only answer there is. An empty scope is the
 * other question and gets the other answer: targets exist and none of them
 * alert, so nothing is being watched and there is nothing to report.
 */
const reportedFailureStands = async () => {
    const scope = targetsController.alertingScope(await targetsController.listAll());

    return isFailedTest(scope === null ? await getLatest() : await latestOfTargets(scope));
};

/**
 * The keep-alive, carrying how the last test went.
 *
 * healthChecks sends this ping to a different endpoint while a failure stands,
 * because its usual one is healthchecks.io's success URL and using it a minute
 * after /fail took the failure back. The outcome is read from the stored tests
 * on every ping rather than remembered in a module variable: a restart between
 * a failed test and the next one would forget a remembered flag and mark the
 * check up, which is the same overwrite waiting for a `docker restart` - and a
 * restart is exactly when somebody is looking.
 *
 * isFailedTest answers false for the undefined either read returns on an install
 * that has never tested, which is the right answer: nothing has failed there.
 */
export const sendPing = async (type, message) => {
    await triggerEvent("minutePassed", {type, message, testFailing: await reportedFailureStands()});
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

    // Caught here, because nothing else does. The tick reads the stored tests
    // to decide where the healthChecks keep-alive goes, so it can reject on a
    // database that has gone away - or one a shutdown already under way has
    // closed, since the signal path closes the handle before the process
    // leaves. Uncaught, that reached index.js's unhandledRejection handler and
    // was reported as a server fault, once a minute.
    //
    // Reported through errorHandler rather than console.error, so it still
    // reaches data/logs/error.log the way the unhandledRejection route did.
    job = schedule.scheduleJob('* * * * *', () => sendCurrent().catch(err =>
        errorHandler(err, {fatal: false, context: "Could not send the keep-alive"})));
};

export const stopTimer = () => {
    if (job !== undefined) {
        job.cancel();
        job = undefined;
    }
};