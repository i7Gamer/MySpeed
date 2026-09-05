import tests from '../models/Speedtests.js';
import { Op } from 'sequelize';
import { buildStatistics, STATISTICS_COLUMNS } from '../util/statistics.js';
import { resolveLimits } from '../util/targetLimits.js';
import { previousRange, shiftedRange, toCalendarParts, truncateToElapsed } from '../util/dateRange.js';
import { FAILED_TEST_FILTER, SUCCESSFUL_TEST_FILTER, impossibleMeasurement } from '../util/testOutcome.js';
import { BASELINE_METRICS } from '../util/baselineAlert.js';
import { getValue, MAX_RETENTION_DAYS } from './config.js';
import * as targetsController from './targets.js';
import db from '../config/database.js';

const DEFAULT_RETENTION_DAYS = 365;
const MS_PER_DAY = 86400000;
const DEFAULT_TEST_LIMIT = 10;

// The route validates that `limit` is digits, which left `?limit=99999999` a
// perfectly valid way to pull the whole table into memory and serialise it.
// Callers that want everything have the export endpoints.
const MAX_TEST_LIMIT = 1000;

// How far past "now" an imported row's own created instant may sit. This is
// clock skew between the exporting and the importing instance, not a real
// bound on when a test may have run - two days covers any drift worth
// tolerating without letting a hand-edited backup claim a date nobody has
// lived yet (9999-12-31, say) and have every reader that treats `created` as
// "the latest there is" quote it forever.
const IMPORT_FUTURE_SKEW_DAYS = 2;

// Columns an import has to supply as numbers. `jitter` and the three quality
// figures are absent on providers that do not measure them, and a failed row
// carries -1 placeholders, so null and negative values are both legitimate.
//
// The byte counts are in here for the same reason the speeds are: sqlite stores
// whatever it is handed, so an imported "fast" survives the write and then sits
// in the row looking like a measurement that cannot be rendered.
//
// Every measurement column belongs here, which took a second pass to hold. The
// four added last measure exactly the same kind of thing as the six that were
// listed and reach the statistics by the same route - and jitter is the worst
// of them, because the jitter series is filtered on null rather than on being a
// number, so a text value was summed and returned the whole range's average as
// NaN. There is no model-level validator behind this: the columns are DOUBLE,
// and sqlite does not care.
// serverId belongs here for the same reason as the rest, and was missing for
// the reason it went unnoticed: nothing did arithmetic on it, so text in that
// column stayed invisible until the Prometheus exporter began setting a gauge
// from it - and prom-client throws for anything that is not a number, which
// took down every scrape for as long as the row stayed newest.
const NUMERIC_COLUMNS = ["ping", "download", "upload", "time", "bytesDownloaded", "bytesUploaded",
    "jitter", "packetLoss", "downloadLatency", "uploadLatency", "serverId"];

const isImportableNumber = (value) =>
    value === null || value === undefined || (typeof value === "number" && Number.isFinite(value));

/**
 * The nullable figures a run stores through usableFigure and byteCount - the
 * ones a negative can never legitimately reach. The import mirrors the same
 * rule: a hand-edited or third-party file carrying -1 placeholders in these
 * columns stores them as unmeasured, the way the run that could not measure
 * them would have. `time` is here too: no provider can report a negative
 * duration and a failed run stores null, so a negative one is the same
 * placeholder wearing a different column. The required three are deliberately
 * absent - -1 across ping, download and upload is how a failed run is stored,
 * and the import has to keep restoring those.
 */
const NON_NEGATIVE_COLUMNS = ["jitter", "packetLoss", "downloadLatency", "uploadLatency",
    "bytesDownloaded", "bytesUploaded", "time"];

/**
 * Records a completed - or failed - speedtest and returns its id.
 *
 * Named rather than positional: this took eleven parameters, and its caller
 * already had to pass a filler `null` for `error` just to reach `jitter` behind
 * it. Argument order was the only thing keeping each measurement in its own
 * column, and every new column made that worse.
 */
export const create = async ({
    ping, download, upload, time, serverId, type = "auto",
    resultId = null, error = null, jitter = null, serverName = null, serverHost = null, serverLocation = null,
    packetLoss = null, downloadLatency = null, uploadLatency = null,
    isp = null, externalIp = null, provider = null,
    bytesDownloaded = null, bytesUploaded = null, targetId = null
}) => {
    // The timestamp travels back out with the id: the integrations are told
    // when the test was recorded, and reading it off the row here is what makes
    // the notification's `created` the same instant the row carries rather than
    // one the caller stamped a moment later.
    const created = new Date().toISOString();

    const row = await tests.create({ping, jitter, download, upload, error, serverId, serverName, serverHost, serverLocation, type,
        resultId, time, packetLoss, downloadLatency, uploadLatency, isp, externalIp, provider,
        bytesDownloaded, bytesUploaded, targetId, created});

    return {id: row.id, created};
}

export const getOne = async (id) => {
    let speedtest = await tests.findByPk(id);
    if (speedtest === null) return null;
    if (speedtest.error === null) delete speedtest.error;
    return speedtest
}

/**
 * The whole history, one page at a time, newest first.
 *
 * This is the backup export, and it used to be listAll(): every row in memory
 * at once, for the one table whose size grows with faithful use - the export
 * of a healthy two-year history was the largest allocation this server ever
 * made. The walk pages by (created, id), which is listFilter's own cursor and
 * LIST_ORDER's own sort, rather than by offset: offsets drift under a
 * concurrent insert, and ids stop agreeing with time on any imported history.
 *
 * Each page keeps the shape listAll gave every download so far: a null error
 * means a successful test and the column is dropped, resultId the same - plus
 * the target's name, which is the row's own targetId resolved to the one thing
 * about its target that still means something on another instance.
 */
export const EXPORT_PAGE_ROWS = 2500;

