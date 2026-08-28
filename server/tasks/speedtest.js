import speedTest, { isShuttingDown } from '../util/speedtest.js';
import * as tests from '../controller/speedtests.js';
import * as config from '../controller/config.js';
import * as controller from "../controller/recommendations.js";
import * as parseData from '../util/providers/parseData.js';
import { setState, sendRunning, sendError, sendFinished, sendRoundFinished, watchedFailureStands }
    from "./integrations.js";
import * as serverController from "../controller/servers.js";
import { toErrorMessage } from '../util/helpers.js';
import { PHASE_ORDER, PHASE_START, overallProgress } from '../util/providers/progress.js';
import { failedPayload, finishedPayload } from '../util/notificationPayload.js';
import { FAILED_TEST, UNMEASURED_LATENCY, impossibleMeasurement, isFailedTest, isMeasuredLatency, usableFigure }
    from '../util/testOutcome.js';
import { isRateLimitMessage } from '../util/providers/cliOutput.js';
import { backoffRemainingMs, clearBackoff, isBackingOff, recordRateLimit } from '../util/rateLimitBackoff.js';
import * as targetsController from '../controller/targets.js';
import * as pauseController from '../controller/pause.js';
// A module cycle closed on purpose - timer.js imports create() from here. Safe
// because each side only calls across it at runtime; see the export's docstring.
import { withinQuietHours } from './timer.js';
import errorHandler from '../util/errorHandler.js';
import { outageFrom } from '../util/databaseOutage.js';

// The placeholder a failed test stores in every numeric column. The client
// tells a failure apart by it, so it is not a value anyone should read as one.
// Taken from the module that owns the judgement rather than declared again:
// this is the writer, and the alert gate is a reader whose correctness depends
// on the two matching.
const FAILED = FAILED_TEST;

let _isRunning = false;

// What the run currently in flight is doing. Only ever read through
// getProgress(), and reset the moment a run ends so a finished test cannot
// leave a stale bar sitting at 80% until the next one starts.
// Progress is null rather than 0 until a provider actually reports some. Only
// the Ookla CLI does: librespeed's --json suppresses its verbose output and
// cfspeedtest's silences everything but the result, so those runs never report
// a fraction at all and must not be drawn as one sitting at zero.
// `target` names the round member currently measuring - null outside a round
// and on instances from before targets existed, so every added field is
// additive and /status keeps its shape for an older reader.
const NO_PROGRESS = {phase: null, progress: null, speed: null, startedAt: null, target: null};

let _progress = {...NO_PROGRESS};

export const getProgress = () => ({..._progress});

const updateProgress = ({phase, progress, speed}) => {
    _progress = {
        phase,
        progress: overallProgress(phase, progress),
        // The latency phase measures no throughput, so it reports none rather
        // than leaving the previous phase's figure on screen.
        speed: speed ?? null,
        startedAt: _progress.startedAt,
        target: _progress.target
    };
};

/**
 * Marks the next round member as the one measuring. The phase and fraction
 * start over - they describe this target's run, not the round - while
 * startedAt keeps the round's own beginning, which is what the elapsed
 * counter in the status bar counts.
 */
const beginTarget = (target, index, count) => {
    _progress = {
        ..._progress,
        phase: PHASE_START,
        progress: null,
        speed: null,
        target: target.id === null ? null : {id: target.id, name: target.name, index, count}
    };
};

const setRunning = (running, sendRequest = true) => {
    _isRunning = running;

    if (running) {
        _progress = {...NO_PROGRESS, phase: PHASE_START, startedAt: new Date().toISOString()};
        setState("running");
        // Caught with context, the way sendFinished and sendError are. This
        // used to be sent through a bare then with no handler - which handles
        // nothing - so a rejection here, the same database read that can fail
        // inside triggerEvent, escaped to the process-level hook and was
        // logged as a bare server fault naming nothing.
        if (sendRequest) sendRunning().catch(err =>
            console.error(`Could not notify the integrations: ${toErrorMessage(err)}`));
    } else {
        _progress = {...NO_PROGRESS};
        setState("ping");
    }
}

// How many successful tests the recommended targets are read from. Fewer says
// too little about the line to recommend anything. Exported for the suite that
// seeds exactly one sample's worth of rows.
export const RECOMMENDATION_SAMPLE = 10;

// What a ping has to be before it counts as something that was measured: a
// reading, and a positive one. FAILED sits below every real latency, so a failed
// row that reaches the sample anyway - one whose error column somehow stayed
// null - would otherwise take "lowest ping" from every genuine test beside it,
// and the fabricated zero above it would do the same. Asked through
// isMeasuredLatency rather than spelled again here: the statistics and the alert
// gate judge this exact question, and a third answer is what put a 0 ms target
// on the recommendation card beside a page that would not average the same row.
const lowestRealPing = (ping) => isMeasuredLatency(ping) && ping > UNMEASURED_LATENCY;

