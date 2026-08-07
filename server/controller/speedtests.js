import tests from '../models/Speedtests.js';
import { Op, Sequelize } from 'sequelize';
import { buildStatistics } from '../util/statistics.js';
import { getValue } from './config.js';

const DEFAULT_RETENTION_DAYS = 365;
const DEFAULT_TEST_LIMIT = 10;

export const create = async (ping, download, upload, time, serverId, type = "auto", resultId = null, error = null, jitter = null, serverName = null, serverHost = null) => {
    return (await tests.create({ping, jitter, download, upload, error, serverId, serverName, serverHost, type, resultId, time, created: new Date().toISOString()})).id;
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
    limit = parseInt(limit) || DEFAULT_TEST_LIMIT;

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

export const deleteTests = async () => {
    await tests.destroy({where: {}});
    return true;
}

export const importTests = async (data) => {
    if (!Array.isArray(data)) return false;

    for (let entry of data) {
        if (entry.error === null) delete entry.error;
        if (entry.resultId === null) delete entry.resultId;

        if (!["custom", "auto"].includes(entry.type)) continue;
        if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}.\d{3}Z$/.test(entry.created)) continue;

        try {
            await tests.create(entry);
        } catch (e) {
            console.error(`Could not import the speedtest from ${entry.created}: ${e.message}`);
        }
    }

    return true;
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

    await tests.destroy({
        where: {
            created: process.env.DB_TYPE === "mysql"
                ? {[Op.lte]: new Date(new Date().getTime() - days * 24 * 3600000)}
                : {[Op.lte]: Sequelize.literal(`datetime('now', '-${days} days')`)}
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

export const exportTests = async (range) => (await findInRange(range)).map(entry => ({
    id: entry.id,
    ping: entry.ping,
    jitter: entry.jitter,
    download: entry.download,
    upload: entry.upload,
    time: entry.time,
    type: entry.type,
    created: entry.created,
    error: entry.error
}));
