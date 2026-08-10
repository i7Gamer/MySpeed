import express from 'express';
import * as tests from '../controller/speedtests.js';
import * as pauseController from '../controller/pause.js';
import * as config from '../controller/config.js';
import * as testTask from '../tasks/speedtest.js';
import password from '../middlewares/password.js';
import { ALL_TIME_RANGE, parseDateRange } from '../util/dateRange.js';
import { stripConnectionIdentity } from '../util/connectionIdentity.js';
import { toCsv } from '../util/csv.js';
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


app.get("/", password(true), async (req, res) => {
    if (req.query.limit && /[^0-9]/.test(req.query.limit))
        return res.status(400).json({message: "You need to provide a correct number in the limit parameter"});

    if (req.query.afterId && /[^0-9]/.test(req.query.afterId))
        return res.status(400).json({message: "You need to provide a correct number in the afterId parameter"});

    // The overview's date picker bounds this list. Optional, and only parsed
    // when asked for: every other caller - the header, the storage dialog, an
    // older node being proxied - sends no range and still gets the full
    // history its infinite scroll expects.
    const {from, to, tzOffset} = req.query;
    let range = null;

    if (from !== undefined || to !== undefined) {
        const parsed = parseDateRange(from, to, {offsetMinutes: tzOffset});
        if (!parsed.valid) return res.status(400).json({message: parsed.message});

        range = parsed;
    }

    // The scroll cursor is the last row's `created` plus its id, because that
    // is what the list is ordered by. `afterId` alone still works for a caller
    // that has not been updated - see listFilter.
    if (req.query.after !== undefined && !CREATED_PATTERN.test(req.query.after))
        return res.status(400).json({message: "You need to provide an ISO-8601 timestamp in the after parameter"});

    const after = req.query.after && req.query.afterId
        ? {created: req.query.after, id: req.query.afterId}
        : null;

    const entries = await tests.listTests(req.query.afterId, req.query.limit, range, after);

    // A read-only viewer sees the measurements, not who the connection is:
    // the operator's provider and address are the operator's to see.
    if (req.viewMode) entries.forEach(stripConnectionIdentity);

    res.json(entries);
});

app.get("/statistics", password(true), async (req, res) => {
    const { from, to, tzOffset, points } = req.query;

    // Checked ahead of the dates, which the client sends beside it: a parent
    // proxies this request to its nodes, and a node running a version that
    // predates the named range understands only from/to. The window it sends is
    // wide enough to contain everything, so that node still answers correctly -
    // but here the name has to win, or the stand-in would decide what
    // "everything" means and the charts would bucket over a quarter of a century.
    const allTime = req.query.range === ALL_TIME_RANGE;
    const range = allTime ? null : parseDateRange(from, to, { offsetMinutes: tzOffset });

    if (range && !range.valid) {
        return res.status(400).json({ message: range.message });
    }

    // Same digits-only guard as `limit` above. Out-of-range values are clamped
    // rather than refused - asking for more detail than exists is a reasonable
    // request, and the answer is simply every point there is.
    if (points !== undefined && /[^0-9]/.test(points))
        return res.status(400).json({message: "You need to provide a correct number in the points parameter"});

    res.json(await tests.listStatistics(range, {
        offsetMinutes: tzOffset,
        maxPoints: points,
        // The summary of the window immediately before the range, for the
        // period-over-period deltas. Opt-in: it costs a second table scan.
        // Nothing precedes all time, so it is never compared.
        comparePrevious: !allTime && req.query.compare === "previous"
    }));
});

app.get("/export", password(true), async (req, res) => {
    const { from, to, format, tzOffset } = req.query;
    const range = parseDateRange(from, to, { offsetMinutes: tzOffset });
    if (!range.valid) {
        return res.status(400).json({ message: range.message });
    }

    const exportData = await tests.exportTests(range);

    if (req.viewMode) exportData.forEach(stripConnectionIdentity);

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
    if (await config.getValue("provider") === "none") return res.status(410).json({message: "No provider selected"});
    if (testTask.isRunning()) return res.status(409).json({message: "An speedtest is already running"});

    // Deliberately not awaited: a speedtest runs for 30-60s and holding the
    // connection open that long trips the default read timeout of every common
    // reverse proxy. The client follows progress via GET /speedtests/status.
    testTask.create("custom").catch(error =>
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
    const latest = await tests.getLatest();
    const progress = testTask.getProgress();
    const nextTest = timer.nextRun(await config.getValue("cron"));

    // getLatest strips a null error rather than reporting it, and answers
    // with undefined on an install that has never run a test - so absence is
    // normalised here and a failure is told apart by the key being present.
    const lastTest = latest ? {...latest, failed: latest.error !== null && latest.error !== undefined} : null;

    if (req.viewMode) stripConnectionIdentity(lastTest);

    res.json({
        paused: pauseController.currentState,
        running: testTask.isRunning(),
        ...progress,
        lastTest,
        recentFailures: await tests.countFailuresSince(new Date(Date.now() - RECENT_FAILURE_WINDOW_MS)),
        // From the stored schedule rather than the running job, so it is right
        // even before the timer has been started for the first time.
        nextTest,
        // The offset delays each run by up to a few minutes so that every
        // instance does not test on the same tick, which makes the cron time the
        // earliest it could start rather than when it will.
        nextTestApproximate: nextTest !== null && await config.getValue("scheduleOffset") === "true"
    });
});

// Both 0 and -1 mean "until manually resumed": the pause dialog sends 0, older
// clients send -1. Only an absent field is a bad request - guarding on
// falsiness rejected the dialog's own default and left the scheduler running.
const PAUSE_INDEFINITELY = [0, -1];

app.post("/pause", password(false), (req, res) => {
    const resumeIn = req.body?.resumeIn;
    const badRequest = () => res.status(400).json({message: "You need to provide when to resume"});

    if (resumeIn === undefined || resumeIn === null) return badRequest();

    if (PAUSE_INDEFINITELY.includes(resumeIn)) {
        pauseController.updateState(true);
    } else if (!pauseController.resumeIn(resumeIn)) {
        return badRequest();
    }

    res.json({message: "Successfully paused the speedtests"});
});

app.post("/continue", password(false), (req, res) => {
    pauseController.updateState(false);
    res.json({message: "Successfully resumed the speedtests"});
});

app.get("/:id", password(true), async (req, res) => {
    let test = await tests.getOne(req.params.id);
    if (test === null) return res.status(404).json({message: "Speedtest not found"});

    if (req.viewMode) stripConnectionIdentity(test);

    res.json(test);
});

app.delete("/:id", password(false), async (req, res) => {
    let test = await tests.deleteOne(req.params.id);
    if (!test) return res.status(404).json({message: "Speedtest not found"});
    res.json({message: "Successfully deleted the provided speedtest"});
});

export default app;