/**
 * Exported for its tests. Filtering failures out of listTests() - whose default
 * limit is 10 rows *including* failures - meant one failed test among the
 * newest ten shrank the sample below the required size, and the recommendations
 * silently stopped updating until the failure aged out of the newest page.
 */
export const createRecommendations = async () => {
    // The sample describes one line, so it comes from one target: the first
    // scheduled one that takes part in alerting. A gigabit LAN box mixed into
    // the sample would recommend numbers no WAN target can meet.
    //
    // Preferred, not required. An instance whose targets all have alerts off -
    // or all run by hand - still has a first line, and "none alerts" must not
    // mean the recommendation card freezes at whatever the line looked like
    // before the flags changed. The fallbacks keep the same reading order the
    // preference has: the round's first member, then the first target on record.
    const primary = await targetsController.alertsTarget()
        ?? await targetsController.primaryTarget()
        ?? (await targetsController.listAll())[0];
    if (!primary) return;

    const list = await tests.listSuccessful(RECOMMENDATION_SAMPLE, primary.id);
    if (list.length < RECOMMENDATION_SAMPLE) return;

    let recommendations = {ping: Infinity, down: 0, up: 0};
    for (const entry of list) {
        const {ping, download, upload} = entry;

        // Number.isFinite with no typeof beside it: it coerces nothing, so every
        // non-number is already out. That matters because sqlite keeps whatever
        // it was handed, and a history imported before importTests() checked its
        // numeric columns can still hold an empty string in one - which compares
        // as zero and so took "lowest ping" from the whole sample.
        if (lowestRealPing(ping) && ping < recommendations.ping)
            recommendations.ping = ping;

        if (Number.isFinite(download) && download > recommendations.down)
            recommendations.down = download;

        if (Number.isFinite(upload) && upload > recommendations.up)
            recommendations.up = upload;
    }

    // Nothing in the sample measured a latency, so there is nothing to
    // recommend. Falling through handed the untouched Infinity to the
    // controller, whose Math.round() passes it along unchanged, and the row came
    // back with a null ping beside a perfectly good download and upload.
    if (!Number.isFinite(recommendations.ping)) return;

    await controller.update(recommendations.ping, recommendations.down, recommendations.up);
}

/** How long the demo pretends a test takes. */
export const PREVIEW_RUN_MS = 5000;

// Enough steps that the bar visibly glides, spaced widely enough that the
// simulation is not busywork - previewProgress.test.js holds the two apart.
const PREVIEW_STEPS_PER_PHASE = 4;

/**
 * The march the demo bar makes, as data. Exported for its tests.
 *
 * The real phases in their real order, each walked to completion, with no
 * speed - a figure for a measurement that never happened would be the bar
 * lying rather than pretending. The latency phase of a real run reports the
 * same null.
 */
export const previewProgressSteps = () =>
    PHASE_ORDER.flatMap((phase) => Array.from({length: PREVIEW_STEPS_PER_PHASE},
        (_, step) => ({phase, progress: (step + 1) / PREVIEW_STEPS_PER_PHASE, speed: null})));

const simulatePreviewRun = async () => {
    const steps = previewProgressSteps();
    const stepMs = PREVIEW_RUN_MS / steps.length;

    for (const step of steps) {
        await new Promise(resolve => setTimeout(resolve, stepMs));
        updateProgress(step);
    }
};

/**
 * Which server a run measures against: the target's own backend where it has
 * one, the server it pins where it pins one, and whatever the provider chooses
 * otherwise.
 *
 * `retryAuto` is the automatic second attempt, and what it drops is the *pin*.
 * That is what the fallback is for - a pinned server that has degraded or died
 * fails every run against it, and the retry asks the provider to choose one
 * instead.
 *
 * It does not drop the endpoint, which used to go with it. A pin is a
 * preference among the provider's own servers; an endpoint is which line is
 * being measured. A retry without it measured the *public* fleet and stored the
 * answer under this target's id, so the history said the operator's own backend
 * had delivered a number it never produced - and a target carrying an endpoint
 * records no server id, so nothing on the row said otherwise.
 *
 * Its own function because that is the only way the decision can be tested: the
 * two suites that pin the retry read the source for its condition, and neither
 * could see the arguments it ran with.
 */
export const serversFor = (target, retryAuto = false) => {
    const serverUrl = target.endpoint ?? undefined;

    // An endpoint already names the server, so a pin alongside it would be a
    // second answer to a question that has one.
    if (serverUrl) return {serverId: undefined, serverUrl};

    return {serverId: retryAuto ? undefined : (target.serverId ?? undefined), serverUrl: undefined};
};

