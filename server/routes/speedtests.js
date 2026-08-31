import express from 'express';
import * as tests from '../controller/speedtests.js';
import * as pauseController from '../controller/pause.js';
import * as config from '../controller/config.js';
import * as testTask from '../tasks/speedtest.js';
import * as targets from '../controller/targets.js';
import { isPreviewInstance } from '../util/previewMode.js';
import password from '../middlewares/password.js';
import previewReadOnly from '../middlewares/previewReadOnly.js';
import { ALL_TIME_RANGE, parseDateRange } from '../util/dateRange.js';
import { resolveTimezone } from '../util/timezone.js';
import { stripConnectionIdentity } from '../util/connectionIdentity.js';
import { isUntrustedReader } from '../util/untrustedReader.js';
import { toCsv } from '../util/csv.js';
import { isFailedTest } from '../util/testOutcome.js';
import * as timer from '../tasks/timer.js';

const app = express.Router();

// How far back the status counts failures. A day is long enough that a run of
// failures is visible on the overview without opening the statistics, and short
// enough that last week's outage is not still being reported as news.
const RECENT_FAILURE_WINDOW_HOURS = 24;
const RECENT_FAILURE_WINDOW_MS = RECENT_FAILURE_WINDOW_HOURS * 60 * 60 * 1000;

// The exact shape every write stores `created` in, and so the only shape the
// scroll cursor can be compared against - the same pattern importTests holds
// its input to.
const CREATED_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/**
 * The ?target= filter, three-valued: undefined when absent (no filter), a
 * number when usable, null when malformed - the caller answers the 400, so
 * the message lives beside the route the way the other parameter guards do.
 *
 * Digits are not quite enough on their own to make a number the database can
 * be asked about, which is what the safe-integer half is for. `Number` of four
 * hundred nines is Infinity, and Infinity reached the driver as a bind
 * parameter no dialect can compare an INTEGER column against: the whole
 * request came back a 500 that named no parameter at all, on a URL anybody
 * could type, where every other malformed filter on these three routes earns
 * a 400 that says which one was wrong.
 */
const parseTargetParam = (value) => {
    if (value === undefined) return undefined;

    const id = Number(value);
    return /^\d+$/.test(value) && Number.isSafeInteger(id) ? id : null;
};

/**
 * What separates the ids of a batched request.
 *
 * A comma cannot appear inside an id, so the list needs no escaping - and it
 * keeps the whole list in one parameter. Repeating `targets=` instead would
 * arrive as a string for one id and an array for two, a shape every reader
 * would then have to normalise before it could count anything.
 */
const TARGETS_SEPARATOR = ",";

/**
 * How many targets one batched request may ask about.
 *
 * Not a limit on database work: the ids are answered from one scan of the range
 * however many of them there are, so an extra id costs a partition of rows that
 * are already in memory. It is a limit on the payload, which is a full
 * statistics answer per target and by far the largest thing this API returns -
 * without a ceiling, a pasted URL naming ten thousand ids would have the server
 * build and serialise ten thousand of them.
 *
 * Fifty is far above anything an instance runs. The comparison panel this
 * parameter exists for draws a column per target, and a dozen already overflows
 * the widest screen, so no honest caller comes near it and no caller that does
 * is drawing a panel.
 */
export const MAX_BATCH_TARGETS = 50;

/**
 * The ?targets= filter: the ids a batched request wants a payload each for.
 *
 * Three-valued the way parseCompare is - undefined when the parameter is
 * absent, and otherwise a verdict carrying either the ids or the reason they
 * were refused, because the caller is what answers the 400 and the messages
 * belong beside the route like every other parameter guard here.
 *
 * Each id is read by parseTargetParam above, so a list is not a place where
 * "12abc" or "-2" starts meaning something it does not mean on its own.
 */
