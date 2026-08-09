import tests from '../models/Speedtests.js';
import { Op } from 'sequelize';
import { buildStatistics } from '../util/statistics.js';
import { getValue } from './config.js';

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

export const listTests = async (afterId, limit) => {
    limit = Math.min(parseInt(limit) || DEFAULT_TEST_LIMIT, MAX_TEST_LIMIT);

    let whereClause = {};

    if (afterId) whereClause.id = {[Op.lt]: afterId};

    let dbEntries = await tests.findAll({
        where: Object.keys(whereClause).length > 0 ? whereClause : undefined,
        order: [["created", "DESC"]],
        limit
    });

    for (let dbEntry of dbEntries) {
        if (dbEntry.error === null) delete dbEntry.error;
        if (dbEntry.resultId === null) delete dbEntry.resultId;
    }

    return dbEntries;
}

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
            await tests.create(entry);
            imported++;
        } catch (e) {
            skipped++;
            console.error(`Could not import the speedtest from ${entry.created}: ${e.message}`);
        }
    }

    if (skipped > 0) console.warn(`Skipped ${skipped} unusable row(s) while importing ${data.length}`);

    // Reporting success for a file where nothing was usable told the operator
    // their history had been restored when the table was still empty.
    return data.length === 0 || imported > 0;
}

// `created` always holds an ISO-8601 UTC string - both write paths guarantee it
// (create() uses toISOString(), importTests() rejects anything else) - so a
// lexicographic BETWEEN is chronologically correct on every supported backend.
// Filtering here rather than in JS keeps the whole table out of memory.
const findInRange = async ({from, to}, direction = "ASC") => tests.findAll({
    where: {created: {[Op.between]: [from.toISOString(), to.toISOString()]}},
    order: [["created", direction]]
});

export const listStatistics = async (range, options = {}) => ({
    ...buildStatistics(await findInRange(range), range, options),
    dateRange: {
        from: range.from.toISOString(),
        to: range.to.toISOString(),
        days: Math.ceil((range.to - range.from) / (24 * 60 * 60 * 1000))
    }
});

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

    // Both dialects compare against the same ISO-8601 string the rows are
    // written with. sqlite's datetime() returns "YYYY-MM-DD HH:MM:SS" - a
    // space where the stored value has a 'T', and no fractional seconds - and
    // since 'T' sorts above ' ', every row from the cutoff day compared as
    // newer than the cutoff and was never deleted.
    await tests.destroy({
        where: {
            created: process.env.DB_TYPE === "mysql"
                ? {[Op.lte]: cutoff}
                : {[Op.lte]: cutoff.toISOString()}
        }
    });
    return true;
}

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
    serverName: entry.serverName,
    serverHost: entry.serverHost,
    packetLoss: entry.packetLoss,
    downloadLatency: entry.downloadLatency,
    uploadLatency: entry.uploadLatency,
    isp: entry.isp,
    externalIp: entry.externalIp,
    error: entry.error
}));