export const run = async (target, retryAuto = false) => {
    const mode = target.provider;

    let {serverId, serverUrl} = serversFor(target, retryAuto);

    // The callback is carried whichever server was chosen: the retry is the
    // same logical run, and a bar that stopped moving the moment a test fell
    // back to automatic server selection would read as the run having hung.
    let speedtest = await speedTest(mode, serverId, serverUrl, updateProgress);

    // Recorded on the row, not written back into the configuration. Persisting
    // it turned "choose automatically" into a pin the moment the first test
    // finished: the dialog still offered the option, but selecting it lasted
    // exactly one run, and nothing on screen said the server had been fixed.
    // A pinned server that later degrades makes the line look slower with no
    // explanation, and one that dies costs a full attempt - up to the CLI's
    // three-minute timeout - before the run falls back to automatic.
    if (mode === "ookla" && speedtest.server) {
        serverId = speedtest.server?.id;
    }

    if (mode === "libre" && speedtest.server && !serverUrl) {
        let serverEntry = Object.entries(serverController.getLibreServers())
            .filter(([, value]) => value === speedtest.server.name)[0];

        if (serverEntry) {
            serverId = parseInt(serverEntry[0]);
        }
    }

    if (Object.keys(speedtest).length <= 1) throw {message: "No response, even after trying again, test timed out."};

    return {...speedtest, serverId}
}

/**
 * The stand-in a demo round runs instead of a stored target. Its null id keeps
 * targetId off the fabricated rows, and alerts stays on so a demo behaves the
 * way the single-provider instance always did.
 */
const PREVIEW_TARGET = Object.freeze({id: null, name: null, provider: "preview", alerts: true});

const roundMembers = async (targetId) => {
    if (process.env.PREVIEW_MODE === "true") return [PREVIEW_TARGET];

    if (targetId !== undefined) {
        const one = await targetsController.getOne(targetId);
        return one ? [one] : [];
    }

    return await targetsController.roundTargets();
};

/**
 * Whether the provider is still inside the hold a refusal earned, and says so
 * when it is. Asked per round member rather than once for the round: the holds
 * are per provider, and an Ookla refusal is no reason to skip the iperf3 box
 * standing next to it.
 */
const MS_PER_MINUTE = 60_000;

const heldByBackoff = (provider) => {
    const remaining = backoffRemainingMs(provider);

    if (remaining === 0) return false;

    console.warn(`The ${provider} provider refused the last test for too many requests. `
        + `Skipping its targets this round - trying again in ${Math.ceil(remaining / MS_PER_MINUTE)} minutes.`);

    return true;
};

/**
 * Whether a hold stands over this member, on a round of this type.
 *
 * The one owner of that judgement, because it is asked from two places now:
 * once over the whole round before it announces itself, and once per member as
 * the round reaches it. Spelling "only the scheduled rounds honour a hold"
 * twice is how the two come to disagree, and the disagreement that matters here
 * is a round that tells every notifier a test started and then runs nobody.
 *
 * Only the scheduled rounds honour a hold - a test started by hand is somebody
 * asking for one now, the rule the quiet hours already follow for the reason
 * their own module gives.
 *
 * `isHeld` is a parameter for the same reason recordRateLimit takes its own
 * `now`: the decision can then be walked without the module-level hold map,
 * which this suite has no way to reach into. It is also what lets the two
 * callers differ in the one way they should - the loop asks through
 * heldByBackoff, which says in the log which target it is skipping and for how
 * long, and roundFullyHeld asks quietly, so a partly held round does not warn
 * about the same member twice.
 */
export const memberHeld = (target, type, isHeld) => type === "auto" && isHeld(target.provider);

/**
 * Whether the round has nothing at all that it may run.
 *
 * Asked before the round announces itself, because announcing is not free:
 * setRunning(true) fires testStarted at every notifier - healthchecks.io's
 * /start, every webhook's TEST_STARTED - and a round whose every member was
 * held announced a test it then never ran and never finished. On the minutely
 * cron the installer scripts hand out that is one /start a minute that nothing
 * ever completes, for the fifteen minutes to two hours the hold stands: the
 * check sits permanently "running" and alerts on its own grace period, and
 * every webhook is told a test started once a minute. That is the notification
 * storm util/rateLimitBackoff.js was written to end, not to relocate.
 *
 * It does not replace the per-member skip in the loop and could not. That one
 * is re-asked as the round reaches each member, which is what skips members two
 * and three of three Ookla targets when member one has just been refused; this
 * one is answered before any member has run and can only ever know about a hold
 * that was already standing.
 *
 * An empty round is not a held one. Nothing reaches this with no members -
 * executeRound has answered 400 long before - but "every" is true of nothing,
 * and a helper that called an empty round held would be a trap for whoever asks
 * it next.
 */
export const roundFullyHeld = (members, type, isHeld = isBackingOff) =>
    members.length > 0 && members.every((target) => memberHeld(target, type, isHeld));

/**
 * When a fully held round could first do something again, in the whole minutes
 * an operator reading the log can act on.
 *
 * The soonest of its members' holds rather than the longest: that is the moment
 * the round stops being fully held and starts measuring something. Rounded the
 * way heldByBackoff rounds its own line, so the two never disagree by a minute
 * about the same wait.
 */