export const parseTargetsParam = (value) => {
    if (value === undefined) return undefined;

    /*
     * `?targets=1&targets=2` is the other way a caller might write a list, and
     * Express hands a repeated parameter over as an array - a string for one id
     * and an array for two, which is the very shape the comma-separated list
     * exists to avoid. Named rather than tolerated, because guessing at what
     * was meant would make one spelling of the parameter work by accident and
     * the other by design; unguarded it is not even a wrong answer but a 500,
     * since nothing but a string has `split`.
     */
    if (typeof value !== "string") return {valid: false,
        message: "The targets parameter is one comma-separated list of ids, not a repeated parameter"};

    // A list nobody filled in is a caller that built its URL wrongly, not a
    // request for every target and not a request for none. Answered as an empty
    // batch it would be read as "this instance has no targets", which is a
    // different and quite plausible-looking fact.
    if (value === "") return {valid: false,
        message: "The targets parameter needs at least one target id"};

    const ids = value.split(TARGETS_SEPARATOR).map((id) => parseTargetParam(id));

    /*
     * One check rather than two, because an id is an id: parseTargetParam
     * refuses everything a list refuses, down to the shapes that are all
     * digits and still not a number the database can be asked about.
     *
     * The safe-integer half of that rule used to be written out a second time
     * here, while the single filter still answered 500 for four hundred nines
     * and this was the worse place to leave it - one unusable id in a list of
     * fifty took the figures of the other forty-nine down with it. The single
     * filter has caught up, so the rule lives once, above, where every target
     * id in this file is read.
     */
    if (ids.some((id) => id === null))
        return {valid: false, message: "You need to provide correct numbers in the targets parameter"};

    /*
     * Collapsed rather than refused. A repeated id is a caller building its
     * list from a page that names a target twice, not a request that cannot be
     * answered - and the answer for one id is the same answer however many
     * times it was asked for.
     *
     * The cap is counted after the collapse, because the work and the bytes are
     * both per distinct target; the raw list is bounded by the URL itself,
     * which Node refuses long before a repetition of one id could cost
     * anything to split.
     */
    const distinct = [...new Set(ids)];

    if (distinct.length > MAX_BATCH_TARGETS)
        return {valid: false, message:
            `The targets parameter accepts at most ${MAX_BATCH_TARGETS} target ids`};

    return {valid: true, ids: distinct};
};

/**
 * How far back a comparison looks, as whole calendar months - or 0 for the
 * period immediately before the range, which is its own length back.
 *
 * An offset rather than a window the caller draws, and that is the whole of
 * the shape: two windows of the same length are comparable, and a free pair of
 * dates let "August so far" be compared against all of 2025 - a question
 * nobody asked, which the elapsed cut then answered by quietly comparing
 * against the first fortnight of January.
 *
 * The names are what the URL carries, so a comparison is a link somebody can
 * keep: `compare=1y` says what it means a year from now, where a pair of dates
 * says only what it said the day it was copied.
 */
export const COMPARE_OFFSETS = {previous: 0, "1m": 1, "3m": 3, "6m": 6, "1y": 12, "2y": 24};

/**
 * Three-valued like the target filter above: undefined when nothing was asked
 * for, a verdict carrying the offset when one was named, and a verdict
 * carrying its own message when the name is not one of them - the caller
 * answers the 400, so the message lives beside the route the way the other
 * guards do.
 */
const parseCompare = (value) => {
    if (value === undefined) return undefined;

    // Named rather than ignored. An unreadable value used to mean "no
    // comparison", so a bookmark carrying a typo drew a page with every delta
    // silently missing and nothing saying why.
    if (!Object.hasOwn(COMPARE_OFFSETS, value))
        return {valid: false, message: "The compare parameter must be one of "
            + Object.keys(COMPARE_OFFSETS).join(", ")};

    return {valid: true, months: COMPARE_OFFSETS[value]};
};


