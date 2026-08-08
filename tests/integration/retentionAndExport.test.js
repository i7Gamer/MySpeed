import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { bootServer, api, seedTests, setConfig } from "./helpers/boot.js";
import { CSV_COLUMNS } from "../../server/util/csv.js";

let server;
let controller;

const MS_PER_DAY = 86400000;
const daysAgo = (days) => new Date(Date.now() - days * MS_PER_DAY).toISOString();

before(async () => {
    server = await bootServer();
    controller = await import("../../server/controller/speedtests.js");
});

after(async () => {
    await server?.close();
});

beforeEach(async () => {
    await setConfig(server.config, "retentionDays", "365");
});

describe("retention sweep", () => {
    /**
     * Regression: the sqlite branch compared the stored ISO-8601 string against
     * datetime('now', '-N days'), which returns "YYYY-MM-DD HH:MM:SS". The
     * stored value has a 'T' where that has a space, and 'T' sorts above ' ',
     * so everything from the cutoff day compared as newer and survived forever.
     */
    it("deletes tests older than the retention window", async () => {
        await seedTests(server.tests, [{created: daysAgo(40)}, {created: daysAgo(2)}]);
        await setConfig(server.config, "retentionDays", "30");

        await controller.removeOld();

        const remaining = await server.tests.findAll();
        assert.equal(remaining.length, 1);
        assert.ok(remaining[0].created > daysAgo(30));
    });

    it("deletes a test from exactly the cutoff day", async () => {
        await seedTests(server.tests, [{created: daysAgo(30.5)}]);
        await setConfig(server.config, "retentionDays", "30");

        await controller.removeOld();
        assert.equal(await server.tests.count(), 0);
    });

    it("keeps everything inside the window", async () => {
        await seedTests(server.tests, [{created: daysAgo(1)}, {created: daysAgo(29)}]);
        await setConfig(server.config, "retentionDays", "30");

        await controller.removeOld();
        assert.equal(await server.tests.count(), 2);
    });

    it("keeps everything when retention is unlimited", async () => {
        await seedTests(server.tests, [{created: daysAgo(5000)}]);
        await setConfig(server.config, "retentionDays", "0");

        await controller.removeOld();
        assert.equal(await server.tests.count(), 1);
    });
});

describe("GET /api/storage/tests/history/csv", () => {
    /**
     * Regression: the column list was taken from the first row, and listAll
     * deletes a null `error`. A newest test that had succeeded therefore
     * dropped the error column from every row in the export.
     */
    it("keeps the error column even when the newest test succeeded", async () => {
        await seedTests(server.tests, [
            {created: daysAgo(2), error: "Too many requests"},
            {created: daysAgo(1), error: null}
        ]);

        const {text} = await api(server.baseUrl, "/storage/tests/history/csv");
        assert.match(text.split("\n")[0], /error/);
        assert.match(text, /Too many requests/);
    });

    // Regression: fields were escaped with JSON.stringify, which backslash-
    // escapes a quote. RFC 4180 doubles it, and nothing else reads backslashes.
    it("escapes quotes by doubling them, not with backslashes", async () => {
        await seedTests(server.tests, [{created: daysAgo(1), error: 'the "fast" server, offline'}]);

        const {text} = await api(server.baseUrl, "/storage/tests/history/csv");
        assert.match(text, /""fast""/);
        assert.doesNotMatch(text, /\\"/);
    });

    it("serves a csv content type", async () => {
        await seedTests(server.tests, [{created: daysAgo(1)}]);

        const {headers} = await api(server.baseUrl, "/storage/tests/history/csv");
        assert.match(headers.get("content-type"), /text\/csv/);
    });

    it("still emits the header row when there are no tests", async () => {
        await seedTests(server.tests, []);

        const {text} = await api(server.baseUrl, "/storage/tests/history/csv");

        // Asserted against the exported column list rather than a copy of it:
        // the point here is that a header is emitted at all for an empty export,
        // and a second hand-written copy of the columns only breaks twice.
        assert.equal(text.split("\n")[0], CSV_COLUMNS.join(","));
    });
});

describe("PUT /api/storage/tests/history", () => {
    const importTests = (body) => api(server.baseUrl, "/storage/tests/history", {
        method: "PUT",
        headers: {"content-type": "application/json"},
        body: JSON.stringify(body)
    });

    it("imports usable rows", async () => {
        await seedTests(server.tests, []);

        const {status} = await importTests([
            {ping: 10, download: 100, upload: 50, time: 30, type: "auto", created: daysAgo(1)}
        ]);

        assert.equal(status, 200);
        assert.equal(await server.tests.count(), 1);
    });

    // Regression: importTests returned true for any array, so a file whose rows
    // were all unusable reported "Tests imported" over an empty table.
    it("reports failure when every row was unusable", async () => {
        await seedTests(server.tests, []);

        const {status} = await importTests([
            {ping: 10, type: "nonsense", created: daysAgo(1)},
            {ping: 10, type: "auto", created: "not-a-date"}
        ]);

        assert.equal(status, 500);
        assert.equal(await server.tests.count(), 0);
    });

    it("rejects a payload that is not a list", async () => {
        assert.equal((await importTests({rows: []})).status, 500);
    });

    it("accepts an empty list as a no-op", async () => {
        assert.equal((await importTests([])).status, 200);
    });
});

describe("import validation", () => {
    const importTests = (body) => api(server.baseUrl, "/storage/tests/history", {
        method: "PUT",
        headers: {"content-type": "application/json"},
        body: JSON.stringify(body)
    });

    const row = (overrides) => ({
        ping: 10, download: 100, upload: 50, time: 30, type: "auto", created: daysAgo(1), ...overrides
    });

    /**
     * Regression: only `type` and `created` were checked. sqlite stores
     * whatever it is handed, so a string in a numeric column survived the write
     * and then poisoned every average and chart built on top of it.
     */
    it("rejects a row whose numbers are strings", async () => {
        await seedTests(server.tests, []);

        assert.equal((await importTests([row({download: "fast"})])).status, 500);
        assert.equal(await server.tests.count(), 0);
    });

    it("rejects a row with a non-finite number", async () => {
        await seedTests(server.tests, []);

        assert.equal((await importTests([row({ping: null, upload: "50"})])).status, 500);
        assert.equal(await server.tests.count(), 0);
    });

    it("keeps the good rows and drops only the bad ones", async () => {
        await seedTests(server.tests, []);

        const {status} = await importTests([row(), row({time: "thirty"}), row({created: daysAgo(2)})]);

        assert.equal(status, 200);
        assert.equal(await server.tests.count(), 2);
    });

    // A failed test stores -1 placeholders and providers without jitter store
    // null, so neither may be treated as invalid.
    it("still accepts failed rows and absent jitter", async () => {
        await seedTests(server.tests, []);

        const {status} = await importTests([
            row({ping: -1, download: -1, upload: -1, time: null, error: "Too many requests"}),
            row({jitter: null})
        ]);

        assert.equal(status, 200);
        assert.equal(await server.tests.count(), 2);
    });
});
