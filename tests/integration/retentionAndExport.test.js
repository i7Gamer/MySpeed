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

    // This file restores a history once per assertion, which no caller does, and
    // /api/storage/tests/history carries a limit of its own - see app.js and the
    // list in expensiveRoutes.test.js. What is under test here is the import's
    // validation, not the limiter.
    server.resetRateLimits();
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

    /**
     * Every measurement column, not only the six that were listed.
     *
     * The guard's own comment says why it exists: sqlite stores whatever it is
     * handed, so an imported "fast" survives the write and poisons the averages
     * and charts built on it. Four columns measuring exactly the same kind of
     * thing were left out of the list - jitter, and the three quality figures -
     * and each of them reaches the statistics by the same route. A string in
     * jitter is not filtered out by the null check the jitter series applies, so
     * it is summed, and the average for the whole range comes back NaN.
     */
    for (const column of ["jitter", "packetLoss", "downloadLatency", "uploadLatency"]) {
        it(`skips a row whose ${column} is not a number`, async () => {
            await seedTests(server.tests, []);

            const {status} = await importTests([
                {ping: 10, download: 100, upload: 50, time: 30, type: "auto",
                    created: daysAgo(1), [column]: "fast"}
            ]);

            assert.equal(status, 500, `a row with a text ${column} was imported`);
            assert.equal(await server.tests.count(), 0);
        });

        // Absent and null stay ordinary: only Ookla measures the quality
        // figures at all, and jitter is nullable for the same reason.
        it(`still imports a row whose ${column} is absent or null`, async () => {
            await seedTests(server.tests, []);

            const {status} = await importTests([
                {ping: 10, download: 100, upload: 50, time: 30, type: "auto",
                    created: daysAgo(1), [column]: null}
            ]);

            assert.equal(status, 200);
            assert.equal(await server.tests.count(), 1);
        });
    }

    // The statistics are what the guard is protecting, so the damage is asserted
    // where it would land rather than only at the door.
    it("keeps a text jitter out of the averages", async () => {
        await seedTests(server.tests, []);

        await importTests([
            {ping: 10, download: 100, upload: 50, time: 30, jitter: 2, type: "auto", created: daysAgo(1)},
            {ping: 10, download: 100, upload: 50, time: 30, jitter: "fast", type: "auto", created: daysAgo(1)}
        ]);

        const {body} = await api(server.baseUrl,
            `/speedtests/statistics?from=${daysAgo(2).slice(0, 10)}&to=${daysAgo(0).slice(0, 10)}&tzOffset=0`);

        assert.equal(Number.isFinite(body.jitter.avg), true,
            `the jitter average came back as ${body.jitter.avg}`);
    });

    it("accepts an empty list as a no-op", async () => {
        assert.equal((await importTests([])).status, 200);
    });

    /**
     * A hole in the file used to cost the whole file.
     *
     * The two `delete entry.x` lines run before the per-row try/catch, so a
     * null entry threw a TypeError out of the transaction callback rather than
     * being skipped - and the transaction that wraps the entire import then
     * rolled back every good row that had already been written. A backup with
     * one bad element restored nothing and said only "Tests could not be
     * imported", which reads as a rejected file rather than a skipped row.
     */
    describe("a file with a hole in it", () => {
        it("skips a null row and keeps the rest", async () => {
            await seedTests(server.tests, []);

            const {status} = await importTests([
                {ping: 10, download: 100, upload: 50, time: 30, type: "auto", created: daysAgo(1)},
                null,
                {ping: 20, download: 200, upload: 60, time: 30, type: "auto", created: daysAgo(2)}
            ]);

            assert.equal(status, 200);
            assert.equal(await server.tests.count(), 2,
                "one null element rolled back the rows that were perfectly good");
        });

        it("skips a primitive where a row was expected", async () => {
            await seedTests(server.tests, []);

            const {status} = await importTests([
                42,
                "not a row",
                {ping: 10, download: 100, upload: 50, time: 30, type: "auto", created: daysAgo(1)}
            ]);

            assert.equal(status, 200);
            assert.equal(await server.tests.count(), 1);
        });

        it("still reports failure when the holes were all there was", async () => {
            await seedTests(server.tests, []);

            const {status} = await importTests([null, null]);

            assert.equal(status, 500);
            assert.equal(await server.tests.count(), 0);
        });
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
     * A row the validation passes can still be refused by the database, and the
     * rest of the file has to survive it rather than being rolled back with it.
     */
    it("keeps the rows around one the database itself refuses", async () => {
        await seedTests(server.tests, []);

        const {status} = await importTests([
            row(), row({created: "not a date"}), row({created: daysAgo(3)})
        ]);

        assert.equal(status, 200);
        assert.equal(await server.tests.count(), 2);
    });

    /**
     * A backup's ids are the ids of the instance that wrote it, and mean
     * nothing on the one reading it.
     *
     * They were written through as-is, so restoring onto a history that was not
     * empty raised a UNIQUE violation for every id already taken - each one
     * caught, counted into a console-only tally, and reported as a success. The
     * realistic shape is the worst one: a disk dies, MySpeed is reinstalled and
     * runs for a week before anyone gets to the backup, and the restore then
     * silently discards exactly the week's worth of ids that overlap.
     *
     * Left to the database to assign, nothing collides and the whole file lands.
     */
    it("restores every row onto a history that already holds those ids", async () => {
        await seedTests(server.tests, [row({created: daysAgo(1)}), row({created: daysAgo(2)})]);

        // The ids actually taken, not 1 and 2. sqlite's AUTOINCREMENT sequence
        // never reuses a value, so by this point in the file the seeded rows are
        // numbered well above where a hand-written id would collide - and a test
        // that guessed would pass without the two ever meeting.
        const taken = (await server.tests.findAll()).map((test) => test.id);
        assert.equal(taken.length, 2);

        const {status} = await importTests([
            row({id: taken[0], created: daysAgo(10)}),
            row({id: taken[1], created: daysAgo(11)})
        ]);

        assert.equal(status, 200);
        assert.equal(await server.tests.count(), 4,
            "part of the backup was discarded and the restore still reported success");
    });

    // What could not be used has to be visible somewhere the operator looks. A
    // bare "Tests imported" over a file that was half refused is the same
    // silence by a shorter route.
    it("says how much of the file it could not use", async () => {
        await seedTests(server.tests, []);

        const {body} = await importTests([row(), row({time: "thirty"}), row({created: daysAgo(4)})]);

        assert.equal(body.imported, 2);
        assert.equal(body.skipped, 1);
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