app.get("/", password(true), async (req, res) => {
    if (req.query.limit && /[^0-9]/.test(req.query.limit))
        return res.status(400).json({message: "You need to provide a correct number in the limit parameter"});

    if (req.query.afterId && /[^0-9]/.test(req.query.afterId))
        return res.status(400).json({message: "You need to provide a correct number in the afterId parameter"});

    // The overview's date picker bounds this list. Optional, and only parsed
    // when asked for: every other caller - the header, the storage dialog, an
    // older node being proxied - sends no range and still gets the full
    // history its infinite scroll expects.
    const {from, to} = req.query;
    let range = null;

    const timezone = resolveTimezone(req.query);
    if (!timezone.valid) return res.status(400).json({message: timezone.message});

    if (from !== undefined || to !== undefined) {
        const parsed = parseDateRange(from, to, {zone: timezone.zone});
        if (!parsed.valid) return res.status(400).json({message: parsed.message});

        range = parsed;
    }

    // The scroll cursor is the last row's `created` plus its id, because that
    // is what the list is ordered by. `afterId` alone still works for a caller
    // that has not been updated - see listFilter.
    if (req.query.after !== undefined && !CREATED_PATTERN.test(req.query.after))
        return res.status(400).json({message: "You need to provide an ISO-8601 timestamp in the after parameter"});

    // Half a pair is not a smaller cursor, it is no cursor at all: `after`
    // alone used to fall through to page one silently, so a caller paginating
    // with it re-fetched the same rows forever with nothing said - while every
    // other malformed parameter here earns a 400 that names itself.
    if (req.query.after !== undefined && !req.query.afterId)
        return res.status(400).json({message: "The after parameter needs its afterId half - the cursor is the pair"});

    const after = req.query.after && req.query.afterId
        ? {created: req.query.after, id: req.query.afterId}
        : null;

    const target = parseTargetParam(req.query.target);
    if (target !== undefined && target === null)
        return res.status(400).json({message: "You need to provide a correct number in the target parameter"});

    const entries = await tests.listTests(req.query.afterId, req.query.limit, range, after, target);

    // A viewer sees the measurements, not who the connection is: the operator's
    // provider and address are the operator's to see. A demo visitor is the
    // same kind of caller and was not treated as one - see isUntrustedReader.
    if (isUntrustedReader(req)) entries.forEach(stripConnectionIdentity);

    res.json(entries);
});

app.get("/statistics", password(true), async (req, res) => {
    const { from, to, points } = req.query;

    // Resolved before the all-time branch, not inside the range parser. The
    // bound on the offset used to live in parseDateRange, which range=all
    // skips - so the same parameter earned a 400 on one path, was silently
    // accepted on another, and crashed the request with a 500 when it was
    // large enough to push the Date out of range.
    const timezone = resolveTimezone(req.query);
    if (!timezone.valid) return res.status(400).json({message: timezone.message});

    // Checked ahead of the dates, which the client sends beside it: a parent
    // proxies this request to its nodes, and a node running a version that
    // predates the named range understands only from/to. The window it sends is
    // wide enough to contain everything, so that node still answers correctly -
    // but here the name has to win, or the stand-in would decide what
    // "everything" means and the charts would bucket over a quarter of a century.
    const allTime = req.query.range === ALL_TIME_RANGE;
    const range = allTime ? null : parseDateRange(from, to, { zone: timezone.zone });

    if (range && !range.valid) {
        return res.status(400).json({ message: range.message });
    }

    // Same digits-only guard as `limit` above. Out-of-range values are clamped
    // rather than refused - asking for more detail than exists is a reasonable
    // request, and the answer is simply every point there is.
    if (points !== undefined && /[^0-9]/.test(points))
        return res.status(400).json({message: "You need to provide a correct number in the points parameter"});

    /*
     * Two different questions rather than one narrower one: `target` narrows
     * the single answer to a line, `targets` asks for a batch of those single
     * answers. Letting either win silently would answer the question the caller
     * did not ask, in the shape of the one they did - a panel handed one
     * payload where it expects a map of them, or a page handed a map where it
     * expects a payload.
     */
    if (req.query.target !== undefined && req.query.targets !== undefined)
        return res.status(400).json({message: "The target and targets parameters cannot be combined - "
            + "target narrows the answer to one line, targets asks for one answer per line"});

    const target = parseTargetParam(req.query.target);
    if (target !== undefined && target === null)
        return res.status(400).json({message: "You need to provide a correct number in the target parameter"});

    const targets = parseTargetsParam(req.query.targets);
    if (targets !== undefined && !targets.valid)
        return res.status(400).json({message: targets.message});

    // Not parsed at all for all time, which drops the window anyway: refusing
    // a malformed pair the request was never going to use answers 400 for a
    // parameter that has no meaning here - the same "the name wins" rule the
    // all-time branch keeps everywhere else.
    // Nothing precedes all time, so a comparison is never taken against it -
    // and the parameter is not refused there either, because the client sends
    // the reader's standing choice with every request and the range they
    // happen to be on is not a mistake to name.
    const compare = allTime ? undefined : parseCompare(req.query.compare);
    if (compare && !compare.valid)
        return res.status(400).json({message: compare.message});

    // Everything except the target filter, which is the one thing the two
    // answers below disagree about. Named once so that a batched entry cannot
    // end up built under different options from the single answer it promises
    // to be - a divergence a reader would only ever see as two figures that
    // disagree, with nothing saying which parameter went missing on which path.
    const options = {
        zone: timezone.zone,
        maxPoints: points,
        // Whether to summarise a second window at all, for the
        // period-over-period deltas. Opt-in: it costs a second table scan.
        compare: compare !== undefined,
        // And how far back it sits. Zero is the period immediately before,
        // which is the range's own length rather than a fixed number of
        // months - previousSummary reads it that way.
        compareMonths: compare?.months
    };

    /*
     * One payload per target, under `byTarget`, rather than the payload itself.
     * A wrapper rather than the bare map so that the two answers cannot be
     * mistaken for one another by a reader that only ever sees the JSON: a map
     * keyed by ids has no field in common with a statistics payload, but it has
     * no field that says what it is either.
     */
    if (targets !== undefined)
        return res.json({byTarget: await tests.listStatisticsByTarget(range, targets.ids, options)});

    res.json(await tests.listStatistics(range, {...options, target}));
});

