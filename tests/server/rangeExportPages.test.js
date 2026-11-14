import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { Op } from "sequelize";
import { streamJsonArray } from "../../server/util/exportStream.js";
import { exportPages, exportTests, parsedHops } from "../../server/controller/speedtests.js";
import model from "../../server/models/Speedtests.js";
import targetModel from "../../server/models/Targets.js";

/**
 * /api/speedtests/export read its whole date range with one findAll, copied
 * every row into the export shape and rendered the copy as one string - a year
 * of five-minute tests peaked past 250 MB, which a 100 MB container limit
 * (issue #135) cannot hold. It now walks the range in pages, oldest first,
 * the way the backup export already walks the whole table.
 */
const RANGE = {from: new Date("2026-08-01T00:00:00.000Z"), to: new Date("2026-08-07T23:59:59.999Z")};
const PAGE = 2;
const HOPS = JSON.stringify([{hop: 1, address: "192.0.2.1", rtt: [1.5], lost: 0}]);

const stubReads = (rows, targets = []) => {
    const calls = [];
    mock.method(targetModel, "findAll", async () => targets);
    mock.method(model, "findAll", async (query) => {
        calls.push(query);
        return rows(calls.length);
    });
    return calls;
};

const collect = async (pages) => {
    const collected = [];
    for await (const page of pages) collected.push(page);
    return collected;
};

const row = (id, created, extra = {}) => ({id, created, error: null, hops: null, targetId: null, ...extra});

describe("exportPages", () => {
    it("reads the range oldest first, ties settled by id", async (t) => {
        const calls = stubReads(() => []);
        t.after(() => mock.restoreAll());

        await collect(exportPages(RANGE, undefined, PAGE));

        assert.deepEqual(calls[0].order, [["created", "ASC"], ["id", "ASC"]]);
        assert.equal(calls[0].limit, PAGE);
        assert.deepEqual(calls[0].where.created, {[Op.between]: [RANGE.from.toISOString(), RANGE.to.toISOString()]});
    });

    it("walks the cursor forward along the last row of each page, inside the range", async (t) => {
        const calls = stubReads((call) => call === 1
            ? [row(4, "2026-08-02T10:00:00.000Z"), row(7, "2026-08-03T10:00:00.000Z")]
            : [row(9, "2026-08-04T10:00:00.000Z")]);
        t.after(() => mock.restoreAll());

        const pages = await collect(exportPages(RANGE, undefined, PAGE));

        assert.deepEqual(pages.map((page) => page.map((entry) => entry.id)), [[4, 7], [9]]);
        const [range, cursor] = calls[1].where[Op.and];
        assert.deepEqual(range.created, {[Op.between]: [RANGE.from.toISOString(), RANGE.to.toISOString()]});
        assert.deepEqual(cursor[Op.or][0], {created: {[Op.gt]: "2026-08-03T10:00:00.000Z"}});
        assert.deepEqual(cursor[Op.or][1], {created: "2026-08-03T10:00:00.000Z", id: {[Op.gt]: 7}});
    });

    it("narrows every page to the requested target", async (t) => {
        const calls = stubReads((call) => call === 1
            ? [row(1, "2026-08-02T10:00:00.000Z"), row(2, "2026-08-03T10:00:00.000Z")]
            : []);
        t.after(() => mock.restoreAll());

        await collect(exportPages(RANGE, 5, PAGE));

        assert.equal(calls[0].where.targetId, 5);
        assert.equal(calls[1].where[Op.and][0].targetId, 5);
    });

    it("stops on a short page without asking again", async (t) => {
        const calls = stubReads(() => [row(1, "2026-08-02T10:00:00.000Z")]);
        t.after(() => mock.restoreAll());

        await collect(exportPages(RANGE, undefined, PAGE));

        assert.equal(calls.length, 1);
    });

    it("yields rows in the export shape, target named and hops parsed", async (t) => {
        stubReads((call) => call === 1
            ? [row(1, "2026-08-02T10:00:00.000Z", {targetId: 3, hops: HOPS, ping: 5, provider: "ookla"})]
            : [], [{id: 3, name: "WAN"}]);
        t.after(() => mock.restoreAll());

        const [[entry]] = await collect(exportPages(RANGE, undefined, PAGE));

        assert.equal(entry.targetName, "WAN");
        assert.deepEqual(entry.hops, parsedHops(HOPS));
        assert.ok(Array.isArray(entry.hops), "a stored route is parsed back into its table");
        assert.equal(entry.ping, 5);
        assert.equal(entry.provider, "ookla");
        assert.equal("targetId" in entry, false, "the raw id stays out of an export");
    });

    it("is what exportTests answers, page by page", async (t) => {
        const rows = [row(1, "2026-08-02T10:00:00.000Z"), row(2, "2026-08-03T10:00:00.000Z")];
        stubReads((call) => call === 1 ? rows : []);
        const paged = (await collect(exportPages(RANGE, undefined, PAGE))).flat();
        mock.restoreAll();

        stubReads((call) => call === 1 ? rows : []);
        t.after(() => mock.restoreAll());
        assert.deepEqual(await exportTests(RANGE), paged);
    });
});

describe("the compact streamed JSON export", () => {
    const capturingResponse = () => {
        const res = new EventEmitter();
        const written = [];
        res.destroyed = false;
        res.write = (chunk, callback) => { written.push(chunk); callback?.(); return true; };
        res.end = () => { res.writableEnded = true; };
        res.text = () => written.join("");
        return res;
    };
    const pages = (...list) => (async function* () { yield* list; })();
    const ROWS = [{id: 1, ping: 5.5, hops: [{hop: 1}]}, {id: 2, ping: null}, {id: 3, error: "boom"}];

    it("is byte-identical to the res.json answer it replaced", async () => {
        const res = capturingResponse();
        await streamJsonArray(res, pages(ROWS.slice(0, 2), ROWS.slice(2)), {compact: true});

        assert.equal(res.text(), JSON.stringify(ROWS));
        assert.equal(res.writableEnded, true);
    });

    it("answers an empty range the way res.json does", async () => {
        const res = capturingResponse();
        await streamJsonArray(res, pages(), {compact: true});

        assert.equal(res.text(), "[]");
    });
});