export const listPages = async function* (pageSize = EXPORT_PAGE_ROWS) {
    // Read once for the whole walk rather than per page: the targets change far
    // more slowly than a two-year history takes to stream, and a page is
    // already a database round trip.
    const {byId: targetNames} = await targetsController.readTargetIndex();
    let after;

    for (;;) {
        const rows = await tests.findAll({where: listFilter({after}), order: LIST_ORDER, limit: pageSize});
        if (rows.length === 0) return;

        for (const row of rows) {
            if (row.error === null) delete row.error;
            if (row.resultId === null) delete row.resultId;

            // The column CSV_COLUMNS has promised since the dashboard export
            // gained it, and which every backup CSV wrote as '""' on every
            // row: these rows come straight off the model, so they carry
            // `targetId` and no name at all, and the CSV writer, which reads
            // each row by column name, found nothing there. targetId is not a
            // CSV column either, so the backup - the one export meant to be
            // complete - was the only one carrying no target information
            // whatsoever.
            //
            // Null where the row has no target, where its target has since
            // been deleted, and on every row recorded before targets existed;
            // exportTests answers the same for those. The import reads this
            // name back through importedTargetId, which is what keeps a
            // history landing on the right line rather than on whoever holds
            // that id where it lands.
            row.targetName = targetNames.get(row.targetId) ?? null;
        }

        yield rows;

        if (rows.length < pageSize) return;
        const last = rows[rows.length - 1];
        after = {created: last.created, id: last.id};
    }
}

/**
 * Newest first, ties settled by id.
 *
 * One design with the cursor below: paging by `created` only produces stable
 * pages if the query sorts by exactly these two, in this order.
 */
export const LIST_ORDER = [["created", "DESC"], ["id", "DESC"]];

/**
 * The where clause for one page of the tests list.
 *
 * The page used to be taken with `id < afterId` while the list was ordered by
 * `created`. Those agree only while ids ascend with time, which an import does
 * not guarantee: the history export is ordered by `created` descending and the
 * import inserts in that order, so a restored instance ends up with id 1 on its
 * newest test. "Load more" then asked for `id < 3` of a list whose next rows
 * were ids 40, 41, 42, serving pages of rows already on screen while the rest
 * stayed unreachable - and since the client deduplicates by id, the reader saw
 * "Loading more" produce nothing at all. The cursor now walks the column the
 * list is actually sorted by, with the id breaking a tie between two tests
 * written in the same millisecond.
 *
 * Both halves constrain `created`, so they are joined explicitly: written into
 * one object the second would silently replace the first and a filtered list
 * would page straight out of its own window.
 *
 * `created` is compared as ISO-8601 UTC strings, the way findInRange does it:
 * every write guarantees that format, so a lexicographic comparison is
 * chronological on every backend the project supports.
 */
export const listFilter = ({after, afterId, range, target} = {}) => {
    const conditions = [];

    if (target !== undefined) conditions.push({targetId: target});

    if (range) conditions.push({created: {[Op.between]: [range.from.toISOString(), range.to.toISOString()]}});

    if (after) conditions.push({
        [Op.or]: [
            {created: {[Op.lt]: after.created}},
            {created: after.created, id: {[Op.lt]: after.id}}
        ]
    });
    // A parent proxies these requests to its nodes, and a node may still be
    // running a version that only understands the id cursor. The client sends
    // both so that node keeps working; this answers a caller that sends only
    // the id rather than dropping the cursor and restarting from the newest
    // test on every page.
    else if (afterId) conditions.push({id: {[Op.lt]: afterId}});

    if (conditions.length === 0) return undefined;

    return conditions.length === 1 ? conditions[0] : {[Op.and]: conditions};
};

export const listTests = async (afterId, limit, range = null, after = null, target = undefined) => {
    limit = Math.min(parseInt(limit) || DEFAULT_TEST_LIMIT, MAX_TEST_LIMIT);

    let dbEntries = await tests.findAll({
        where: listFilter({after, afterId, range, target}),
        order: LIST_ORDER,
        limit
    });

    for (let dbEntry of dbEntries) {
        if (dbEntry.error === null) delete dbEntry.error;
        if (dbEntry.resultId === null) delete dbEntry.resultId;
    }

    return dbEntries;
}

/**
 * The newest tests that actually measured something, newest first.
 *
 * The recommendations are built from these. They used to be filtered out of
 * listTests(), whose default limit is 10 rows *including* failures - so one
 * failed test among the newest ten shrank the sample below the required size
 * and the recommendations silently stopped updating until the failure aged out.
 */
export const listSuccessful = async (limit, targetId = undefined) => tests.findAll({
    // The sample describes one target's line when one is named - mixing a LAN
    // box's gigabit rows into a WAN target's sample is how a recommendation
    // stops meaning anything.
    where: targetId === undefined
        ? SUCCESSFUL_TEST_FILTER
        : {[Op.and]: [SUCCESSFUL_TEST_FILTER, {targetId}]},
    order: LIST_ORDER,
    limit
});

/**
 * The only columns a baseline window is read for.
 *
 * One list, defined where the median reads it, so the query and the median
 * cannot drift: a column added to one and not the other arrives as undefined,
 * which is exactly the silence STATISTICS_COLUMNS was written against
 * (util/statistics.js:16-19).
 */
export const BASELINE_ROW_COLUMNS = BASELINE_METRICS;

/**
 * One target's successful rows since the given moment, newest first.
 *
 * The rolling window the baseline alert takes its median over. Newest first
 * because the first row it answers is also the previous test - the one the
 * storm rule compares against - so the whole verdict costs one query.
 *
 * Narrow on purpose, all three ways. Only when a target actually set a
 * percentage is it asked at all; only that target's rows are read; and only the
 * two speed columns come back, where a full row carries a server name, a
 * hostname, an ISP and a result URL that no part of this looks at. The default
 * hourly cron puts about 720 rows in a window and the installer's minutely one
 * about 43,000 - two doubles apiece, which is an order of magnitude below what
 * the statistics endpoint already holds (util/statistics.js:8-19).
 *
 * The access path is the covering index speedtests_target_created, created by
 * 0013-add-targets.js and re-added for already-upgraded instances by 0014 - the
 * same walk getLatest and watchedFailureStands already lean on.
 *
 * `created` is compared as ISO-8601 UTC strings, the way listFilter and
 * findInRange do it: every write guarantees that format, so a lexicographic
 * comparison is chronological on every backend the project supports. Both
 * halves are joined explicitly, for the reason listFilter is - the shared
 * filter is keyed by Op.or, and a second Op-keyed clause written into the same
 * object would replace it.
 */
