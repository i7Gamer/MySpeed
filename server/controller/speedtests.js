import tests from '../models/Speedtests.js';
import { Op } from 'sequelize';
import { buildStatistics, STATISTICS_COLUMNS } from '../util/statistics.js';
import { previousRange } from '../util/dateRange.js';
import { getValue } from './config.js';
import db from '../config/database.js';

const DEFAULT_RETENTION_DAYS = 365;
const MS_PER_DAY = 86400000;
const DEFAULT_TEST_LIMIT = 10;

// The route validates that `limit` is digits, which left `?limit=99999999` a
// perfectly valid way to pull the whole table into memory and serialise it.
// Callers that want everything have the export endpoints.
const MAX_TEST_LIMIT = 1000;

// Columns an import has to supply as numbers. `jitter` is absent on providers
// that do not measure it, and a failed row carries -1 placeholders, so null and
// negative values are both legitimate.
const NUMERIC_COLUMNS = ["ping", "download", "upload", "time"];

const isImportableNumber = (value) =>
    value === null || value === undefined || (typeof value === "number" && Number.isFinite(value));

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
    resultId = null, error = null, jitter = null, serverName = null, serverHost = null,
    packetLoss = null, downloadLatency = null, uploadLatency = null,
    isp = null, externalIp = null
}) => {
    return (await tests.create({ping, jitter, download, upload, error, serverId, serverName, serverHost, type,
        resultId, time, packetLoss, downloadLatency, uploadLatency, isp, externalIp,
        created: new Date().toISOString()})).id;
}

export const getOne = async (id) => {
    let speedtest = await tests.findByPk(id);
    if (speedtest === null) return null;
    if (speedtest.error === null) delete speedtest.error;
    return speedtest
}