const nextAttemptMinutes = (members) =>
    Math.ceil(Math.min(...members.map((target) => backoffRemainingMs(target.provider))) / MS_PER_MINUTE);

/**
 * Takes the round latch without starting a round, so a caller that cannot
 * await create() can still find out whether its round will run.
 *
 * POST /speedtests/run answers before the round ends - a proxy would time out
 * otherwise - and create() *returns* its refusals rather than throwing, so a
 * request that lost the race to another one was told 200 "successfully
 * created" while its round was refused into the void: a success toast for a
 * test that never existed. The route takes the latch with this before it
 * answers, and hands it to create() via {reserved: true}; a caller that
 * cannot take it is told 409, the same answer a visible run gets.
 *
 * Synchronous on purpose, like the check in create(): an await between asking
 * and taking is exactly the gap two requests slip through.
 */
export const tryReserve = () => {
    if (_isRunning) return false;

    _isRunning = true;
    return true;
};

/** Gives a reservation back without running anything - the caller's error paths. */
export const cancelReservation = () => {
    _isRunning = false;
};

// `options` is unpacked inside the body rather than destructured in the
// signature: the suite reads this function through bodyOf(), which balances
// the first brace after the declaration - and a `{reserved = false}` parameter
// (or a `= {}` default) is a brace before the body.
export const create = async (type = "auto", targetId = undefined, options = undefined) => {
    const reserved = options?.reserved ?? false;

    // The guard has to latch synchronously: POST /speedtests/run no longer awaits
    // this call, so checking after an await would let two requests slip past.
    // One latch for the whole round - targets run strictly in sequence, which
    // is also what keeps util/speedtest.js's single activeProcess invariant.
    // A reserved caller took the very same latch through tryReserve already;
    // checking it again here would refuse the round the reservation was for.
    if (!reserved && _isRunning) {
        // Named rather than swallowed. A round of several members can outlast
        // the schedule interval - one unreachable iperf3 target costs two CLI
        // timeouts before the round moves on - and a tick dropped in silence
        // looks from the outside exactly like the scheduler having stopped:
        // no failed row, nothing in the log, and /status still reporting a run
        // in progress. The tick is still dropped; it just says so.
        console.warn("A speedtest round is still running - skipping this scheduled one.");
        return 500;
    }
    _isRunning = true;

    try {
        return await executeRound(type, targetId);
    } finally {
        // The one guarantee that the latch is dropped however this ends. It
        // used to be cleared only on the paths that were thought of, so a throw
        // from the failure handler - which is where a broken database or a
        // failing notification surfaces - wedged every later speedtest.
        _isRunning = false;
    }
}

/**
 * How many members in a row may fail to record before the round gives up.
 *
 * One is not evidence about the database. models/Speedtests.js has the case that
 * proves it: MySQL in strict mode refused a stderr longer than the column, from
 * inside the very handler that records a failed test - a refusal about that row's
 * text, which the next member with a shorter message does not share. Two in a
 * row is no longer about a row, whatever the errors call themselves, and all
 * that carrying on buys then is another minute of CLI time measuring a line
 * whose result has nowhere to go.
 *
 * It is also what covers the ways a database can go that databaseOutage.js
 * cannot name: an unrecognised outage costs one extra member, not the round.
 */
const MAX_CONSECUTIVE_ESCAPES = 2;

/**
 * How a member is named in a report. The demo target has neither a name nor an
 * id - it is a frozen stand-in rather than a row - and "target null" tells an
 * operator reading error.log nothing whatsoever.
 */
const memberName = (target) => {
    if (typeof target?.name === "string" && target.name !== "") return `The target "${target.name}"`;
    if (target?.id === null || target?.id === undefined) return "The demo target";

    return `The target #${target.id}`;
};

/** A round of two says "1 target" as often as it says "3 targets". */
const counted = (count) => `${count} ${count === 1 ? "target" : "targets"}`;

/**
 * What a failure that escaped a member's own handler means for the round.
 *
 * Nothing is supposed to reach here: executeTarget handles every failure it can
 * describe. What it cannot handle is its own recording failing, which is the one
 * way in - a rejection out of the tests.create that writes the row saying the
 * test failed.
 *
 * Two answers, together because they are one judgement: whether the round can
 * still do anything useful, and what the operator is told about the member that
 * could not. Pure and exported because the real path needs a database that
 * breaks halfway through a round, which nothing here can arrange.
 *
 * @param error whatever escaped, exactly as it was thrown.
 * @param target the member it escaped from.
 * @param escapes how many members in a row have now failed to record, this one
 *        included.
 * @param remaining how many members of the round have not run yet.
 */
export const memberFailure = (error, target, {escapes = 1, remaining = 0} = {}) => {
    const outage = outageFrom(error);
    const abandoned = outage || escapes >= MAX_CONSECUTIVE_ESCAPES;
    const opening = `${memberName(target)} could not record its result`;

    if (!abandoned) return {
        abandoned: false,
        context: remaining === 0
            ? `${opening}, and it was the last member of the round`
            : `${opening} - the round carries on to its remaining ${counted(remaining)}`
    };

    return {
        abandoned: true,
        context: `${opening}, and ${outage
            ? "the database is not answering"
            : "neither could the member before it"}`
            + (remaining === 0 ? "" : ` - abandoning the round, leaving ${counted(remaining)} unmeasured`)
    };
};