export const listForBaseline = async (targetId, since) => tests.findAll({
    where: {[Op.and]: [SUCCESSFUL_TEST_FILTER, {targetId}, {created: {[Op.gte]: since.toISOString()}}]},
    attributes: BASELINE_ROW_COLUMNS,
    order: LIST_ORDER,
    raw: true
});

/**
 * How many tests failed since the given moment - of the given targets, when a
 * scope is handed in.
 *
 * A count rather than the rows: this is polled while a test runs, and the only
 * thing asked of it is a number.
 *
 * The scope follows latestOfTargets' contract: undefined means the whole
 * instance, an empty list means nobody's failures count and the answer is
 * zero without asking the database a question whose IN () clause it may
 * refuse.
 *
 * Both halves are joined explicitly, for the reason listFilter is: the shared
 * filter is keyed by Op.or, and a second Op-keyed clause written into the same
 * object would replace it.
 */
export const countFailuresSince = async (since, targetIds = undefined) => {
    if (targetIds !== undefined && targetIds.length === 0) return 0;

    return tests.count({
        where: {[Op.and]: [
            {created: {[Op.gte]: since.toISOString()}},
            FAILED_TEST_FILTER,
            ...(targetIds !== undefined ? [{targetId: {[Op.in]: targetIds}}] : [])
        ]}
    });
};

export const deleteTests = async () => {
    await tests.destroy({where: {}});
    return true;
}

/**
 * How many rows go into one transaction, and therefore how often the import
 * lets the server answer anything else.
 *
 * The write used to be one statement per row inside one transaction for the
 * whole file. The transaction was for speed and says so: sqlite commits - and
 * fsyncs - at the end of every statement not already inside one, so a restore
 * paid that once per test, and 10 000 rows took 5.9 s instead of 1.6 s.
 *
 * What that shape also did was stop the server dead. node:sqlite's DatabaseSync
 * is synchronous and the shim resolves it through process.nextTick, so `await`
 * between rows never leaves the microtask queue: measured over 20 000 rows, the
 * event loop turned zero times - no other request, no timer, and not the
 * container healthcheck, which then times out and restarts the container in the
 * middle of the write. A 50mb body is around 610 000 rows, and an ordinary
 * multi-year history is hundreds of thousands, so this is what a real restore
 * did and not only what an attacker could ask for.
 *
 * Batched and chunked instead, which buys both halves. bulkCreate writes a
 * chunk in one statement: 175us per row became 22us, measured against this
 * model through this shim. And a chunk is its own transaction, so between them
 * there is a turn of the event loop to hand out.
 *
 * Between them, and never inside one, which is the part that had to be
 * measured rather than assumed. sqlite refuses a second writer while a
 * transaction holds the lock - not by waiting, but with "database is locked"
 * straight away - so yielding *inside* the transaction would have turned a
 * frozen server into a responsive one that drops a scheduled speedtest's
 * result. That collision is unreachable today precisely because nothing yields;
 * with the yield in the gap it stays unreachable, and 40 000 rows imported
 * under a write every 10ms produced 79 successful writes and no refusals.
 *
 * 1000 is where the throughput curve flattens - 100 rows a chunk costs 45us a
 * row against 22, because the commits stop being amortised - while still
 * turning the loop once per chunk, roughly every 22ms.
 *
 * The cost of the change is that the file is no longer written all-or-nothing.
 * It never was, in the way that matters: the counts below already report a
 * partly-usable file as partly imported, and the comment above the transaction
 * called it a speed measure rather than an atomicity one. What is genuinely
 * given up is that a crash mid-import now leaves the rows already committed -
 * and the crash this most often was, the healthcheck killing a frozen
 * container, is the thing being fixed.
 */
const IMPORT_CHUNK_ROWS = 1000;

/**
 * One chunk, in one transaction, with the tolerance the row-by-row write had.
 *
 * bulkCreate is a single statement, so a row the database refuses takes the
 * whole chunk with it. Everything a payload can get wrong is already caught
 * above - the type, the timestamp, a value that is not a number - and counted
 * without reaching the database, so this is for the other kind, and it is rare.
 * Rare is what makes the retry affordable: the chunk is rewritten a row at a
 * time only when the batch was refused, and one refusal then costs one row.
 *
 * Deliberately without {validate: true}, which is the obvious worry here since
 * create() validates and bulkCreate does not. Measured rather than assumed: on
 * every value either would take, the two agree about what is refused, and they
 * agree about what is stored for everything NUMERIC_COLUMNS does not already
 * cover - so validation changes nothing that can actually arrive, and costs 51%.
 * What it was standing in for is that list, and the coupling is pinned by
 * historyImport.test.js rather than paid for on every row.
 */
const writeImportBatch = async (rows) => {
    try {
        await db.transaction(async (transaction) => {
            await tests.bulkCreate(rows, {transaction});
        });

        return {imported: rows.length, skipped: 0};
    } catch {
        let imported = 0;
        let skipped = 0;

        await db.transaction(async (transaction) => {
            for (const row of rows) {
                try {
                    await tests.create(row, {transaction});
                    imported++;
                } catch (e) {
                    skipped++;
                    console.error(`Could not import the speedtest from ${row.created}: ${e.message}`);
                }
            }
        });

        return {imported, skipped};
    }
};

