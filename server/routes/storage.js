import express from 'express';
import * as tests from '../controller/speedtests.js';
import * as config from '../controller/config.js';
import password from '../middlewares/password.js';
import { toCsv } from '../util/csv.js';

const app = express.Router();

app.get("/", password(false), async (req, res) => {
    res.json(await config.getUsedStorage());
});

app.get("/tests/history/json", password(false), async (req, res) => {
    res.set({
        "Content-Type": "application/json; charset=utf-8",
        "Content-Disposition": "attachment; filename=\"speedtests.json\""
    });
    res.send(JSON.stringify(await tests.listAll(), null, 4));
});

// Uses the shared writer rather than a hand-rolled one. The old version took
// its column list from the first row, so a newest test that happened to
// succeed dropped the `error` column from the whole export, and it escaped
// with JSON rules - backslashes instead of RFC 4180's doubled quotes - which
// no spreadsheet reads back correctly.
app.get("/tests/history/csv", password(false), async (req, res) => {
    res.set({
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": "attachment; filename=\"speedtests.csv\""
    });

    res.send(toCsv(await tests.listAll()));
});

app.delete("/tests/history", password(false), async (req, res) => {
    let result = await tests.deleteTests();
    res.status(result ? 200 : 500).json({message: result ? "Tests deleted" : "Error deleting tests"});
});

app.put("/tests/history", password(false), async (req, res) => {
    if (process.env.PREVIEW_MODE === "true")
        return res.status(403).json({message: "You can't import the tests in preview mode"});

    let result = await tests.importTests(req.body);
    res.status(result ? 200 : 500).json({message: result ? "Tests imported" : "Error importing tests"});
});

app.get("/config", password(false), async (req, res) => {
    res.set({"Content-Disposition": "attachment; filename=\"config.json\""});
    config.exportConfig().then(obj => res.json(obj));
});

app.put("/config", password(false), async (req, res) => {
    if (process.env.PREVIEW_MODE === "true")
        return res.status(403).json({message: "You can't import the config in preview mode"});
    let result = await config.importConfig(req.body);
    res.status(result ? 200 : 500).json({message: result ? "Config imported" : "Error importing config"});
});

app.delete("/config", password(false), async (req, res) => {
    let result = await config.factoryReset();
    res.status(result ? 200 : 500).json({message: result ? "Config reset" : "Error resetting config"});
});

export default app;