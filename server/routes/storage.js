import express from 'express';
import * as tests from '../controller/speedtests.js';
import * as config from '../controller/config.js';
import password from '../middlewares/password.js';
import { toCsv } from '../util/csv.js';

const app = express.Router();

// A restore legitimately carries years of history, so these two are the only
// endpoints allowed a large body - and only once the caller has authenticated.
// app.js keeps its own 100kb parser off these paths so this one gets the chance
// to run; the two lists have to stay in step.
const IMPORT_BODY_LIMIT = '50mb';

export const LARGE_BODY_PATHS = ["/api/storage/tests/history", "/api/storage/config"];

const importBody = express.json({limit: IMPORT_BODY_LIMIT});

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

app.put("/tests/history", password(false), importBody, async (req, res) => {
    if (process.env.PREVIEW_MODE === "true")
        return res.status(403).json({message: "You can't import the tests in preview mode"});

    let result = await tests.importTests(req.body);
    res.status(result ? 200 : 500).json({message: result ? "Tests imported" : "Error importing tests"});
});

// Credentials are redacted unless explicitly requested, so the common "download
// my config" path cannot leak them by accident.
app.get("/config", password(false), async (req, res) => {
    res.set({"Content-Disposition": "attachment; filename=\"config.json\""});
    const includeSecrets = req.query.includeSecrets === "true";
    config.exportConfig({includeSecrets}).then(obj => res.json(obj));
});

app.put("/config", password(false), importBody, async (req, res) => {
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