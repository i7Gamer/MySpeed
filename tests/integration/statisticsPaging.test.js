import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { Op } from "sequelize";
import { bootServer, seedTests } from "./helpers/boot.js";
import { forEachSummarisedRow, listStatistics, SUMMARISED_ROWS_QUERY } from "../../server/controller/speedtests.js";
import { buildStatistics } from "../../server/util/statistics.js";

/*
 * The summary is read a page at a time on a (created, id) keyset. Every row
 * must arrive exactly once and in the order the single read delivered them -
 * the floating-point sums and the tie order of the timeline depend on it - so
 * the pager is held to that order on a real database, at page sizes that put
 * a boundary inside every run of tied instants.
 */

let server;
const BASE = Date.parse("2026-03-01T00:00:00.000Z");
const MS_PER_MINUTE = 60 * 1000;
const PAGE_SIZES = [1, 2, 3, 4, 7, 1000];
const ROWS = 40;
const NOW = new Date("2026-04-01T00:00:00.000Z");

// Runs of up to four tests sharing one instant, two targets, a few failures,
// and three rows with no created at all.
const fixture = () => {
    const rows = Array.from({length: ROWS}, (_, index) => ({
        created: new Date(BASE + Math.floor(index / 4) * MS_PER_MINUTE).toISOString(),
        targetId: 1 + (index % 2),
        download: 100 + index * 1.37,
        ...(index % 9 === 0 && {error: "timeout", ping: -1, download: -1, upload: -1})
    }));
    // Shuffled before the insert, so the id order differs from the created order.
    rows.reverse();
    rows.splice(5, 0, {created: null, targetId: 1}, {created: null, targetId: 2});
    rows.push({created: null, targetId: 1});
    return rows;
};

const singleRead = (where = {}) => server.tests.findAll({
    ...SUMMARISED_ROWS_QUERY, attributes: [...SUMMARISED_ROWS_QUERY.attributes, "id"],
    where, order: [["created", "ASC"], ["id", "ASC"]]
});

const paged = async (where, pageRows) => {
    const rows = [];
    await forEachSummarisedRow(where, (row) => rows.push(row), pageRows);
    return rows;
};

before(async () => {
    server = await bootServer();
    await seedTests(server.tests, fixture());
});

after(async () => {
    await server?.close();
});

describe("forEachSummarisedRow", () => {
    it("has the rows with no created to page through", async () => {
        assert.equal((await singleRead({created: null})).length, 3);
    });

    for (const pageRows of PAGE_SIZES) {
        it(`visits every row once, in created then id order, ${pageRows} at a time`, async () => {
            assert.deepStrictEqual(await paged({}, pageRows), await singleRead());
        });
    }

    it("pages a narrowed read the same way", async () => {
        const where = {
            created: {[Op.between]: [new Date(BASE + 2 * MS_PER_MINUTE).toISOString(),
                new Date(BASE + 6 * MS_PER_MINUTE).toISOString()]},
            targetId: 2
        };
        const expected = await singleRead(where);
        assert.ok(expected.length > 3, "the window holds more than one page");
        assert.deepStrictEqual(await paged(where, 3), expected);
    });

    it("visits nothing when nothing matches", async () => {
        assert.deepStrictEqual(await paged({targetId: 99}, 2), []);
    });
});

describe("listStatistics over the paged read", () => {
    it("answers what aggregating the single read answers", async () => {
        const rows = await singleRead();
        const range = {from: new Date(BASE), to: new Date(BASE + ROWS * MS_PER_MINUTE)};
        const options = {now: NOW, offsetMinutes: 0};
        const {targetIds, dateRange, ...statistics} = await listStatistics(range, options);
        const inRange = rows.filter((row) => row.created !== null);
        const expected = buildStatistics(inRange, range, options);

        assert.deepStrictEqual(targetIds, [2, 1]);
        assert.equal(dateRange.from, range.from.toISOString());
        // The target-met count depends on the limits resolver the controller
        // reads from settings, which the pure call has no copy of - every other
        // figure must match.
        delete statistics.targetMet;
        delete expected.targetMet;
        assert.deepStrictEqual(statistics, expected);
    });
});
