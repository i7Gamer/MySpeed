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

    // The byte counts are numeric columns too, and the same store-anything
    // behaviour applies to them: a string there is not a quantity of data, and
    // the row would carry it looking like one that had been counted.
    it("rejects a row whose byte counts are strings", async () => {
        await seedTests(server.tests, []);

        assert.equal((await importTests([row({bytesDownloaded: "fast"})])).status, 500);
        assert.equal((await importTests([row({bytesUploaded: "lots"})])).status, 500);
        assert.equal(await server.tests.count(), 0);
    });

    // Absent is still legitimate: every row exported before the columns existed
    // has none, and a restore must not drop the whole history over it.
    it("accepts a row that states no byte counts at all", async () => {
        await seedTests(server.tests, []);

        assert.equal((await importTests([row()])).status, 200);
        assert.equal(await server.tests.count(), 1);
    });

    /**
     * Regression: the millisecond separator in the `created` check was an
     * unescaped dot, so any single character stood where the dot belongs and
     * `12:00:00X123Z` passed a test written to demand an ISO-8601 instant. Every
     * read of the column compares it lexicographically as an ISO-8601 string -
     * the retention sweep, findInRange, the list cursor - and such a row sorts
     * outside every window they can ask for, so nothing sees it again.
     *
     * The route cannot show this: one usable row in the file is already
     * "Tests imported", so the skipped row is only visible in the table.
     */
    it("skips a row whose millisecond separator is not a dot", async () => {
        await seedTests(server.tests, []);
        const usable = daysAgo(1);

        const {status} = await importTests([row({created: usable}), row({created: "2026-08-07T12:00:00X123Z"})]);

        assert.equal(status, 200);
        assert.deepEqual((await server.tests.findAll()).map((test) => test.created), [usable]);
    });

    // The other half of that check: escaping the dot must not have narrowed what
    // an export actually contains, which is exactly this - an instant with
    // milliseconds, the only shape toISOString() produces.
    it("imports a row whose created is a well-formed instant", async () => {
        await seedTests(server.tests, []);

        const {status} = await importTests([row({created: "2026-08-07T12:00:00.123Z"})]);

        assert.equal(status, 200);
        assert.deepEqual((await server.tests.findAll()).map((test) => test.created), ["2026-08-07T12:00:00.123Z"]);
    });

    // Milliseconds have always been required, and the escaped dot left that
    // alone: a second-precision stamp is still refused rather than newly let in.
    it("still skips a row that states no milliseconds at all", async () => {
        await seedTests(server.tests, []);
        const usable = daysAgo(1);

        const {status} = await importTests([row({created: usable}), row({created: "2026-08-07T12:00:00Z"})]);

        assert.equal(status, 200);
        assert.deepEqual((await server.tests.findAll()).map((test) => test.created), [usable]);
    });

    it("keeps the good rows and drops only the bad ones", async () => {
        await seedTests(server.tests, []);

        const {status} = await importTests([row(), row({time: "thirty"}), row({created: daysAgo(2)})]);

        assert.equal(status, 200);
        assert.equal(await server.tests.count(), 2);
    });

    /**
     * The rows are written inside one transaction - sqlite otherwise commits,
     * and fsyncs, once per row, which is most of what restoring a backup costs.
     * A row the validation passes can still be refused by the database: a
     * hand-edited history with a duplicate id is the realistic way in. The
     * rest of the file has to survive it rather than being rolled back with it.
     */
    it("keeps the rows around one the database itself refuses", async () => {
        await seedTests(server.tests, []);

        const {status} = await importTests([
            row({id: 1}), row({id: 1, created: daysAgo(2)}), row({id: 2, created: daysAgo(3)})
        ]);

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

/**
 * The exporter names the fields it copies out of each row one by one, so a
 * column added to the table is exported as an empty cell until it is named
 * there too. Asserting on the header cannot see this - the column is present
 * and every value under it is blank - which is how serverName and serverHost
 * went unexported from migration 0003 onwards, and how isp and externalIp
 * shipped empty in 1.1.3.
 *
 * So every attribute the model defines has to be either exported or listed
 * here as a deliberate omission. Adding a column then forces the choice
 * instead of silently skipping it.
 */
// Every attribute is exported today. serverId used to be excluded as "an
// internal reference", but it is the id the Ookla CLI is pointed at with
// --server-id and the label the Prometheus exporter emits - and leaving it out
// meant an export/import round trip reset every row to the column's 0 default.
const NOT_EXPORTED = {};

describe("what the exporter carries", () => {
    const exportedFields = async () => {
        await seedTests(server.tests, [{created: new Date().toISOString()}]);
        const [row] = await controller.exportTests({from: new Date(0), to: new Date()});

        return Object.keys(row);
    };

    it("names every column the model defines, or excludes it on purpose", async () => {
        const exported = await exportedFields();
        const missing = Object.keys(server.tests.getAttributes())
            .filter((attribute) => !exported.includes(attribute))
            .filter((attribute) => !(attribute in NOT_EXPORTED));

        assert.deepEqual(missing, [],
            `exportTests() does not name ${missing.join(", ")}, so ${missing.length === 1 ? "it exports" : "they export"} ` +
            `as empty cells. Add ${missing.length === 1 ? "it" : "them"} to exportTests() and to CSV_COLUMNS, or record ` +
            `in NOT_EXPORTED why ${missing.length === 1 ? "it is" : "they are"} deliberately left out.`);
    });

    // The CSV writer takes its columns from its own list, so the two can drift
    // apart in the other direction: a field the exporter produces that the
    // header never names is silently dropped from every CSV.
    it("writes every exported field into the CSV", async () => {
        const exported = await exportedFields();

        assert.deepEqual(exported.filter((field) => !CSV_COLUMNS.includes(field)), [],
            "a field leaves exportTests() that CSV_COLUMNS does not name, so the CSV drops it");
    });

    it("names no CSV column the exporter never produces", async () => {
        const exported = await exportedFields();

        assert.deepEqual(CSV_COLUMNS.filter((column) => !exported.includes(column)), [],
            "CSV_COLUMNS names a column exportTests() does not produce, so it is written empty for every row");
    });

    // Regression: serverId was not exported, so a restore reset every row to
    // the column's 0 default - which server was measured did not survive.
    it("carries the serverId through an export/import round trip", async () => {
        await seedTests(server.tests, [{created: new Date().toISOString(), serverId: 49631}]);
        const exported = await controller.exportTests({from: new Date(0), to: new Date()});

        await seedTests(server.tests, []);
        const {status} = await api(server.baseUrl, "/storage/tests/history", {
            method: "PUT",
            headers: {"content-type": "application/json"},
            body: JSON.stringify(exported)
        });

        assert.equal(status, 200);
        const [restored] = await server.tests.findAll();
        assert.equal(restored.serverId, 49631);
    });

    // The guard is worthless if it cannot see the thing it exists to catch, so
    // it is checked against an exporter that forgot a column.
    it("still catches a column the exporter forgot", async () => {
        const forgetful = ["id", "ping"];
        const attributes = ["id", "ping", "externalIp"];

        assert.deepEqual(
            attributes.filter((a) => !forgetful.includes(a)).filter((a) => !(a in NOT_EXPORTED)),
            ["externalIp"]
        );
    });
});
