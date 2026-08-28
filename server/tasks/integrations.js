import schedule from 'node-schedule';
import { triggerEvent } from "../controller/integrations.js";
import { getLatest } from "../controller/speedtests.js";
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
 * So the scope is the targets whose results the alerting speaks for - and
 * within it, a failure stands while *any* watched target's newest result is
 * one. One check stands for every watched line, so it is down while any of
 * them is: reading only the single newest row of the whole scope had the
 * backup line's later success speak for the fibre's standing failure, which
 * on healthchecks' side reads as "everything recovered". This is the same
 * judgement the round's own completion ping makes (healthChecks routes
 * roundFinished by whether anything watched failed), asked of the stored rows
 * so a restart between rounds answers identically.
 *
 * One newest-row read per watched target rather than one clever query: the
 * scope is a handful of ids and each read is an index walk over
 * (targetId, created).
 *
 * alertingScope answers null only when there is no target at all - the
 * pre-migration install, and the demo, whose rows carry no targetId - and there
 * the instance-wide latest is the only answer there is. An empty scope is the
 * other question and gets the other answer: targets exist and none of them
 * alert, so nothing is being watched and there is nothing to report.
 */
const reportedFailureStands = async () => {
    const scope = targetsController.alertingScope(await targetsController.listAll());

    if (scope === null) return isFailedTest(await getLatest());

    const latests = await Promise.all(scope.map((id) => getLatest(id)));

    return latests.some((latest) => isFailedTest(latest));
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

/**
 * The round's one completion, pairing the one testStarted.
 *
 * The member events above fire once per target, which is right for the sinks
 * that describe tests - a webhook per result, a template per failure - and
 * wrong for a sink that models a run: healthchecks.io opens a timing window
 * on /start and closes it on the next ping, so N member pings answered one
 * start and the last member won, a watched failure taken back seconds later
 * by the next member's success. This carries the round's own verdict, fired
 * once from the round's finally.
 *
 * @param payload {failed, failures, members}: whether anything watched failed,
 *        how many watched members did, and how many members the round had.
 */
export const sendRoundFinished = async (payload) => {
    await triggerEvent("roundFinished", payload);
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