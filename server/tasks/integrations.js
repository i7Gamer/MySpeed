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
 * How long a hand run's result still speaks for the line that produced it.
 *
 * A failure stands until something newer replaces it, and for a scheduled
 * target something newer arrives every round. A target that runs only by hand
 * has no next round: alertingScope deliberately includes it - a disabled
 * target still alerts, so that its own failure can put the check down and its
 * own success can take it back up - so asking each watched target separately
 * left its last answer standing for ever. One hand run that failed months ago
 * pinned the check to /fail for the life of the install while every scheduled
 * line measured perfectly.
 *
 * A day, which is the span /status already calls recent, and long enough that
 * a failure somebody has just seen is still reported while a verdict about a
 * line nobody is measuring falls silent.
 *
 * Exported for the test that asks where the boundary falls, which has a `now`
 * to pass and no wish to wait a day for it.
 */
const RESULT_SPEAKS_FOR_HOURS = 24;
export const RESULT_SPEAKS_FOR_MS = RESULT_SPEAKS_FOR_HOURS * 60 * 60 * 1000;

/**
 * Whether a stored row still describes its line now.
 *
 * The horizon applies to a target nothing re-measures, and to no other, which
 * it did not: applied to every target it says the opposite of what it means.
 * healthchecks' bare URL is the *success* endpoint and the keep-alive pings
 * every minute by design - it is also the only signal that MySpeed itself is
 * alive - so silence is not among the things it can say. "This verdict is too
 * old to speak" therefore came out as "the line is up", and an instance that
 * was paused, stopped or simply measuring on a weekly cron reported every
 * watched line healthy while the newest thing it had measured was a failure.
 *
 * So a scheduled line's verdict stands until its next round replaces it,
 * however long that round takes to come - which is also why no date is read
 * for one. Only a line nothing is going to measure again is aged out, and
 * there a row whose stamp cannot be read - an imported history can carry one -
 * is not allowed to hold the check down on the strength of a date nobody can
 * check.
 *
 * The flag is read loosely on purpose: sqlite hands booleans back as 0/1 under
 * the global raw mapping, so `enabled === false` matches nothing at all and
 * would leave every target ageing out exactly as before.
 */
const stillSpeaks = (target, row, now) => {
    if (target.enabled) return true;

    const measured = Date.parse(row?.created);

    return Number.isFinite(measured) && now - measured <= RESULT_SPEAKS_FOR_MS;
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
 * the instance-wide latest is the only answer there is. That install has one
 * line and the global cron re-measures it, with no schedule flag to read, so
 * nothing ages out on that path and the newest row is simply the answer. An
 * empty scope is the other question and gets the other answer: targets exist
 * and none of them alert, so nothing is being watched and there is nothing to
 * report.
 *
 * Exported because the round asks it too: a round that skipped the failing
 * line - held by a provider refusal, cut short by a pause - would otherwise
 * report itself clean and take the check up a minute before this read put it
 * back down. One question, asked in both places, so the two cannot disagree
 * about the same lines.
 */
export const watchedFailureStands = async (now = Date.now()) => {
    const all = await targetsController.listAll();
    const scope = targetsController.alertingScope(all);

    if (scope === null) return isFailedTest(await getLatest());

    // The scope as rows rather than as ids: whether a verdict is still current
    // is a question about the target's schedule, and reading it off the scope
    // itself is what keeps the two from drifting into disagreeing about which
    // lines are watched.
    const watched = all.filter((target) => scope.includes(target.id));

    const verdicts = await Promise.all(watched.map(async (target) =>
        ({target, row: await getLatest(target.id)})));

    return verdicts.some(({target, row}) => isFailedTest(row) && stillSpeaks(target, row, now));
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
    await triggerEvent("minutePassed", {type, message, testFailing: await watchedFailureStands()});
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

// Truthiness rather than a comparison against undefined, for the reason
// tasks/timer.js gives: node-schedule's null is an absent schedule too. The
// spec here is a literal that always compiles, so null cannot reach this
// today - which is the kind of assumption a later edit to the spec breaks.
export const stopTimer = () => {
    if (job) {
        job.cancel();
        job = undefined;
    }
};