export const listAll = async () => {
    let dbEntries = await tests.findAll({order: [["created", "DESC"]]});
    for (let dbEntry of dbEntries) {
        if (dbEntry.error === null) delete dbEntry.error;
        if (dbEntry.resultId === null) delete dbEntry.resultId;
    }

    return dbEntries;
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
export const listFilter = ({after, afterId, range} = {}) => {
    const conditions = [];

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

export const listTests = async (afterId, limit, range = null, after = null) => {
    limit = Math.min(parseInt(limit) || DEFAULT_TEST_LIMIT, MAX_TEST_LIMIT);

    let dbEntries = await tests.findAll({
        where: listFilter({after, afterId, range}),
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
export const listSuccessful = async (limit) => tests.findAll({
    where: {error: null},
    order: LIST_ORDER,
    limit
});

/**
 * How many tests failed since the given moment.
 *
 * A count rather than the rows: this is polled while a test runs, and the only
 * thing asked of it is a number.
 */
export const countFailuresSince = async (since) => tests.count({
    where: {created: {[Op.gte]: since.toISOString()}, error: {[Op.ne]: null}}
});

export const deleteTests = async () => {
    await tests.destroy({where: {}});
    return true;
}

export const importTests = async (data) => {
    if (!Array.isArray(data)) return false;

    let imported = 0;
    let skipped = 0;

    /*
     * One transaction for the whole file, rather than one per row.
     *
     * sqlite commits - and fsyncs - at the end of every statement that is not
     * already inside a transaction, so restoring a history paid that once per
     * test: 10 000 rows took 5.9 s, and the request is held open for all of it.
     * The same inserts inside a single transaction take 1.6 s.
     *
     * Still row by row inside it, and still tolerant of a row the database
     * refuses: a failed statement does not abandon the transaction on either
     * backend the project supports, so the rest of the file is written.
     */
    await db.transaction(async (transaction) => {
        for (let entry of data) {
            if (entry.error === null) delete entry.error;
            if (entry.resultId === null) delete entry.resultId;

            if (!["custom", "auto"].includes(entry.type)) { skipped++; continue; }
            if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}.\d{3}Z$/.test(entry.created)) { skipped++; continue; }

            // sqlite stores whatever it is handed, so an imported "fast" in the
            // download column survives the write and then poisons every average
            // and chart built on top of it.
            if (!NUMERIC_COLUMNS.every((column) => isImportableNumber(entry[column]))) { skipped++; continue; }

            try {
                await tests.create(entry, {transaction});
                imported++;
            } catch (e) {
                skipped++;
                console.error(`Could not import the speedtest from ${entry.created}: ${e.message}`);
            }
        }
    });

    if (skipped > 0) console.warn(`Skipped ${skipped} unusable row(s) while importing ${data.length}`);

    // Reporting success for a file where nothing was usable told the operator
    // their history had been restored when the table was still empty.
    return data.length === 0 || imported > 0;
}

/** Every test there is, oldest first - the order the aggregation reads them in. */
const findEvery = async (query = {}) => tests.findAll({order: [["created", "ASC"]], ...query});

// `created` always holds an ISO-8601 UTC string - both write paths guarantee it
// (create() uses toISOString(), importTests() rejects anything else) - so a
// lexicographic BETWEEN is chronologically correct on every supported backend.
// Filtering here rather than in JS keeps the whole table out of memory.
const findInRange = async ({from, to}, query = {}) => findEvery({
    where: {created: {[Op.between]: [from.toISOString(), to.toISOString()]}},
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

// What a period-over-period comparison actually uses: the summary figures the
// panels show. The series, labels and hourly buckets are deliberately not
// carried - nothing draws a ghost chart, and they are most of the payload.
const SUMMARY_KEYS = ["tests", "packetLoss", "ping", "jitter", "download", "upload", "time", "consistency"];

/**
 * The same summary, for the window immediately before the range.
 *
 * Computed server-side rather than by a second client request: the payload
 * stays scalar, and the definition of "the previous period" lives here next to
 * the range arithmetic instead of in a component.
 */
const previousSummary = async (range, options) => {
    const previous = previousRange(range, options);
    if (!previous.valid) return null;

    const statistics = buildStatistics(await findInRange(previous, STATISTICS_QUERY), previous, options);

    return {
        ...Object.fromEntries(SUMMARY_KEYS.map((key) => [key, statistics[key]])),
        dateRange: {
            from: previous.from.toISOString(),
            to: previous.to.toISOString()
        }
    };
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
        return {first: Math.min(extent.first, time), last: Math.max(extent.last, time)};
    }, {first: Infinity, last: -Infinity});

    // A single test - or several sharing one instant - is an extent of zero
    // width, and the bucketing divides by it.
    return {from: new Date(first), to: new Date(last === first ? last + 1 : last)};
};

/**
 * The statistics for a range, or for every test there is when given none.
 *
 * All time is the absence of a bound rather than a very wide one: the rows are
 * unfiltered, and the extent they cover is both what the charts bucket over and
 * what the client names its headings after. Nothing precedes everything, so
 * there is no previous window to compare it against.
 */
export const listStatistics = async (range, options = {}) => {
    const entries = range
        ? await findInRange(range, STATISTICS_QUERY)
        : await findEvery(STATISTICS_QUERY);

    const covered = range ?? extentOf(entries);

    return {
        ...buildStatistics(entries, covered, options),
        ...(range && options.comparePrevious ? {previous: await previousSummary(range, options)} : {}),
        // The window actually answered for, which the client names its headings
        // after and measures its per-day figures against. Whole days rather than
        // the exact span: an all-time range on a young instance is the extent of
        // its tests, and three hours of them is one day of testing rather than
        // an eighth of one - dividing by the fraction reports a rate nobody ran.
        dateRange: {
            from: covered.from.toISOString(),
            to: covered.to.toISOString(),
            days: Math.max(1, Math.ceil((covered.to - covered.from) / MS_PER_DAY))
        }
    };
};

export const deleteOne = async (id) => {
    if (await getOne(id) === null) return false;
    await tests.destroy({where: {id: id}});
    return true;
}

export const removeOld = async () => {
    const stored = await getValue("retentionDays");
    const days = parseInt(stored ?? DEFAULT_RETENTION_DAYS);

    if (!Number.isFinite(days) || days <= 0) return true;

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

export const getLatest = async () => {
    let latest = await tests.findOne({order: [["created", "DESC"]]});
    if (latest === null) return undefined;
    if (latest.error === null) delete latest.error;
    if (latest.resultId === null) delete latest.resultId;
    return latest;
}

// Named field by field rather than spread, so an export is a deliberate choice
// about what leaves the database. The cost is that a new column is exported as
// empty until it is named here - which is how the server name and host stayed
// out of every export from the moment they were added.
export const exportTests = async (range) => (await findInRange(range)).map(entry => ({
    id: entry.id,
    ping: entry.ping,
    jitter: entry.jitter,
    download: entry.download,
    upload: entry.upload,
    time: entry.time,
    type: entry.type,
    created: entry.created,
    // The id the Ookla CLI is pointed at with --server-id, and the label the
    // Prometheus exporter emits. Left out, an export/import round trip reset
    // every row to the column's 0 default.
    serverId: entry.serverId,
    serverName: entry.serverName,
    serverHost: entry.serverHost,
    packetLoss: entry.packetLoss,
    downloadLatency: entry.downloadLatency,
    uploadLatency: entry.uploadLatency,
    isp: entry.isp,
    externalIp: entry.externalIp,
    // The provider's own result page. Shown in the interface as a link since
    // long before it was exported, and left out of every export until the
    // column guard in retentionAndExport asked why.
    resultId: entry.resultId,
    error: entry.error
}));