/**
 * Why a round found nothing to run, in the line the log gets.
 *
 * Said out loud for the reason create()'s "still running" branch says its
 * piece: the 400 below is returned to whoever awaited create(), and neither
 * caller reads it - timer.js discards the answer, and the manual run route
 * deliberately does not await it. A round that found nothing therefore left no
 * row, no failure and nothing in the log, which from the outside is
 * indistinguishable from the scheduler having stopped. The route refuses the
 * unnamed case ahead of time now; the scheduled tick still arrives here, and
 * this is the only place it can say so.
 *
 * The two empty rounds are reported apart because they are different
 * situations. An install with no targets at all is waiting to be set up - and
 * on the default hourly cron it would otherwise be told once an hour that
 * every target has its schedule switched off, which is a false statement about
 * an install that has none. An install with targets that are all outside the
 * schedule is configured and has switched itself off.
 *
 * Pure and exported for the reason memberFailure is: the wording is the whole
 * of the fix, and the suite has to be able to ask for it without a database.
 */
export const emptyRoundReason = (targetId, targetCount) => {
    if (targetId !== undefined)
        return `The target ${targetId} was gone by the time its run started - nothing was measured.`;

    return targetCount === 0
        ? "No target is configured, so this round measured nothing. Add one in the test targets dialog."
        : "Every target has its schedule switched off, so this round measured nothing.";
};

/**
 * Why a member the round has just reached must not run, or null when it may.
 *
 * The member list is read once when the round starts, and a round of several
 * members takes minutes - one unreachable iperf3 box costs two CLI timeouts
 * before the loop moves on. A target edited in that window was still measured
 * with its old configuration and the row filed under its id: the old box's
 * numbers, attributed to whatever the id names now. So the loop re-reads each
 * member from the table as it reaches it, and this is the judgement it applies
 * to what it finds.
 *
 * `named` is whether the round was started for this target by id - the one way
 * a disabled (manual-only) target ever runs, so for those the flag is not
 * staleness but the design. The flag is read loosely on purpose: sqlite hands
 * booleans back as 0/1 under the raw mapping, and a 0 read as "still
 * scheduled" would defeat the check exactly where it runs.
 *
 * Pure and exported for its tests; the deleted case needs a mid-round delete
 * nothing in a suite can time.
 */
export const staleMemberReason = (fresh, named) => {
    if (!fresh) return "was deleted mid-round - skipping it.";
    if (!named && !fresh.enabled) return "left the schedule mid-round - skipping it.";

    return null;
};

/**
 * The round's verdict for its one completion event.
 *
 * `failures` counts what this round measured, and `failed` answers the wider
 * question the check is actually asked: is any watched line down now. A round
 * can end without reaching the line that is - a provider hold skips its
 * targets, a pause or the quiet hours cut the round short, a member is
 * deleted mid-round - and a round that counted none of its own then pinged
 * the success URL, taking the check up a minute before the keep-alive read
 * the same stored rows and put it back down. One check flapping once a cycle,
 * for the length of the hold.
 *
 * Its own count still stands beside the answer, and still counts: a member
 * that could not even record its failure is a failure this round knows about
 * and the stored rows do not.
 */
const roundOutcome = async (failures, members) => ({
    failed: failures > 0 || await watchedFailureStands(),
    failures,
    members
});

