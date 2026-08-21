import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { Op } from "sequelize";
import { CSV_HEADER, toCsv } from "../../server/util/csv.js";
import { streamCsv, streamJsonArray } from "../../server/util/exportStream.js";
import { EXPORT_PAGE_ROWS, listPages } from "../../server/controller/speedtests.js";
import model from "../../server/models/Speedtests.js";

/**
 * The history export used to be one string.
 *
 * listAll() pulled every row into memory, JSON.stringify(rows, null, 4) built
 * the whole document beside them, and toCsv did the same for the other format.
 * The backup of an instance that has simply been running - a test every few
 * minutes for a couple of years - is the largest thing this server ever
 * produces, and producing it as one allocation is how the export of a healthy
 * history takes down the scheduler, the API and the database handle with it.
 *
 * The export now walks the table in pages and writes as it goes. What these
 * cases hold it to is byte-for-byte what the one-string version answered:
 * a backup format is a contract with every file already downloaded.
 */
const ROWS = [
    {id: 3, ping: 5.5, download: 100.2, upload: 40.1, created: "2026-08-03T10:00:00.000Z", error: "boom"},
    {id: 2, ping: 6, download: 90, upload: 41, created: "2026-08-02T10:00:00.000Z"},
    {id: 1, ping: 7, download: 80, upload: 42, created: "2026-08-01T10:00:00.000Z"}
];

const JSON_INDENT = 4;

/** The pages an export would hand over, pull-counted. */
const pagesOf = (...pages) => {
    const pulled = {count: 0};
    const iterator = (async function* () {
        for (const page of pages) {
            pulled.count += 1;
            yield page;
        }
    })();

    return {iterator, pulled};
};

/**
 * A response that records what was streamed at it.
 *
 * write invokes the completion callback the way a real ServerResponse does,
 * because that callback is part of the contract the writers may rely on for
 * backpressure - a fake that swallowed it would hang them.
 */
const capturingResponse = () => {
    const res = new EventEmitter();
    const written = [];

    res.destroyed = false;
    res.write = (chunk, callback) => { written.push(chunk); callback?.(); return true; };
    res.end = () => { res.writableEnded = true; };
    res.text = () => written.join("");

    return res;
};

describe("the streamed JSON export", () => {
    it("is byte-identical to the one-string document it replaced", async () => {
        const res = capturingResponse();
        await streamJsonArray(res, pagesOf(ROWS.slice(0, 2), ROWS.slice(2)).iterator);

        assert.equal(res.text(), JSON.stringify(ROWS, null, JSON_INDENT));
        assert.equal(res.writableEnded, true);
    });

    it("answers an empty history the way stringify does", async () => {
        const res = capturingResponse();
        await streamJsonArray(res, pagesOf().iterator);

        assert.equal(res.text(), JSON.stringify([], null, JSON_INDENT));
    });
});

describe("the streamed CSV export", () => {
    it("is byte-identical to toCsv of the whole history", async () => {
        const res = capturingResponse();
        await streamCsv(res, pagesOf(ROWS.slice(0, 1), ROWS.slice(1)).iterator);

        assert.equal(res.text(), toCsv(ROWS));
        assert.equal(res.writableEnded, true);
    });

    it("answers an empty history with the header alone", async () => {
        const res = capturingResponse();
        await streamCsv(res, pagesOf().iterator);

        assert.equal(res.text(), toCsv([]));
    });
});

/**
 * A caller that has gone must stop the walk, not merely the writing: the pages
 * behind the iterator are database reads, and 'drain' never fires on a
 * destroyed response - waiting for it would hold the request open forever.
 */
describe("a client that leaves mid-export", () => {
    it("stops pulling pages instead of reading the rest of the table", async () => {
        const {iterator, pulled} = pagesOf(ROWS.slice(0, 1), ROWS.slice(1, 2), ROWS.slice(2));
        const res = capturingResponse();

        res.write = (chunk, callback) => {
            res.destroyed = true;
            setImmediate(() => {
                res.emit("close");
                callback?.();
            });
            return false;
        };

        await streamJsonArray(res, iterator);

        assert.equal(pulled.count, 1, "the export kept reading for a caller that had left");
    });

    it("stops pulling pages instead of reading the rest of the table for CSV", async () => {
        const {iterator, pulled} = pagesOf(ROWS.slice(0, 1), ROWS.slice(1, 2), ROWS.slice(2));
        const res = capturingResponse();

        res.write = (chunk, callback) => {
            if (chunk !== CSV_HEADER) {
                res.destroyed = true;
            }
            setImmediate(() => {
                if (res.destroyed) res.emit("close");
                callback?.();
            });
            return false;
        };

        await streamCsv(res, iterator);

        assert.equal(pulled.count, 1, "the CSV export kept reading for a caller that had left");
    });
});

/**
 * A slow but present client: the buffer refuses every chunk and accepts it a
 * beat later. This is the path every large export over a real network takes,
 * and the one a bug in the wait would silently truncate.
 */