export const importTests = async (data) => {
    // The same shape a run answers with. As a bare `false` the route's
    // `{ok, imported, skipped}` came back all undefined, so the counts it
    // deliberately sends - "the counts travel with the message" - were dropped
    // from the body and a refusal answered less than a failure did.
    if (!Array.isArray(data)) return {ok: false, imported: 0, skipped: 0};

    // The targets this instance holds, read once for the whole file rather than
    // once per row: a restore is one batch of writes, and a target created
    // while it runs has no business claiming half of it. Nothing else about
    // this instance is read - see importedTargetId for why a rule that also
    // asked whether the history table was empty could not survive a restore
    // that follows a cron tick, or an import that is retried.
    const local = await targetsController.readTargetIndex();

    let imported = 0;
    let skipped = 0;

    const batch = [];

    const flush = async () => {
        if (batch.length === 0) return;

        const written = await writeImportBatch(batch.splice(0, batch.length));
        imported += written.imported;
        skipped += written.skipped;

        // The one place this whole loop gives the event loop a turn - see
        // IMPORT_CHUNK_ROWS for why it is here and not inside the transaction.
        await new Promise((resolve) => setImmediate(resolve));
    };

    for (let entry of data) {
        // Before the two deletes below, which read through `entry`: a null
        // element threw a TypeError out of the import rather than being
        // skipped, and the transaction wrapping it then rolled back every good
        // row already written. One hole in a backup restored nothing.
        if (entry === null || typeof entry !== "object") { skipped++; continue; }

        if (entry.error === null) delete entry.error;
        if (entry.resultId === null) delete entry.resultId;

        if (!["custom", "auto"].includes(entry.type)) { skipped++; continue; }
        if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(entry.created)) { skipped++; continue; }

        // The regex above only proves the string looks like an ISO instant,
        // never that the date it names exists: 2026-02-30 passes it, and
        // `new Date` silently rolls that over into March, so the row was
        // stored as written and then drawn on March 2 by every reader that
        // parses the column - and absent from any range that asked for
        // February.
        if (toCalendarParts(entry.created.slice(0, 10)) === null) { skipped++; continue; }

        // A day or two of drift between the exporting and the importing clock
        // is normal; a row from next century is not a test anyone ran, it is
        // a hand-edited file, and it would become getLatest()'s answer for
        // good.
        if (new Date(entry.created).getTime() - Date.now() > IMPORT_FUTURE_SKEW_DAYS * MS_PER_DAY) {
            skipped++;
            continue;
        }

        // sqlite stores whatever it is handed, so an imported "fast" in the
        // download column survives the write and then poisons every average
        // and chart built on top of it.
        if (!NUMERIC_COLUMNS.every((column) => isImportableNumber(entry[column]))) { skipped++; continue; }

        // A negative required measurement beside good figures is a row that is
        // neither a failure nor a measurement - isFailedTest asks for all
        // three placeholders at once, so this shape walked past it and was
        // stored as a success, where every reader believed it: the average,
        // the grade, the export, and the alert gate, which reads a download of
        // minus one megabit as an outage. The live path refuses exactly this
        // through the same judgement and records a failed run; a file's row
        // carries no run to fail, and the columns are NOT NULL, so the honest
        // answers left are the two beside it - a failure it does not claim to
        // be, or no row. Skipped, like every other row no run could have
        // produced. A full set of placeholders is a failed run and never
        // reaches this; a measured zero is an outage's honest reading and is
        // deliberately not caught.
        if (impossibleMeasurement(entry) !== null) { skipped++; continue; }

        // Without the backup's own id. Those are the ids of the instance that
        // wrote the file and mean nothing on the one reading it - written
        // through, every id already taken raised a UNIQUE violation, which was
        // counted as an unusable row while the route still reported success.
        // The shape that costs the most is the ordinary one: a disk dies,
        // MySpeed is reinstalled and runs for a week before anyone gets to the
        // backup, and the restore then silently discards exactly the
        // overlapping week. Left to the database, nothing collides.
        const {id, targetId, targetName, ...row} = entry;

        // As unmeasured, not as an error: the row is the history somebody is
        // restoring, and one poisoned figure must not cost the measurements
        // beside it.
        for (const column of NON_NEGATIVE_COLUMNS)
            if (typeof row[column] === "number" && row[column] < 0) row[column] = null;

        // The file's targetId does not go through either, and it is dropped
        // rather than trusted: it is an id of the instance that wrote the file,
        // and on an instance that already measures its own lines it did not
        // fail to mean anything - it pointed at whichever target happens to
        // hold that number here, an attribution that is wrong rather than
        // missing and that nothing in the interface or in the counts below
        // reports. What places the row instead is the target name the export
        // writes beside it, resolved against the targets this instance holds.
        //
        // A name that resolves to nothing leaves the row in the history with no
        // target at all, which every reader already handles - it is what the
        // rows of a deleted target have carried all along, since the column is
        // deliberately not a foreign key.
        //
        // Which also puts the column beyond a payload's reach: targetId is not
        // in NUMERIC_COLUMNS, so until now a hand-edited backup could park a
        // string in an INTEGER column and sqlite would keep it.
        row.targetId = targetsController.importedTargetId(entry, local);

        batch.push(row);
        if (batch.length >= IMPORT_CHUNK_ROWS) await flush();
    }

    await flush();

    if (skipped > 0) console.warn(`Skipped ${skipped} unusable row(s) while importing ${data.length}`);

    // Reporting success for a file where nothing was usable told the operator
    // their history had been restored when the table was still empty. The
    // counts travel with it so a partly-usable file is not reported as a whole
    // one either.
    return {
        ok: data.length === 0 || imported > 0,
        imported,
        skipped
    };
}

/** Every test there is, oldest first - the order the aggregation reads them in. */
const findEvery = async (query = {}) => tests.findAll({order: [["created", "ASC"]], ...query});

/**
 * The `where` fragment that narrows a read to one target, to several, or to no
 * target at all.
 *
 * The list arm is the whole of what makes a batched statistics request cheap: a
 * page asking about a dozen targets reads the range once with an IN rather than
 * a dozen times with an equality, and the partitioning that follows is done over
 * rows that are already in memory. Written as a fragment rather than inline, so
 * the two reads a statistics request makes - the range and the window before it
 * - cannot end up narrowed by two different rules.
 *
 * An empty list is not handled here and must not reach it: `targetId IN ()` is
 * not something to hand to three dialects, and the callers answer "no targets"
 * without asking the database at all - see latestOfTargets and
 * listStatisticsByTarget, which both short circuit on it.
 *
 * Exported for its test, which is where the promise about the IN is visible
 * without counting queries against a live database.
 */
