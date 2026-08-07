import express from 'express';
import * as tests from '../controller/speedtests.js';
import * as pauseController from '../controller/pause.js';
import * as config from '../controller/config.js';
import * as testTask from '../tasks/speedtest.js';
import password from '../middlewares/password.js';
import { parseDateRange } from '../util/dateRange.js';
import { toCsv } from '../util/csv.js';

const app = express.Router();


app.get("/", password(true), async (req, res) => {
    if (req.query.limit && /[^0-9]/.test(req.query.limit))
        return res.status(400).json({message: "You need to provide a correct number in the limit parameter"});

    if (req.query.afterId && /[^0-9]/.test(req.query.afterId))
        return res.status(400).json({message: "You need to provide a correct number in the afterId parameter"});

    res.json(await tests.listTests(req.query.afterId, req.query.limit));
});

app.get("/statistics", password(true), async (req, res) => {
    const { from, to, tzOffset } = req.query;
    const range = parseDateRange(from, to, { offsetMinutes: tzOffset });
    if (!range.valid) {
        return res.status(400).json({ message: range.message });
    }

    res.json(await tests.listStatistics(range, { offsetMinutes: tzOffset }));
});

app.get("/export", password(true), async (req, res) => {
    const { from, to, format, tzOffset } = req.query;
    const range = parseDateRange(from, to, { offsetMinutes: tzOffset });
    if (!range.valid) {
        return res.status(400).json({ message: range.message });
    }

    const exportData = await tests.exportTests(range);

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

app.get("/status", password(true), (req, res) => {
    res.json({paused: pauseController.currentState, running: testTask.isRunning()});
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
    res.json(test);
});

app.delete("/:id", password(false), async (req, res) => {
    let test = await tests.deleteOne(req.params.id);
    if (!test) return res.status(404).json({message: "Speedtest not found"});
    res.json({message: "Successfully deleted the provided speedtest"});
});

export default app;