describe("a client that reads slowly", () => {
    it("waits out each refusal and still delivers the whole document", async () => {
        const res = capturingResponse();
        res.write = (chunk, callback) => {
            res.emit("written", chunk);
            setImmediate(() => {
                res.emit("drain");
                callback?.();
            });
            return false;
        };
        const written = [];
        res.on("written", (chunk) => written.push(chunk));
        res.text = () => written.join("");

        await streamJsonArray(res, pagesOf(ROWS.slice(0, 2), ROWS.slice(2)).iterator);

        assert.equal(res.text(), JSON.stringify(ROWS, null, JSON_INDENT),
            "backpressure truncated the export for a client that was merely slow");
        assert.equal(res.writableEnded, true);
    });

    it("waits out each refusal and still delivers the whole CSV document", async () => {
        const res = capturingResponse();
        res.write = (chunk, callback) => {
            res.emit("written", chunk);
            setImmediate(() => {
                res.emit("drain");
                callback?.();
            });
            return false;
        };
        const written = [];
        res.on("written", (chunk) => written.push(chunk));
        res.text = () => written.join("");

        await streamCsv(res, pagesOf(ROWS.slice(0, 2), ROWS.slice(2)).iterator);

        assert.equal(res.text(), toCsv(ROWS),
            "backpressure truncated the CSV export for a client that was merely slow");
        assert.equal(res.writableEnded, true);
    });
});

/**
 * A database that fails mid-walk - the realistic failure for a walk of the
 * largest table. The rejection has to reach the route (express hands it to
 * the error middleware, which abandons a response whose headers are sent),
 * and the truncated document must not be closed as though it were complete:
 * the missing closing bracket is how a client can tell.
 */
describe("a database that fails mid-walk", () => {
    it("surfaces the failure instead of ending the document", async () => {
        const res = capturingResponse();
        const failing = (async function* () {
            yield ROWS.slice(0, 1);
            throw new Error("database has gone away");
        })();

        await assert.rejects(() => streamJsonArray(res, failing), /gone away/);

        assert.notEqual(res.writableEnded, true,
            "the truncated document was closed as though it were complete");
        assert.match(res.text(), /^\[\n/, "nothing at all was flushed before the failure");
        assert.doesNotMatch(res.text(), /\n\]$/, "the document claims to be whole");
    });

    it("surfaces the failure instead of ending the CSV document", async () => {
        const res = capturingResponse();
        const failing = (async function* () {
            yield ROWS.slice(0, 1);
            throw new Error("database has gone away");
        })();

        await assert.rejects(() => streamCsv(res, failing), /gone away/);

        assert.notEqual(res.writableEnded, true,
            "the truncated CSV document was closed as though it were complete");
        assert.equal(res.text().startsWith(CSV_HEADER), true, "header was not flushed before the failure");
    });
});

/**
 * The pages themselves. The walk pages by (created, id) - listFilter's own
 * cursor, LIST_ORDER's own sort - because offsets drift under concurrent
 * writes and ids stop agreeing with time on any imported history.
 */
describe("listPages", () => {
    const PAGE = 2;

    const page = (rows) => {
        const calls = [];
        mock.method(model, "findAll", async (query) => {
            calls.push(query);
            return rows(calls.length);
        });
        return calls;
    };

    it("walks the cursor along the last row of each page", async (t) => {
        const calls = page((call) => call === 1
            ? [{id: 9, created: "2026-08-03T10:00:00.000Z", error: null}, {id: 7, created: "2026-08-02T10:00:00.000Z", error: null}]
            : [{id: 4, created: "2026-08-01T10:00:00.000Z", error: null}]);
        t.after(() => mock.restoreAll());

        const pages = [];
        for await (const rows of listPages(PAGE)) pages.push(rows.map((row) => row.id));

        assert.deepEqual(pages, [[9, 7], [4]]);
        assert.equal(calls[0].where, undefined, "the first page is not a page of anything");
        assert.deepEqual(calls[1].where[Op.or][0], {created: {[Op.lt]: "2026-08-02T10:00:00.000Z"}});
        assert.deepEqual(calls[1].where[Op.or][1], {created: "2026-08-02T10:00:00.000Z", id: {[Op.lt]: 7}});
    });

    it("sorts exactly the way the cursor pages", async (t) => {
        const calls = page(() => []);
        t.after(() => mock.restoreAll());

        for await (const rows of listPages(PAGE)) void rows;

        assert.deepEqual(calls[0].order, [["created", "DESC"], ["id", "DESC"]]);
        assert.equal(calls[0].limit, PAGE);
    });

    it("stops on a short page without asking again", async (t) => {
        const calls = page(() => [{id: 1, created: "2026-08-01T10:00:00.000Z", error: null}]);
        t.after(() => mock.restoreAll());

        for await (const rows of listPages(PAGE)) void rows;

        assert.equal(calls.length, 1, "a page that already said 'last' was followed by another query");
    });

    // The same shape listAll gave every download so far: a null error means a
    // successful test, and the column is dropped rather than exported as null.
    it("keeps the exported row shape", async (t) => {
        page((call) => call === 1
            ? [{id: 2, created: "2026-08-02T10:00:00.000Z", error: null, resultId: null},
                {id: 1, created: "2026-08-01T10:00:00.000Z", error: "boom", resultId: "abc"}]
            : []);
        t.after(() => mock.restoreAll());

        const [rows] = await (async () => {
            const collected = [];
            for await (const page of listPages(PAGE)) collected.push(page);
            return collected;
        })();

        assert.deepEqual(rows[0], {id: 2, created: "2026-08-02T10:00:00.000Z"});
        assert.deepEqual(rows[1], {id: 1, created: "2026-08-01T10:00:00.000Z", error: "boom", resultId: "abc"});
    });

    it("pages a size that keeps the buffer small and the round trips few", () => {
        assert.ok(EXPORT_PAGE_ROWS >= 100 && EXPORT_PAGE_ROWS <= 100000,
            "the page size has drifted somewhere unreasonable");
    });
});