app.get("/export", password(true), async (req, res) => {
    const { from, to, format } = req.query;

    const timezone = resolveTimezone(req.query);
    if (!timezone.valid) return res.status(400).json({message: timezone.message});

    const range = parseDateRange(from, to, { zone: timezone.zone });
    if (!range.valid) {
        return res.status(400).json({ message: range.message });
    }

    const target = parseTargetParam(req.query.target);
    if (target !== undefined && target === null)
        return res.status(400).json({message: "You need to provide a correct number in the target parameter"});

    const exportData = await tests.exportTests(range, target);

    if (isUntrustedReader(req)) exportData.forEach(stripConnectionIdentity);

    if (format === 'csv') {
        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', `attachment; filename="myspeed-export-${from}-to-${to}.csv"`);
        res.send(toCsv(exportData));
    } else {
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Content-Disposition', `attachment; filename="myspeed-export-${from}-to-${to}.json"`);
        res.json(exportData);
    }
});

app.post("/run", password(false), async (req, res) => {
    if (pauseController.currentState) return res.status(410).json({message: "The speedtests are currently paused"});
    if (!isPreviewInstance() && await targets.count() === 0)
        return res.status(410).json({message: "No targets configured"});
    if (testTask.isRunning()) return res.status(409).json({message: "An speedtest is already running"});

    // A named target runs alone - the per-row run button in the targets
    // dialog, and the one way a disabled (manual-only) target ever runs.
    // Without one, the whole round of enabled targets runs.
    const targetId = req.body?.targetId;

    /*
     * Asked of the set the round will actually run, which is not what the count
     * above answers for. An unnamed run resolves its members through
     * roundTargets(), which are the scheduled ones - so an instance whose
     * targets all have Scheduled switched off (two manual-only diagnostic
     * boxes, or the one WAN target unchecked for the duration of an outage) has
     * targets to count and nothing to run. It was answered 200 "Speedtest
     * successfully created": the toolbar toasted success and drew the gauge,
     * executeRound then gave up with a 400 that reaches nobody because this
     * route deliberately does not await it, and there was no row, no failure
     * and nothing in the log. The per-row run button kept working throughout,
     * which made the start button look broken at random.
     *
     * A second refusal beside the count rather than a replacement for it,
     * because the two are different situations and this message is all the
     * operator gets: one instance has nothing set up yet, the other is set up
     * and has switched itself off. Both are reachable - with no targets at all
     * only the count can fire, and this one is asked precisely when targets
     * exist.
     *
     * Only for an unnamed run. A named one is judged by getOne below, and
     * running a target that sits outside the schedule is exactly what that path
     * exists for.
     *
     * The wording is an instruction rather than a code because that is how it
     * reaches the operator: client/src/common/utils/RunUtil.js puts the body's
     * message verbatim into the alert dialog. It says what to do about it,
     * without quoting the label on the switch - the message has no key of its
     * own, the same as every other message on this route, so it is English in
     * front of a dialog that is not.
     */
    if (!isPreviewInstance() && targetId === undefined && (await targets.roundTargets()).length === 0)
        return res.status(410).json({message: "No target is scheduled - every target is set to run by "
            + "hand only. Run one from the targets dialog, or put a target back into the schedule"});

    if (targetId !== undefined) {
        if (!/^\d+$/.test(String(targetId)))
            return res.status(400).json({message: "You need to provide a numeric targetId"});
        if (await targets.getOne(Number(targetId)) === null)
            return res.status(404).json({message: "The target does not exist"});
    }

    /*
     * The round latch, taken here rather than trusted to create(): this route
     * answers before the round ends and create() *returns* its refusals rather
     * than throwing, so a second click landing between the awaits above used to
     * be told 200 "successfully created" while its round was refused into the
     * void - a success toast for a test that never existed. The isRunning check
     * at the top still refuses the common case cheaply; this is the answer for
     * the race it cannot see. Whichever request loses is told the same 409 a
     * click during a visible run has always got.
     */
    if (!testTask.tryReserve())
        return res.status(409).json({message: "An speedtest is already running"});

    // Deliberately not awaited: a speedtest runs for 30-60s and holding the
    // connection open that long trips the default read timeout of every common
    // reverse proxy. The client follows progress via GET /speedtests/status.
    // The reservation above is the latch create() would otherwise take, and its
    // finally gives it back on every ending.
    testTask.create("custom", targetId === undefined ? undefined : Number(targetId), {reserved: true})
        .catch(error =>
            console.error(`The manually started speedtest failed: ${error?.message ?? error}`));

    res.json({message: "Speedtest successfully created"});
});