export const targetFilter = (target) => {
    if (target === undefined) return {};

    return {targetId: Array.isArray(target) ? {[Op.in]: target} : target};
};

// `created` always holds an ISO-8601 UTC string - both write paths guarantee it
// (create() uses toISOString(), importTests() rejects anything else) - so a
// lexicographic BETWEEN is chronologically correct on every supported backend.
// Filtering here rather than in JS keeps the whole table out of memory.
const findInRange = async ({from, to}, query = {}, target = undefined) => findEvery({
    where: {
        created: {[Op.between]: [from.toISOString(), to.toISOString()]},
        ...targetFilter(target)
    },
    ...query
});

/**
 * How the rows a summary is built from are read.
 *
 * Only the columns the aggregation looks at, because a wide range holds all of
 * them in memory at once and the rest of a row is text nothing there reads -
 * see STATISTICS_COLUMNS. `raw` skips building a model instance per row, which
 * nothing here needs either: buildStatistics only reads properties. The export
 * below takes the whole row and so passes none of this.
 */
const STATISTICS_QUERY = {attributes: STATISTICS_COLUMNS, raw: true};

/**
 * The same read plus the one column the aggregation itself never looks at:
 * which target each row measured.
 *
 * Not added to STATISTICS_COLUMNS, whose contract is exactly the set
 * statistics.js reads - the test beside that file scans its source and fails a
 * column that is selected and read nowhere in it. It rides on the read that is
 * happening anyway rather than asking a question of its own, because the
 * summary already holds every row it covers in memory: one integer per row is
 * far cheaper than a second scan of the same window, which is the cost
 * comparePrevious is opt-in to avoid.
 *
 * What it is for: the client grades a page's cards against one target's optimal
 * values when the page is showing one target, and "one target is configured" is
 * not that. Deleting a target leaves its rows behind - the history is the
 * history - and a restored export comes back with no target at all, since the
 * file carries the target's name and no id that would mean anything on another
 * instance. Nothing narrows a single-target page's query, so those rows sit
 * inside every figure on it, and only the rows themselves can say so. See
 * pageTarget in client/src/common/utils/TargetUtil.js.
 *
 * Exported so a test can hold the column in place, because nothing here fails
 * loudly without it. The rows would simply arrive without a targetId,
 * targetsPresent would answer [null] for every page, and the client reads a
 * page of nulls as a mixture - so every single-target instance would quietly go
 * back to grading against the instance-wide settings with not one assertion
 * failing. The failure streak would go the same way in silence: reliabilityOver
 * groups on this column, and one group is exactly the row-adjacency reading it
 * was written to replace.
 *
 * It rides in STATISTICS_COLUMNS rather than beside it now. It used to be
 * appended here because the aggregation selected it and read it nowhere, which
 * that list is not for; the streak reads it, so the list is where it belongs.
 */
export const SUMMARISED_ROWS_QUERY = {attributes: [...STATISTICS_COLUMNS], raw: true};

/**
 * The distinct targets the summarised rows belong to, a row that names none
 * counted as null.
 *
 * At most one entry per target however many rows were summarised, so it costs
 * the payload nothing. Exported for its test, which is what holds it to
 * answering null rather than undefined for an untargeted row: the client
 * compares these against target ids, and undefined would compare equal to
 * nothing while reading - in a log, in a test failure - exactly like the
 * absence it stands for.
 */
export const targetsPresent = (entries) => [...new Set(entries.map((entry) => entry.targetId ?? null))];

// What a period-over-period comparison actually uses: the summary figures the
// panels show. The series, labels and hourly buckets are deliberately not
// carried - nothing draws a ghost chart, and they are most of the payload.
const SUMMARY_KEYS = ["tests", "packetLoss", "ping", "jitter", "download", "upload", "time", "consistency", "dataUsed",
    "targetMet"];

/**
 * The window a comparison is taken over, or null when there is none to take.
 *
 * Worked out apart from the summary below because a batched request would
 * otherwise ask the same question once per target: the window follows from the
 * range and the caller's offset alone, never from the rows, so repeating the
 * arithmetic per target would be one more place for two paths to disagree about
 * what "the period before" means.
 */
const comparisonWindow = (range, options) => {
    /*
     * How far back the comparison looks, never how much of it to look at.
     *
     * "The period before" is the default answer and the offsets are the same
     * question asked further back - both are the range's own length, so the
     * two windows are comparable by construction. Both shapes are a parsed
     * range, so everything below - the elapsed cut, the target filter, the
     * summary - reads one thing.
     */
    const previous = options.compareMonths
        ? shiftedRange(range, options.compareMonths, options)
        : previousRange(range, options);

    if (!previous.valid) return null;

    // Cut to what the range has actually lived through: a range ending today
    // is a part-week, and counted against a whole previous week every total
    // read lower on every partial day. Null when none of the range has
    // happened yet - there is nothing a comparison could be about.
    return truncateToElapsed(range, previous, options.now ?? new Date());
};

/**
 * The summary itself, from rows already read for the window.
 *
 * Takes the rows rather than fetching them, so a batched request can read the
 * comparison window once and hand each target its own share of what came back -
 * the whole point of the batch being that N targets cost one scan and not N.
 */
const comparisonSummary = (entries, window, options) => {
    const statistics = buildStatistics(entries, window, options);

    return {
        ...Object.fromEntries(SUMMARY_KEYS.map((key) => [key, statistics[key]])),
        dateRange: {
            from: window.from.toISOString(),
            to: window.to.toISOString(),
            // Says the last day is covered only up to the time the range has
            // lived of its own - now's wall clock, except across a shift, when
            // the elapsed offset is the honest measure (see truncateToElapsed)
            // - so the note above the deltas can say so too. Absent, not
            // false, for a complete window - the way every other optional
            // echo travels.
            ...(window.partial && {partial: true})
        }
    };
};

/**
 * The same summary, for the window immediately before the range.
 *
 * Computed server-side rather than by a second client request: the payload
 * stays scalar, and the definition of "the previous period" lives here next to
 * the range arithmetic instead of in a component.
 */
