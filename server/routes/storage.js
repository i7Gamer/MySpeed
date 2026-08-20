import express from 'express';
import * as tests from '../controller/speedtests.js';
import * as config from '../controller/config.js';
import password from '../middlewares/password.js';
import previewReadOnly from '../middlewares/previewReadOnly.js';
import { streamCsv, streamJsonArray } from '../util/exportStream.js';
import { IMPORT_BODY_LIMIT } from '../util/backupPolicy.js';

const app = express.Router();

// The size policy - the import limit, the large-body list, the backup export
// paths and their predicates - lives in util/backupPolicy.js, because the node
// proxy consumes the same figures and a controller must not import route
// wiring. app.js keeps its own 100kb parser off the large-body paths so the
// parser below gets the chance to run; re-exported here so its callers keep
// one import.
export { LARGE_BODY_PATHS, BACKUP_EXPORT_PATHS, IMPORT_BODY_LIMIT_BYTES,
    isLargeBodyPath, isBackupExportPath } from '../util/backupPolicy.js';

export const importBody = express.json({limit: IMPORT_BODY_LIMIT});

app.get("/", password(false), async (req, res) => {
    res.json(await config.getUsedStorage());
});

/**
 * The raw history, which is not the redacted one.
 *
 * Sealed on a demo whatever the format. These answer with the rows untouched,
 * so the provider and external address that /api/speedtests/export strips for
 * a caller who is not the operator went out in full through here instead - the
 * same rows by a different controller call. That export is still open on a
 * demo and is still redacted, so nothing a visitor should have is lost; this
 * is the backup path, and its PUT and DELETE siblings below have been guarded
 * all along.
 *
 * Streamed page by page rather than built as one string: the backup of an
 * instance that has simply been running is the largest thing this server ever
 * produces, and holding every row beside the whole rendered document was how
 * exporting a healthy history could take the process down with it. The bytes
 * on the wire are exactly what the one-string versions answered.
 */
const noRawHistoryOnDemo = previewReadOnly.blocking(
    "For security reasons, you can't download the raw history in preview mode");

app.get("/tests/history/json", password(false), noRawHistoryOnDemo, async (req, res) => {
    res.set({
        "Content-Type": "application/json; charset=utf-8",
        "Content-Disposition": "attachment; filename=\"speedtests.json\""
    });
    await streamJsonArray(res, tests.listPages());
});

// Uses the shared writer rather than a hand-rolled one. The old version took
// its column list from the first row, so a newest test that happened to
// succeed dropped the `error` column from the whole export, and it escaped
// with JSON rules - backslashes instead of RFC 4180's doubled quotes - which
// no spreadsheet reads back correctly.
app.get("/tests/history/csv", password(false), noRawHistoryOnDemo, async (req, res) => {
    res.set({
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": "attachment; filename=\"speedtests.csv\""
    });

    await streamCsv(res, tests.listPages());
});

app.delete("/tests/history", password(false), previewReadOnly, async (req, res) => {
    let result = await tests.deleteTests();
    res.status(result ? 200 : 500).json({message: result ? "Tests deleted" : "Error deleting tests"});
});

app.put("/tests/history", password(false), previewReadOnly, importBody, async (req, res) => {
    const {ok, imported, skipped} = await tests.importTests(req.body);

    // The counts travel with the message. A file that was half refused answered
    // the same bare "Tests imported" as one that restored whole, which is the
    // difference an operator most needs to see.
    res.status(ok ? 200 : 500).json({
        message: ok ? "Tests imported" : "Error importing tests",
        imported,
        skipped
    });
});

/**
 * Credentials are redacted unless explicitly requested, so the common "download
 * my config" path cannot leak them by accident.
 *
 * And nobody but the operator may ask at all. `includeSecrets` comes straight
 * off the query string, and preview mode admits every caller - so `GET
 * /api/storage/config?includeSecrets=true` handed an anonymous visitor to a
 * demo the admin password hash, every node password in clear and every
 * integration credential. The comment below already listed what a full export
 * carries; the route simply never asked who was asking.
 *
 * Sealed rather than forced to the redacted form, because a redacted export is
 * still the instance's configuration: it carries the cron, the quiet hours and
 * the adapter name that GET /api/config withholds from exactly this caller.
 */
app.get("/config", password(false),
    previewReadOnly.blocking("For security reasons, you can't export the configuration in preview mode"),
    async (req, res) => {
    res.set({
        "Content-Disposition": "attachment; filename=\"config.json\"",
        // A full export carries node passwords, integration tokens and the
        // admin password hash. Without this a shared proxy or the browser's own
        // disk cache is free to keep a copy of it.
        "Cache-Control": "no-store"
    });
    const includeSecrets = req.query.includeSecrets === "true";
    // Awaited: as a floating .then() a rejection was an unhandled rejection
    // and the request never answered. Awaited, it reaches the error handler.
    res.json(await config.exportConfig({includeSecrets}));
});

app.put("/config", password(false), previewReadOnly, importBody, async (req, res) => {
    const result = await config.importConfig(req.body);

    // Naming the key where there is one to name. A restore is abandoned whole on
    // the first value it cannot read, so "Error importing config" on its own
    // left the operator holding a file that would not go back and every stored
    // value to bisect by hand.
    const refusal = result.key
        ? `Error importing config: the stored value for "${result.key}" is not valid`
        : "Error importing config";

    res.status(result.ok ? 200 : 500).json({message: result.ok ? "Config imported" : refusal});
});

app.delete("/config", password(false), previewReadOnly, async (req, res) => {
    let result = await config.factoryReset();
    res.status(result ? 200 : 500).json({message: result ? "Config reset" : "Error resetting config"});
});

export default app;