/**
 * What the instance is doing right now, and what it last did.
 *
 * `paused` and `running` come first and keep their names: the client has always
 * read them, a node running an older version answers with only those two, and
 * the image smoke test greps this body for "running". Everything else is
 * additive and may be absent.
 */
app.get("/status", password(true), async (req, res) => {
    /*
     * Whose rows the body speaks for: the alerting targets', through the same
     * scope the keep-alive already reads, and for the same reason. A diagnostic
     * iperf3 box with alerts off fails because the machine is asleep, and its
     * row was presented as the line's last test and counted among the line's
     * recent failures - the status bar and the health summary blaming the
     * internet for a target the operator had explicitly opted out of watching.
     * Null scope means no targets exist at all - the pre-target install and the
     * demo, whose rows carry no targetId - and there the instance-wide answer
     * is the only one there is.
     */
    const scope = targets.alertingScope(await targets.listAll());
    const latest = scope === null ? await tests.getLatest() : await tests.latestOfTargets(scope);
    const progress = testTask.getProgress();

    /**
     * Not worked out at all for a read-only visitor, rather than worked out and
     * then dropped.
     *
     * /api/config withholds `cron`, `scheduleOffset` and both quiet-hours edges
     * from exactly this caller, on the grounds that a schedule says when the
     * operator's line is busy and when their evening begins. This is the
     * conclusion drawn from all four, and it gives them up about as readily:
     * one poll recovers the cron's minute field, and polling across an evening
     * walks out both edges of the quiet window, since the countdown steps over
     * it.
     *
     * Null is the answer this route already gives when nothing is scheduled, so
     * the status bar's existing branch for that covers the visitor too.
     */
    // The run that has already fired and is sleeping its schedule offset,
    // asked ahead of the cron: during that sleep the cron's next occurrence is
    // the slot AFTER the pending one, so the bar rolled from "~19:00" to
    // "~19:30" while the 19:00 test was still on its way - which read as it
    // having been skipped. The wake moment is exact, so the approximation
    // flag below drops with it.
    const pendingRun = timer.pendingRunAt();

    const nextTest = isUntrustedReader(req) ? null : pendingRun ?? timer.nextRun(
        await config.getValue("cron"),
        {
            // The quiet window too, or the countdown names a test the scheduler
            // will refuse and then resets to the next one it will also refuse.
            start: await config.getValue("quietHoursStart"),
            end: await config.getValue("quietHoursEnd")
        },
        // And on the clock the schedule itself runs on, or the countdown names
        // a different moment from the one that will happen.
        await config.getValue("timezone")
    );

    // getLatest strips a null error rather than reporting it, and answers
    // with undefined on an install that has never run a test - so absence is
    // normalised here and a failure is told apart by the key being present.
    const lastTest = latest ? {...latest, failed: isFailedTest(latest)} : null;

    if (isUntrustedReader(req)) stripConnectionIdentity(lastTest);

    res.json({
        paused: pauseController.currentState,
        running: testTask.isRunning(),
        ...progress,
        lastTest,
        // The same scope as the last test: the count sits beside it in the
        // body, and the two disagreeing about whose failures matter is the
        // exact confusion the scoping exists to end.
        recentFailures: await tests.countFailuresSince(
            new Date(Date.now() - RECENT_FAILURE_WINDOW_MS), scope ?? undefined),
        // From the stored schedule rather than the running job, so it is right
        // even before the timer has been started for the first time.
        nextTest,
        // The offset delays each run by up to a few minutes so that every
        // instance does not test on the same tick, which makes the cron time the
        // earliest it could start rather than when it will. A pending run's wake
        // moment is not an estimate, so it is announced without the tilde.
        nextTestApproximate: nextTest !== null && pendingRun === null
            && await config.getValue("scheduleOffset") === "true"
    });
});