const previousSummary = async (range, options) => {
    const window = comparisonWindow(range, options);
    if (window === null) return null;

    // The comparison answers for the same slice the range does - a filtered
    // window compared against everyone's previous window would report a delta
    // between two different questions.
    return comparisonSummary(
        await findInRange(window, STATISTICS_QUERY, options.target), window, options);
};

/**
 * The extent of the tests themselves: the window all time is summarised over.
 *
 * The charts bucket over the window they are given, so summarising everything
 * over a stand-in window wide enough to hold anything the server keeps would
 * push a year of tests into the last few of its three hundred buckets and draw
 * the whole history as a handful of points.
 */
const extentOf = (entries) => {
    // An instance that has never run a test has no extent at all; this moment is
    // the one window that is certainly empty and certainly valid.
    if (entries.length === 0) return {from: new Date(), to: new Date()};

    const {first, last} = entries.reduce((extent, entry) => {
        const time = new Date(entry.created).getTime();

        // A row whose created does not parse cannot bound a window it has no
        // place in. Math.min against NaN is NaN, so one of them turned both
        // bounds into Invalid Dates - which the dateRange echo below throws on,
        // and which the chart bucketing reads as a range of no width.
        if (Number.isNaN(time)) return extent;

        return {first: Math.min(extent.first, time), last: Math.max(extent.last, time)};
    }, {first: Infinity, last: -Infinity});

    // Every row the instance holds is undateable, which is the empty extent
    // again: there is no window its tests can be said to cover.
    if (!Number.isFinite(first)) return {from: new Date(), to: new Date()};

    // A single test - or several sharing one instant - is an extent of zero
    // width, and the bucketing divides by it.
    return {from: new Date(first), to: new Date(last === first ? last + 1 : last)};
};

// Two decimals, because this is a divisor before it is a display figure: the
// relative error of rounding is half a unit in the last place over the value,
// so at the 0.1 floor one decimal made the divisor up to half again the true
// rate, while two keep it within five percent everywhere the gate lets it out.
// Below a tenth of a day the whole-day divisor is the saner figure, so nothing
// is sent at all - judged on the raw span, not the rounded one, which rounded
// six percent of a day UP into the very tenth the gate then accepted.
const ELAPSED_DAY_DECIMALS = 2;
const MIN_ELAPSED_DAYS = 0.1;

/**
 * How much of a still-running range has actually elapsed, in days - or null
 * for a window that is complete or has not begun, which keep the whole-day
 * figure beside it as their honest divisor.
 *
 * Measured in elapsed time rather than calendar days deliberately: this is the
 * divisor for a rate, and "how long has the sampling been running" is a
 * question about elapsed time. The whole-day count stays what the headings and
 * every complete window are described by.
 */
const elapsedDaysOf = (range, now) => {
    if (!range || now >= range.to || now < range.from) return null;

    const elapsed = (now - range.from) / MS_PER_DAY;
    if (elapsed < MIN_ELAPSED_DAYS) return null;

    return parseFloat(elapsed.toFixed(ELAPSED_DAY_DECIMALS));
};

/**
 * The payload itself, assembled from rows that have already been read.
 *
 * Shared by the single answer and by every entry of a batched one, because the
 * batch promises to hand back exactly what a single-target request hands back.
 * Assembled twice it would be two things to keep in step, and the copy read
 * only by a comparison panel is the one that would quietly fall behind - a
 * field added to the page's request arriving in the page and missing from the
 * panel beside it, with nothing failing to say so.
 *
 * `previous` is passed in rather than computed here, and its three states are
 * the contract: undefined leaves the key off the payload entirely, which is
 * what a request that asked for no comparison gets, while null is the key
 * present and empty - a comparison was asked for and there is no window to take
 * it over. `options.now` is required rather than defaulted, so that the
 * elapsed-day figure below and the comparison the caller already built cannot
 * disagree about when now was.
 */
const summarise = (entries, range, options, previous) => {
    const covered = range ?? extentOf(entries);
    const elapsedDays = elapsedDaysOf(range, options.now);

    return {
        ...buildStatistics(entries, covered, options),
        // Which targets these figures were actually built from. The client
        // cannot work that out from the target list alone - a single-target
        // instance still holds the rows of every target it has deleted, and
        // every row an import brought back without one - and it is those rows
        // that make the sole target's optima the wrong thing to judge the page
        // by. A filtered request answers the one target it was narrowed to,
        // which is the same statement about the same rows.
        targetIds: targetsPresent(entries),
        ...(previous !== undefined ? {previous} : {}),
        // The window actually answered for, which the client names its headings
        // after and measures its per-day figures against. Whole days rather than
        // the exact span: an all-time range on a young instance is the extent of
        // its tests, and three hours of them is one day of testing rather than
        // an eighth of one - dividing by the fraction reports a rate nobody ran.
        dateRange: {
            from: covered.from.toISOString(),
            to: covered.to.toISOString(),
            // A parsed range counted its own calendar days, which no daylight
            // saving change inside it can move; the ceiling of the span is only
            // right for the all-time extent, whose bounds are two real test
            // instants rather than two midnights.
            days: covered.days ?? Math.max(1, Math.ceil((covered.to - covered.from) / MS_PER_DAY)),
            // And, for a range that is still running, how much of it has: a
            // seven-day range at Wednesday noon has been sampled for two and a
            // half days, and a per-day figure divided by seven understates the
            // rate by the days that have not happened yet. Absent for every
            // complete window - and from an older node, which the client's
            // whole-day fallback already covers.
            ...(elapsedDays !== null && {elapsedDays})
        }
    };
};

/**
 * The statistics for a range, or for every test there is when given none.
 *
 * All time is the absence of a bound rather than a very wide one: the rows are
 * unfiltered, and the extent they cover is both what the charts bucket over and
 * what the client names its headings after. Nothing precedes everything, so
 * there is no previous window to compare it against.
 */
// The three instance-wide optimal values, by their config keys.
const OPTIMUM_KEYS = ["ping", "download", "upload"];