const executeRound = async (type, targetId) => {
    const members = await roundMembers(targetId);

    if (members.length === 0) {
        // The count is read only on this path, and only once the round has
        // already given up, so the extra query costs a working instance
        // nothing. roundMembers has just queried the same table successfully,
        // so this is not where a database outage is expected to surface.
        console.warn(emptyRoundReason(targetId, await targetsController.count()));

        return 400;
    }

    /*
     * A round that may run nobody says nothing to anybody, and above all does
     * not announce itself - see roundFullyHeld for the storm that is the whole
     * point of this guard, and for why it does not replace the per-member skip
     * below.
     *
     * One line about it rather than the loop's one per held member: the loop
     * never runs here, and a warning per member per minute would be the log's
     * half of the same storm. What is worth saying is why the schedule has gone
     * quiet and until when.
     *
     * The code is answered in the vocabulary its two siblings already use - 400
     * for a round with no members, 500 for one that overlapped - and like both
     * of those, nothing reads it today: timer.js discards it, and the manual
     * route answers before the round is over.
     */
    if (roundFullyHeld(members, type)) {
        console.warn("Every target of this round is held after a provider refused for too many requests. "
            + "Skipping the round rather than announcing a test nobody will run - "
            + `trying again in ${nextAttemptMinutes(members)} minutes.`);

        return 429;
    }

    // Once per round, however many members it has: the integrations hear one
    // "running", and the progress clock starts here. A pretended run tells
    // them nothing - a demo has no business firing anybody's webhook. The
    // completion in the finally below mirrors this exact judgement, because
    // an announcement and its answer have to be the same decision.
    const announce = members[0].provider !== "preview";
    setRunning(true, announce);

    // Members that could not record, counted down the round rather than across
    // it - see MAX_CONSECUTIVE_ESCAPES.
    let escapes = 0;

    // Watched members whose run ended in failure - what the round's one
    // completion event reports. Only the watched ones: a diagnostic box with
    // alerts off fails without telling anybody, per member and per round alike.
    let roundFailures = 0;

    try {
        for (const [index, target] of members.entries()) {
            // The shutdown has just killed the member in flight, and the round
            // is what carries on past it: the next target spawns a CLI after
            // the one moment terminateActiveProcess could reach it - the orphan
            // trackProcess exists to prevent, rebuilt one member further along -
            // and writes its result into a handle onCleanup has closed.
            //
            // Above beginTarget rather than below it: that is what /status
            // reads to name the target measuring, and stopping underneath it
            // leaves the bar advertising a member the round never started.
            if (isShuttingDown()) break;

            // The member as the table has it when the round reaches it, named
            // out here so the handler below can report what it was working on
            // even when the read that was to fetch it is what failed.
            let fresh;

            /*
             * A member that cannot even record its own failure must not take the
             * rest of the round with it. executeTarget handles everything it can
             * describe; what it cannot handle is its own recording failing - the
             * last unguarded await in that catch is the tests.create that writes
             * the row saying the test failed - and that rejection used to leave
             * the loop through the finally below. Targets three, four and five
             * of a five-member round were then never measured and recorded
             * nothing at all: no row, no error, no notification, and one line
             * from timer.js naming neither the round nor the members it dropped.
             * A round was a single test before targets existed, so this had
             * nothing to lose.
             *
             * The guards below are inside it for the same reason, which they
             * were not: they are database reads of their own - three config
             * reads for the quiet hours, one row for the member - and a
             * rejection from either walked out past the counting, the report
             * and the outage check alike, dropping every remaining member as
             * silently as the throw this block was written to contain.
             *
             * Reported through errorHandler rather than console.error, for the
             * reason timer.js reports through it: data/logs/error.log is the file
             * the log's own header points bug reports at, and the only place
             * sequelize's side properties - the column, the rule, the driver's
             * code - are written down at all. A round that ends because the
             * database went away must not end quietly.
             */
            try {
                // A pause is "stop testing", whoever started the round: the
                // route and runTask both refuse one ahead of time, but both
                // stop looking the moment the round starts, and a pause is
                // pressed mid-round precisely because tests are running.
                if (pauseController.currentState) {
                    console.warn("Speedtests were paused during the round - stopping before the next target.");
                    break;
                }

                // The quiet hours bind only the scheduled rounds - a test
                // started by hand is somebody asking for one now, the rule
                // runTask and memberHeld already follow. Asked again per member
                // for the reason runTask asks again after the offset's sleep:
                // the window can begin while the round is busy with an earlier
                // member.
                if (type === "auto" && await withinQuietHours()) {
                    console.warn("The quiet hours began during the round - stopping before the next target.");
                    break;
                }

                // Not as the round-start snapshot had it - see
                // staleMemberReason for what a stale one did. The demo target
                // is no row and is left alone.
                fresh = target.id == null ? target : await targetsController.getOne(target.id);
                const stale = target.id == null ? null : staleMemberReason(fresh, targetId !== undefined);

                if (stale) {
                    console.warn(`${memberName(target)} ${stale}`);
                    continue;
                }

                beginTarget(fresh, index + 1, members.length);

                // Only the scheduled rounds honour a hold - a test started by
                // hand is somebody asking for one now. The skip is per target,
                // so the rest of the round still runs.
                //
                // Asked here, as the round reaches each member, rather than
                // resolved once before the round starts: the hold can arrive
                // during the round. Ookla refuses member one, executeTarget's
                // catch records it, and members two and three - the second and
                // third Ookla target of an instance that pins one per server -
                // are skipped rather than asking a limiter that has just said
                // no three times over, for three failed rows and three
                // notifications. The guard above the announcement answers only
                // what this cannot.
                //
                // Through memberHeld so the two cannot drift into disagreeing
                // about which rounds honour a hold, and through heldByBackoff
                // so a skip says in the log which target it was and for how
                // long.
                if (memberHeld(fresh, type, heldByBackoff)) continue;

                const outcome = await executeTarget(fresh, type);
                if (fresh.alerts && outcome.failed) roundFailures++;
                // A member that recorded - a result or a failure, either one - is
                // proof the database is still there, so the count of members that
                // could not starts again from here.
                escapes = 0;
            } catch (error) {
                // As far as this member got: a guard that could not read the
                // table has no fresh row to name, and the snapshot is what it
                // was working from.
                const member = fresh ?? target;

                // A member that could not even record its failure has still
                // failed - the round's completion must not read as clean
                // because the database refused the row saying otherwise.
                if (member.alerts) roundFailures++;
                escapes++;

                const {abandoned, context} = memberFailure(error, member,
                    {escapes, remaining: members.length - index - 1});

                errorHandler(error, {fatal: false, context});

                if (abandoned) break;
            }
        }
    } finally {
        // The round is over on every path, including one the guard above could
        // not contain - a throw from beginTarget, or from the reporting itself.
        // The same guarantee the latch has, for the same reason:
        // tasks/integrations.js reads this state for its keep-alive.
        setRunning(false, false);

        // The one completion for the one announcement, on every path out -
        // healthchecks.io opened a timing window on the /start above, and a
        // round interrupted by a pause or a shutdown still has to close it.
        // Per member the sinks already heard everything; this is the round's
        // own verdict, and neither it nor the read behind it is awaited, for
        // the reason no notification here is: a notifier must not hold the
        // round open. A database that cannot answer the verdict leaves the
        // /start unanswered, which is what the keep-alive - equally unable to
        // read it - is saying at the same moment.
        if (announce) roundOutcome(roundFailures, members.length)
            .then(sendRoundFinished)
            .catch(err => console.error(`Could not notify the integrations: ${toErrorMessage(err)}`));
    }
};