/**
 * The hot half of /status: the four fields a run actually moves, from memory.
 *
 * The client samples a run twice a second to drive the progress bar, and the
 * full route above does two database queries, three config reads and a cron
 * computation per call - none of which can change mid-run. This answers from
 * what tasks/speedtest.js already keeps, so the sampling rate costs the server
 * nothing but the request itself; the client falls back to polling the full
 * route at RUNNING_POLL_MS against a server - an older node - without this.
 *
 * Behind the same read gate as /status, and deliberately nothing async: the
 * moment this route has something to await is the moment it has stopped being
 * the cheap one, and tests/server/statusLiveRoute.test.js holds it to that.
 */
app.get("/status/live", password(true), (req, res) => {
    res.json({running: testTask.isRunning(), ...testTask.getProgress()});
});

// Guarded, unlike /run above: the schedule belongs to the instance rather than
// to the visitor looking at it, so one anonymous caller pausing a public demo
// stops the tests for everyone else - and leaves them stopped, since nobody
// resumes it on their behalf.
app.post("/pause", password(false), previewReadOnly, (req, res) => {
    // Both 0 and -1 mean "until manually resumed": the pause dialog sends 0,
    // older clients send -1. The reading lives in the controller so that it can
    // be tested, and so that "0" is read the same as 0 - this was an
    // Array.includes over [0, -1], which compares strictly and sent the string
    // spelling down the duration path to be rejected as no duration at all.
    const intent = pauseController.pauseIntent(req.body?.resumeIn);

    if (intent === null)
        return res.status(400).json({message: "You need to provide when to resume"});

    if (intent === pauseController.PAUSE_INDEFINITE) pauseController.updateState(true);
    else pauseController.resumeIn(intent);

    res.json({message: "Successfully paused the speedtests"});
});

app.post("/continue", password(false), previewReadOnly, (req, res) => {
    pauseController.updateState(false);
    res.json({message: "Successfully resumed the speedtests"});
});

app.get("/:id", password(true), async (req, res) => {
    let test = await tests.getOne(req.params.id);
    if (test === null) return res.status(404).json({message: "Speedtest not found"});

    if (isUntrustedReader(req)) stripConnectionIdentity(test);

    res.json(test);
});

// Running a test on a demo is deliberate - preview mode has a branch in
// tasks/speedtest.js that answers with a plausible result - but deleting the
// history a visitor arrived to look at is not.
app.delete("/:id", password(false), previewReadOnly, async (req, res) => {
    let test = await tests.deleteOne(req.params.id);
    if (!test) return res.status(404).json({message: "Speedtest not found"});
    res.json({message: "Successfully deleted the provided speedtest"});
});

export default app;