/**
 * What each target's rows are graded against, read once per request.
 *
 * The target-met count judges every row in the range, so the resolver reads
 * the target list and the three settings up front and answers from memory -
 * one lookup per request rather than one per row. A row whose target is gone,
 * or that predates targets, resolves to the settings wholesale, exactly as the
 * client's resolveLimits does for the colours the count mirrors.
 */
const limitsResolver = async () => {
    const [targetRows, optima] = await Promise.all([
        targetsController.listAll(),
        Promise.all(OPTIMUM_KEYS.map((key) => getValue(key)))
    ]);
    const config = Object.fromEntries(OPTIMUM_KEYS.map((key, index) => [key, optima[index]]));
    const byId = new Map(targetRows.map((row) => [row.id, row]));

    return (targetId) => resolveLimits(byId.get(targetId), config);
};

export const listStatistics = async (range, options = {}) => {
    // One reading of the clock for the whole answer, carried in the options the
    // comparison and the summary are both built from: the previous window's cut
    // and the elapsed-day figure must not disagree about when now was. The
    // limits ride along the same way, so the previous window's target-met count
    // is judged by the same optima as this one's.
    const shared = {...options, now: options.now ?? new Date(), limitsFor: await limitsResolver()};
    const targetWhere = options.target !== undefined ? {where: targetFilter(options.target)} : {};
    const entries = range
        ? await findInRange(range, SUMMARISED_ROWS_QUERY, options.target)
        : await findEvery({...SUMMARISED_ROWS_QUERY, ...targetWhere});

    // Undefined rather than null when nothing asked for a comparison, which is
    // what leaves the key off the payload altogether - see summarise.
    const previous = range && options.compare ? await previousSummary(range, shared) : undefined;

    return summarise(entries, range, shared, previous);
};

/**
 * The rows of one read, split into the target each of them measured.
 *
 * Every requested id gets a bucket whether a row landed in it or not, because a
 * target that has been quiet is an answer rather than an absence: a panel
 * drawing a column per target must not lose one because the line reported
 * nothing this week, and a caller must not have to tell "no tests" apart from
 * "no key".
 *
 * Keyed by the id written as a string, which is what the response is keyed by
 * anyway and what closes the one way this could go wrong quietly. A row's
 * targetId comes back from whichever dialect is underneath, and an id that
 * arrived as a string where the request carried a number would fall into no
 * bucket at all - the target would answer as empty while its rows sat in the
 * result set, with nothing raising. A row belonging to no target (a restored
 * export, a test older than targets) lands on the key "null", which no
 * digits-only id can be, so it is dropped rather than folded into whichever
 * entry it was nearest.
 */
const groupByTarget = (entries, ids) => {
    const grouped = new Map(ids.map((id) => [String(id), []]));

    for (const entry of entries) grouped.get(String(entry.targetId))?.push(entry);

    return grouped;
};

/**
 * The statistics of several targets at once, each entry exactly what a
 * single-target request would have answered on its own.
 *
 * One scan of the range, plus one of the window before it when a comparison was
 * asked for, partitioned in memory - never a scan per target. The rows are the
 * same rows either way, so what this saves is not database work but requests:
 * the statistics family is rate limited, and the comparison panel this exists
 * for asked once per target, so a dozen targets stepped through a handful of
 * timeframes walked into the limit and left the reader with a 429 and a blank
 * panel for doing nothing but clicking around. That cost is what kept the panel
 * lazy; one request per page rather than one per target is what lets it be
 * eager.
 *
 * Answered as an object keyed by the id as a string, because that is what an
 * object key is. Everything else - the range, the comparison offset, the
 * timezone, the point count - means exactly what it means for a single answer
 * and is applied to each entry, so each target's `previous` is that target's
 * own previous window rather than the instance's.
 */
export const listStatisticsByTarget = async (range, ids, options = {}) => {
    // One reading of the clock for every entry, for the reason listStatistics
    // takes one for its single answer - and here it also keeps the entries
    // agreeing with each other rather than only with themselves. The limits
    // likewise: one read, every target's entry judged by the same optima.
    const shared = {...options, now: options.now ?? new Date(), limitsFor: await limitsResolver()};

    /*
     * Collapsed here as well as at the route that parses the parameter, so the
     * promise of one entry per distinct id belongs to this function rather than
     * to whoever called it. Through Number, because the ids reach the database
     * as an IN list and a dialect that does not coerce would match nothing at
     * all for an id that arrived as a string.
     */
    const wanted = [...new Set(ids.map((id) => Number(id)))];

    // Asking about no targets is a real request - a page whose target list has
    // not loaded yet - and the answer is known without a query. `targetId IN ()`
    // is not something to hand to three dialects; the same short circuit
    // latestOfTargets keeps, for the same reason.
    if (wanted.length === 0) return {};

    const entries = range
        ? await findInRange(range, SUMMARISED_ROWS_QUERY, wanted)
        : await findEvery({...SUMMARISED_ROWS_QUERY, where: targetFilter(wanted)});

    const rows = groupByTarget(entries, wanted);

    /*
     * The comparison window is a property of the range, so every target is
     * compared against the same window and one scan answers all of them.
     *
     * Three states, matching what summarise() does with `previous`: undefined
     * for a request that asked for no comparison, null for one that asked and
     * has no window to take it over, and a parsed window otherwise.
     */
    const comparison = range && options.compare ? comparisonWindow(range, shared) : undefined;
    const comparisonRows = comparison
        ? groupByTarget(await findInRange(comparison, STATISTICS_QUERY, wanted), wanted)
        : null;

    const previousFor = (key) => {
        if (comparison === undefined) return undefined;
        if (comparison === null) return null;

        return comparisonSummary(comparisonRows.get(key), comparison, shared);
    };

    return Object.fromEntries(wanted.map((id) => {
        const key = String(id);

        return [key, summarise(rows.get(key), range, shared, previousFor(key))];
    }));
};

export const deleteOne = async (id) => {
    if (await getOne(id) === null) return false;
    await tests.destroy({where: {id: id}});
    return true;
}