/**
 * Whether this member is the one the instance-wide surfaces speak for: the
 * first of the scheduled round, with the same fallback order the
 * recommendations use for an instance where nothing is scheduled.
 *
 * Carried on the notification payload rather than resolved by the sinks,
 * because the payload is the one thing a broker-side module can read without
 * a database of its own - and the MQTT module routes secondary members to
 * subtopics on exactly this answer. The demo target is no row and is the only
 * member its round has, so it is the primary by construction.
 */
const isPrimaryMember = async (target) => {
    if (target.id == null) return true;

    const primary = await targetsController.primaryTarget() ?? (await targetsController.listAll())[0];

    return primary === undefined || primary.id === target.id;
};

const executeTarget = async (target, type, retried = false) => {
    const mode = target.provider === "preview" ? "preview" : target.provider;

    try {
        let test;
        if (mode === "preview") {
            await simulatePreviewRun();
            test = {
                ping: {latency: Math.floor(Math.random() * 25) + 5, jitter: Math.random() * 5 + 0.5},
                download: {bandwidth: 125 * 100000 * (Math.random() + 0.5), elapsed: 10000},
                upload: {bandwidth: 125 * 100000 * (Math.random() + 0.5), elapsed: 10000},
            }
        } else {
            test = await run(target, retried);
        }

        // The parser names the provider itself, so the row cannot end up
        // attributed to one that did not produce it - including under preview
        // mode, where the generated result is ookla-shaped whatever is configured.
        let {ping, jitter, download, upload, time, resultId, serverName, serverHost, serverLocation,
            packetLoss, downloadLatency, uploadLatency, isp, externalIp, provider,
            bytesDownloaded, bytesUploaded} = await parseData.parseData(mode === "preview" ?
            parseData.OOKLA : mode, test);

        /*
         * A parse that produced no measurement is a failed run, whatever the
         * CLI's exit code said.
         *
         * parseCloudflare is total by design - it keeps the edge and the
         * external IP when the measurement block never arrived - so it answers
         * the failure placeholders rather than throwing, and this path had no
         * idea. The row went in with `error` left NULL, createRecommendations
         * was handed it, healthchecks.io was pinged on the success endpoint and
         * every webhook was told the test completed at -1 Mbps, while every
         * reader of the stored row called it a failure. Thrown here, it takes
         * the one path that writes the error text, sends sendError, and retries
         * once - which a run that reached an edge and measured nothing deserves.
         */
        if (isFailedTest({ping, download, upload}))
            throw new Error(`${mode} finished without reporting any measurement`);

        /*
         * And a run that reported something impossible leaves by the same door -
         * upstream #875, and on the evidence of its screenshot #792.
         *
         * The check above asks whether all three came back as the placeholder,
         * so one negative upload beside two good figures was a failure by no
         * reading and went in as an ordinary result. From there every reader
         * believed it: the average, the grade, the export, and the alert gate,
         * which reads a measurement far below the threshold as an outage.
         *
         * Thrown rather than clamped, because zero is not what was measured
         * either - nobody knows what the line did. It takes the same path an
         * unmeasurable run takes: the reason is written down, the integrations
         * are told the test failed, and it is retried once, which a run that
         * came back with a negative reading deserves as much as one that came
         * back with nothing.
         */
        const impossible = impossibleMeasurement({ping, download, upload});

        if (impossible)
            throw new Error(`${mode} reported an impossible ${impossible}: ${{ping, download, upload}[impossible]}`);

        const serverId = test.serverId;

        // The provider is answering again, so whatever hold a previous refusal
        // earned is over - including the escalation, which a completed test is
        // the only thing that disproves.
        if (mode !== "preview") clearBackoff(mode);

        /*
         * The nullable figures ask a different question and get a different
         * answer: null already means "nobody measured this", so a negative one
         * has an honest home to go to. Failing the whole run over a jitter of
         * -0.2 would throw away a throughput measurement that is perfectly good,
         * which is the opposite of what the guard above is for.
         */
        let testResult = await tests.create({ping, download, upload, time, serverId, type,
            targetId: target.id,
            resultId, jitter: usableFigure(jitter), serverName, serverHost, serverLocation,
            packetLoss: usableFigure(packetLoss),
            downloadLatency: usableFigure(downloadLatency), uploadLatency: usableFigure(uploadLatency),
            isp, externalIp, provider, bytesDownloaded, bytesUploaded});
        console.log(`Test #${testResult.id}${target.name ? ` (${target.name})` : ""} was executed successfully in ${time}s. 🏓 ${ping} (±${jitter ?? 'N/A'}) ⬇ ${download}️ ⬆ ${upload}️`);
        createRecommendations().catch(err =>
            console.error(`Could not update the recommendations: ${toErrorMessage(err)}`));
        // Everything the row records, not the five figures this used to send:
        // a webhook is how MySpeed feeds anything else, and a consumer that
        // cannot tell which provider or server produced a number can do little
        // with it. A target that opted out of alerting sends nothing - it is
        // the diagnostic box, not the line being watched.
        if (target.alerts) sendFinished(finishedPayload({...testResult, provider, ping, jitter, download, upload, time,
            packetLoss, downloadLatency, uploadLatency, serverId, serverName, serverHost, serverLocation,
            isp, externalIp, resultId, bytesDownloaded, bytesUploaded,
            targetId: target.id, targetName: target.name,
            // Degraded rather than thrown: this reads the targets table after
            // the row above is already committed, and a rejection here would
            // land in the catch below - whose first act is to measure the whole
            // member again and write a second row for one scheduled test. The
            // payload's own contract says an absent flag reads as the primary.
            primary: await isPrimaryMember(target).catch(() => true)})).catch(err =>
            console.error(`Could not notify the integrations: ${toErrorMessage(err)}`));

        // How the member went, for the round's one completion event. The
        // retry above answers with its own attempt's outcome, so a member
        // that failed once and then measured reports the measurement.
        return {failed: false};
    } catch (e) {
        console.log(e)

        // A thrown string or a plain object has no `message`, and storing
        // undefined writes NULL - which marks the row as *successful* and lets
        // its -1 placeholder values poison every average.
        //
        // Read before the retry rather than after it, which is where it used to
        // sit: the retry now has to know what the failure was.
        const message = toErrorMessage(e);

        /*
         * A provider that answered "too many requests" is the one failure a
         * second attempt cannot help with, because the second attempt is the
         * problem - upstream #846 and #1092. Recorded before the retry decision
         * so the hold stands whichever way that goes, and against `mode` because
         * the limiter belongs to the provider that refused rather than to this
         * instance.
         */
        const rateLimited = isRateLimitMessage(message);

        if (rateLimited) recordRateLimit(mode);

        // Not while the process is leaving: the shutdown has just killed the
        // child this failure reports, and a retry would spawn a fresh one after
        // the only moment terminateActiveProcess could reach it - the orphan
        // trackProcess exists to prevent, rebuilt one line further down. The
        // retry is this target's alone: the round carries on to the next
        // member whatever happens here.
        if (!retried && !isShuttingDown() && !rateLimited) return await executeTarget(target, type, true);

        // The provider is recorded on a failure too: nothing was parsed, but
        // which provider could not complete is the first thing a reader of the
        // error wants, and the target may have changed by the time they look.
        let testResult = await tests.create({ping: FAILED, download: FAILED, upload: FAILED, time: null,
            serverId: 0, type, error: message, provider: mode, targetId: target.id});
        // Not awaited, the way the success path above does it. triggerEvent
        // works through the integrations one at a time and each outbound
        // call has a ten second timeout, so a few endpoints that have gone
        // unreachable - the very situation this notification describes -
        // held the run open for the sum of their timeouts.
        // Degraded the way the success path degrades it, and here the escape
        // it prevents is worse: a rejection between the failure row and this
        // notification leaves executeTarget entirely, so the round reports
        // "could not record its result" about a row it did record.
        if (target.alerts) sendError(failedPayload({...testResult, provider: mode, error: message,
            targetId: target.id, targetName: target.name,
            primary: await isPrimaryMember(target).catch(() => true)})).catch(err =>
            console.error(`Could not notify the integrations: ${toErrorMessage(err)}`));
        console.log(`Test #${testResult.id} was not executed successfully. Please try reconnecting to the internet or restarting the software: ` + message);

        return {failed: true};
    }
}

export const isRunning = () => _isRunning;

export const removeOld = async () => {
    await tests.removeOld();
};