// Said once per process rather than per sweep: the prune runs every minute,
// and the row cannot change without an operator editing it. Re-armed once the
// row is fixed, so a second hand edit is reported again.
let warnedAboutRetention = false;

export const removeOld = async () => {
    const stored = await getValue("retentionDays");
    const days = parseInt(stored ?? DEFAULT_RETENTION_DAYS);

    if (!Number.isFinite(days) || days <= 0) return true;

    // Refused rather than capped, and only a hand-edited row reaches this: the
    // door holds the value to MAX_RETENTION_DAYS and importConfig runs every
    // value through the door. Past about 1e11 days the cutoff is not a date
    // and toISOString threw a RangeError out of the prune; capping would
    // delete more than the row asks for, so nothing is pruned and it is said.
    if (days > MAX_RETENTION_DAYS) {
        if (!warnedAboutRetention)
            console.warn(`retentionDays is ${days}, beyond the ${MAX_RETENTION_DAYS}-day limit; nothing was pruned`);
        warnedAboutRetention = true;
        return true;
    }
    warnedAboutRetention = false;

    const cutoff = new Date(Date.now() - days * MS_PER_DAY);

    await tests.destroy({where: {created: retentionCutoffFilter(cutoff)}});
    return true;
}

/**
 * The comparison the sweep deletes with, on every dialect. Exported for its
 * test, which is what holds the dialects to one behaviour.
 *
 * `created` is stored as an ISO-8601 UTC string everywhere - the model maps
 * the column to STRING on mysql - so the cutoff has to be the same kind of
 * string everywhere too. Each dialect has now had its own version of this bug:
 * sqlite once compared against datetime()'s "YYYY-MM-DD HH:MM:SS", and mysql
 * against a Date the dialect renders the same way - a space where the stored
 * value has a 'T', and since ' ' sorts below 'T', every row from the cutoff
 * day compared as newer and survived the sweep.
 */
export const retentionCutoffFilter = (cutoff) => ({[Op.lte]: cutoff.toISOString()});

export const getLatest = async (targetId = undefined) => {
    let latest = await tests.findOne({
        // LIST_ORDER, not `created` alone: an imported history can carry two
        // rows with the identical stamp - the retried restore does exactly
        // that - and "the latest" must not depend on which of them the engine
        // happens to visit last.
        order: LIST_ORDER,
        ...(targetId !== undefined && {where: {targetId}})
    });
    if (latest === null) return undefined;
    if (latest.error === null) delete latest.error;
    if (latest.resultId === null) delete latest.resultId;
    return latest;
}

/**
 * The newest test belonging to any of the given targets.
 *
 * One query rather than getLatest() per target: /status asks this on every
 * poll, and the answer it wants is a single row. (The keep-alive used to be
 * the caller here; it asks getLatest() per watched target now, because its
 * question became "does any watched line's newest result stand as a failure"
 * rather than "what is the newest watched row".)
 *
 * Ordered by LIST_ORDER, the same way getLatest is. A round writes its
 * members' rows seconds apart at most, and an imported history can carry two
 * rows with the identical stamp; the id breaks that tie towards the row
 * written last, which is the one whose notification the caller is being asked
 * whether to preserve.
 *
 * An empty list is answered without asking the database at all. It is a real
 * case - every configured target has alerts switched off - and `IN ()` is not
 * something to hand to three dialects when the answer is already known. sqlite
 * happens to tolerate it, so this short circuit is a precaution for the two
 * backends the suite cannot boot rather than something a test here can see.
 *
 * Undefined rather than null for "nothing", so a caller can hold this and
 * getLatest to the same contract. The null columns getLatest deletes are left
 * alone: the only reader is isFailedTest, which asks whether `error` is truthy.
 */
export const latestOfTargets = async (targetIds) => {
    if (targetIds.length === 0) return undefined;

    return await tests.findOne({where: {targetId: {[Op.in]: targetIds}}, order: LIST_ORDER}) ?? undefined;
}

// Named field by field rather than spread, so an export is a deliberate choice
// about what leaves the database. The cost is that a new column is exported as
// empty until it is named here - which is how the server name and host stayed
// out of every export from the moment they were added.
export const exportTests = async (range, target = undefined) => {
    // Resolved to names, because an export is read by people and other tools -
    // and by the import on another instance: a bare targetId is meaningless
    // outside this one, while the name says which line the row measured, and
    // importedTargetId resolves it back against the local targets on a restore.
    // Orphaned and pre-target rows export null.
    //
    // Through the shared index rather than an object built here: the lookup is
    // by a value an older import could have left as a string, and one
    // `names["toString"]` answering with Object.prototype's function is
    // exactly the trap this file's neighbours keep being fixed for.
    const {byId: names} = await targetsController.readTargetIndex();

    return (await findInRange(range, {}, target)).map(entry => ({
    id: entry.id,
    ping: entry.ping,
    jitter: entry.jitter,
    download: entry.download,
    upload: entry.upload,
    time: entry.time,
    type: entry.type,
    created: entry.created,
    // Which provider measured the row. Without it a restored history cannot say
    // why its older rows carry no packet loss, and neither can its reader.
    provider: entry.provider,
    // The id the Ookla CLI is pointed at with --server-id, and the label the
    // Prometheus exporter emits. Left out, an export/import round trip reset
    // every row to the column's 0 default.
    serverId: entry.serverId,
    serverName: entry.serverName,
    serverHost: entry.serverHost,
    serverLocation: entry.serverLocation,
    packetLoss: entry.packetLoss,
    downloadLatency: entry.downloadLatency,
    uploadLatency: entry.uploadLatency,
    isp: entry.isp,
    externalIp: entry.externalIp,
    bytesDownloaded: entry.bytesDownloaded,
    bytesUploaded: entry.bytesUploaded,
    // The provider's own result page. Shown in the interface as a link since
    // long before it was exported, and left out of every export until the
    // column guard in retentionAndExport asked why.
    resultId: entry.resultId,
    targetName: names.get(entry.targetId) ?? null,
    error: entry.error
}));
};
