import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { bootServer, api, seedTests, setConfig } from "./helpers/boot.js";
import * as targets from "../../server/controller/targets.js";
import { CSV_COLUMNS } from "../../server/util/csv.js";
import targetModel from "../../server/models/Targets.js";

let server;
let controller;

const MS_PER_DAY = 86400000;
const daysAgo = (days) => new Date(Date.now() - days * MS_PER_DAY).toISOString();

/**
 * A target written straight to the table so a test can pin its id.
 *
 * Several cases below need that, and none of them can be written with
 * seedTargets: the sequence never reuses a value, so a target created after a
 * wipe lands above every id the file carries and the collision the case is
 * about never happens. A reinstall's welcome dialog does take the first id of a
 * fresh database, which is the id the file's own first target has; a second
 * instance numbers its targets from the same sequence as the first, so a
 * foreign backup arrives with every id already spoken for; and a line renamed
 * since the backup keeps the id it always had.
 */
const targetAt = async (id, name) => await targetModel.create({
    id, name, provider: "ookla", enabled: true, alerts: true,
    sortOrder: id, created: new Date().toISOString()
});

before(async () => {
    server = await bootServer();
    controller = await import("../../server/controller/speedtests.js");
});

after(async () => {
    await server?.close();
});

beforeEach(async () => {
    await setConfig(server.config, "retentionDays", "365");
    await targets.removeAll();
});

/** The stored targets, replaced by exactly these, in the order given. */
const seedTargets = async (...names) => {
    await targets.removeAll();

    const created = [];
    for (const name of names) created.push(await targets.create({name, provider: "ookla"}));

    return created;
};

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

    // The door caps retention at MAX_RETENTION_DAYS and importConfig runs every
    // value through the door, so only a hand-edited row reaches this - and
    // every other reader in the tree survives one. A value near 1e11 days made
    // `new Date` invalid and toISOString threw a RangeError out of the prune.
    // Refused rather than capped: capping would delete more than the row asks.
    it("leaves a hand-edited retention beyond the cap alone rather than throwing", async () => {
        await seedTests(server.tests, [{created: daysAgo(5000)}]);
        // Past the door, the way a hand edit is: setConfig validates.
        await server.config.updateValue("retentionDays", "100000000000");

        await controller.removeOld();
        assert.equal(await server.tests.count(), 1, "an absurd retention pruned or threw");
    });

    /**
     * And says so once. The prune runs every minute, and the row cannot
     * change without an operator editing it, so the refusal repeated 1440
     * times a day into the service log. Latched per process the way the
     * cookie-path warning is, and re-armed once the row is fixed so a second
     * hand edit is reported again.
     */
    it("says so once per process, not once per sweep", async () => {
        // Re-armed by a sweep under a sane value: the case above has already
        // said it once for this process.
        await server.config.updateValue("retentionDays", "30");
        await controller.removeOld();
        await server.config.updateValue("retentionDays", "100000000000");
        const warnings = [];
        const warn = console.warn;
        console.warn = (line) => warnings.push(line);

        try {
            await controller.removeOld();
            await controller.removeOld();
            await controller.removeOld();
        } finally {
            console.warn = warn;
        }

        assert.equal(warnings.filter((line) => /retentionDays/.test(line)).length, 1,
            "the same refusal is repeated on every sweep");
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

    /**
     * Regression: the backup CSV wrote an empty targetName cell on every row of
     * every export.
     *
     * CSV_COLUMNS has named the column since the dashboard export gained it,
     * but the backup route streams the rows as the model hands them over -
     * carrying targetId and no name - so the writer, which reads each row by
     * column name, found nothing there. targetId is not a CSV column either,
     * which left the backup as the one export saying nothing whatsoever about
     * which line a row measured.
     */
    it("names the target each row measured against", async () => {
        const [wan] = await seedTargets("WAN");
        await seedTests(server.tests, [{created: daysAgo(1), targetId: wan.id}, {created: daysAgo(2)}]);

        const {text} = await api(server.baseUrl, "/storage/tests/history/csv");
        const column = CSV_COLUMNS.indexOf("targetName");
        const [, measured, orphan] = text.split("\n");

        assert.equal(measured.split(",")[column], '"WAN"',
            "the backup CSV still writes an empty targetName cell");
        assert.equal(orphan.split(",")[column], '""', "a row with no target should name none");
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

    /**
     * The other half of the backup round trip: which target a restored row
     * belongs to.
     *
     * The ids in a file belong to the instance that wrote it. Written through,
     * as they were, a backup restored onto an instance with targets of its own
     * handed every row to whatever holds that number there - filtered under it,
     * graded against its optimal values, counted into its statistics and
     * exported under its name, with nothing in the interface or in these counts
     * saying so.
     *
     * What the import reads instead is the target name the export writes beside
     * each row, resolved against the targets this instance holds - and only
     * that, whatever else is true of the instance. The cases below therefore
     * come in pairs where it matters: the same file onto a table that already
     * holds rows and onto one that does not, with the same answer both times.
     */
    describe("which target a restored row belongs to", () => {
        const row = (extra) => ({ping: 10, download: 100, upload: 50, time: 30,
            type: "auto", created: daysAgo(1), ...extra});

        /**
         * A live instance: the given targets, and one older measurement of its
         * own, so a case is not silently testing an empty table.
         */
        const liveInstance = async (...names) => {
            const created = await seedTargets(...names);
            await seedTests(server.tests, [{created: daysAgo(30), targetId: created[0].id}]);

            return created;
        };

        /** The newest row - the imported one, the instance's own being older. */
        const restoredTargetId = async () =>
            (await server.tests.findAll({order: [["created", "DESC"]]}))[0].targetId;

        /** Every row oldest first, so the instance's own comes first. */
        const attributions = async () =>
            (await server.tests.findAll({order: [["created", "ASC"]]})).map((test) => test.targetId);

        it("resolves the exported name against the local targets", async () => {
            const [wan, lan] = await liveInstance("WAN", "LAN iperf3");

            await importTests([row({targetId: wan.id, targetName: "LAN iperf3"})]);

            assert.equal(await restoredTargetId(), lan.id,
                "the file's id outvoted the name it was exported with");
        });

        it("does not hand a row to whichever target holds the id in the file", async () => {
            const [wan] = await liveInstance("WAN");

            const {status} = await importTests([row({targetId: wan.id, targetName: "Frankfurt"})]);

            assert.equal(status, 200);
            assert.equal(await restoredTargetId(), null,
                "a row measured elsewhere was attributed to a local target that never ran it");
        });

        /**
         * The whole of a foreign file, which is the shape the finding
         * described: another operator's history, whose target names mean
         * nothing here. Every row lands, the counts say so, and not one of them
         * claims a local line.
         */
        it("orphans every row of a file whose names this instance does not know", async () => {
            const [wan] = await liveInstance("WAN");

            const {status, body} = await importTests([
                row({targetId: wan.id, targetName: "Ookla Frankfurt", created: daysAgo(2)}),
                row({targetId: wan.id + 1, targetName: "Ookla Berlin", created: daysAgo(1)})
            ]);

            assert.equal(status, 200);
            assert.deepEqual({imported: body.imported, skipped: body.skipped}, {imported: 2, skipped: 0},
                "an unattributable row is still a usable row");
            assert.deepEqual(await attributions(), [wan.id, null, null]);
        });

        /**
         * The reason the rule reads nothing but the name, at the route: the
         * same file onto the same targets, once with an empty history and once
         * with a scheduled round of its own already recorded. Every rule that
         * read the destination's state told those two apart - and a reinstall
         * crosses from one to the other at the next top of the hour, since
         * DEFAULTS.cron is "0 * * * *" rather than an interval.
         */
        it("attributes a file the same way whether or not this instance holds a history", async () => {
            const [wan] = await seedTargets("WAN");
            const file = [row({targetId: wan.id + 5, targetName: "WAN"})];

            await seedTests(server.tests, []);
            await importTests(file);
            const ontoAnEmptyTable = await attributions();

            await seedTests(server.tests, [{created: daysAgo(30), targetId: wan.id}]);
            await importTests(file);

            assert.deepEqual(ontoAnEmptyTable, [wan.id]);
            assert.deepEqual(await attributions(), [wan.id, wan.id],
                "one file was attributed two ways depending on what the table already held");
        });

        /**
         * A backup written by an instance older than the export's targetName
         * column has nothing to resolve, so its rows are imported unattributed
         * - deliberately, rather than falling back to ids that would each claim
         * a local target here.
         */
        it("orphans a file that states no target names at all", async () => {
            const [wan] = await liveInstance("WAN");

            const {body} = await importTests([row({targetId: wan.id, created: daysAgo(2)}),
                row({targetId: wan.id + 1, created: daysAgo(1)})]);

            assert.deepEqual({imported: body.imported, skipped: body.skipped}, {imported: 2, skipped: 0},
                "an unattributable row is still a usable row");
            assert.deepEqual(await attributions(), [wan.id, null, null]);
        });

        // targetId is not in NUMERIC_COLUMNS, so a hand-edited backup used to
        // park a string in an INTEGER column and sqlite kept it. Nothing from
        // that column is written back now, whatever it holds.
        it("cannot be handed a targetId that is not a target at all", async () => {
            const [wan] = await liveInstance("WAN");

            await importTests([row({targetId: "not-a-number", targetName: "WAN", created: daysAgo(2)}),
                row({targetId: "12", targetName: "Frankfurt", created: daysAgo(1)})]);

            assert.deepEqual(await attributions(), [wan.id, wan.id, null]);
        });

        /**
         * The disclosed cost, pinned so nobody rediscovers it as a bug: a name
         * given to a different target since the export takes the old line's
         * restored rows with it. Here the original "WAN" was deleted and a new
         * target called "WAN" created, so the file's rows join the namesake
         * while the rows already stored keep the old target's id.
         *
         * The file says "WAN" and nothing else in it can be trusted to say more
         * - its id is an id of the instance that wrote it, which may not be
         * this one - so this is the same answer the rule gives everywhere,
         * taken here rather than special-cased. What it refuses to do is answer
         * differently depending on what this instance happens to hold.
         */
        it("gives a reused name's rows to the target that wears it now", async () => {
            const [old] = await seedTargets("WAN");
            await seedTests(server.tests, [{created: daysAgo(30), targetId: old.id, download: 941}]);
            await targets.deleteTarget(old.id);
            const namesake = await targetAt(old.id + 1, "WAN");

            await importTests([row({targetId: old.id, targetName: "WAN", download: 940})]);

            assert.deepEqual(await attributions(), [old.id, namesake.id]);
            assert.notEqual(namesake.id, old.id, "the namesake has to be a different target");
        });
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

    /**
     * `created`'s own regex only proves the string looks like an ISO instant,
     * never that the date it names exists: `new Date` silently rolls
     * 2026-02-30 over into March, so the row was stored as written and then
     * drawn on March 2 by every reader that parses the column - and absent
     * from any range that asked for February.
     */
    it("skips a row whose date does not exist on the calendar", async () => {
        await seedTests(server.tests, []);
        const usable = daysAgo(1);

        const {status} = await importTests([row({created: usable}), row({created: "2026-02-30T12:00:00.000Z"})]);

        assert.equal(status, 200);
        assert.deepEqual((await server.tests.findAll()).map((test) => test.created), [usable]);
    });

    // Reachable only by a hand-edited backup, since every real export's
    // `created` came from toISOString() at write time - but nothing else
    // stopped a file from claiming a date nobody has lived yet, and it would
    // become getLatest()'s answer for good.
    it("skips a row whose instant is further ahead than clock skew explains", async () => {
        await seedTests(server.tests, []);
        const usable = daysAgo(1);

        const {status} = await importTests([row({created: usable}), row({created: "9999-12-31T23:59:59.999Z"})]);

        assert.equal(status, 200);
        assert.deepEqual((await server.tests.findAll()).map((test) => test.created), [usable]);
    });

    // The allowance exists for clock skew between the exporting and the
    // importing instance, not to refuse a backup taken minutes ago on a
    // machine whose clock runs a little ahead - a day of drift is ordinary
    // and the row is imported rather than skipped.
    it("imports a row that sits only a day ahead of now", async () => {
        await seedTests(server.tests, []);
        const oneDayAhead = daysAgo(-1);

        const {status} = await importTests([row({created: oneDayAhead})]);

        assert.equal(status, 200);
        assert.deepEqual((await server.tests.findAll()).map((test) => test.created), [oneDayAhead]);
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
// serverId used to be excluded as "an internal reference", but it is the id
// the Ookla CLI is pointed at with --server-id and the label the Prometheus
// exporter emits - and leaving it out meant an export/import round trip reset
// every row to the column's 0 default.
const NOT_EXPORTED = {
    // Exported as targetName instead: the raw id is meaningless outside this
    // instance, while the name says which line the row measured - and the name
    // is the only thing the import reads, so a restored history lands on the
    // line it measured or on no line at all, never on whoever holds that
    // number where it lands.
    targetId: "exported as targetName"
};

/**
 * The disaster restore: a disk dies, MySpeed is reinstalled, and the operator
 * puts back the two files the storage dialog hands out - the raw history and
 * the configuration.
 *
 * They are two independent imports with two independent buttons, in a dialog
 * that opens on the history, and nothing anywhere prescribes an order. Nor does
 * anything prescribe how many attempts it takes: the client aborts a request
 * after REQUEST_TIMEOUT while the import commits chunk by chunk, and
 * IMPORT_BODY_LIMIT caps one PUT at 50mb, so a large history reaches the server
 * in pieces or twice over.
 *
 * Every one of those orders is driven here, because the rule is that none of
 * them may change the answer: a row is attributed by the target name the export
 * wrote beside it, resolved against the targets this instance holds, and by
 * nothing else about the instance.
 */
describe("restoring a whole instance from its two backups", () => {
    const put = (pathname, body) => api(server.baseUrl, pathname, {
        method: "PUT",
        headers: {"content-type": "application/json"},
        body: JSON.stringify(body)
    });

    /**
     * The two files an operator downloads. The history is taken from the backup
     * route rather than from exportTests, because that is the file the dialog
     * downloads and the one the targetName column had to be added to.
     */
    const backupOf = async (...names) => {
        const [wan, lan] = await seedTargets(...names);
        await seedTests(server.tests, [
            {created: daysAgo(2), targetId: wan.id, download: 940},
            {created: daysAgo(1), targetId: lan.id, download: 112}
        ]);

        const {body: history} = await api(server.baseUrl, "/storage/tests/history/json");
        const {body: config} = await api(server.baseUrl, "/storage/config?includeSecrets=true");

        return {history, config, wan, lan};
    };

    /** The reinstall: nothing left but the software. */
    const wipe = async () => {
        await seedTests(server.tests, []);
        await targets.removeAll();
    };

    /** Which target each restored row is attributed to, slowest line first. */
    const attribution = async () => {
        const named = new Map((await targets.listAll()).map((target) => [target.id, target.name]));

        return (await server.tests.findAll({order: [["download", "ASC"]]}))
            .map((test) => named.get(test.targetId) ?? null);
    };

    /** The same rows as ids, for pinning that a restore lands on the originals. */
    const restoredIds = async () =>
        (await server.tests.findAll({order: [["download", "ASC"]]})).map((test) => test.targetId);

    /**
     * The ordinary restore: the instance is intact, its history was lost or
     * cleared, and the operator puts the history file back. The targets never
     * went anywhere, so every name resolves - and resolves to the id the row
     * was exported with, because the export wrote the name that id answers to.
     */
    it("puts a history back on the same instance under the same ids", async () => {
        const {history, wan, lan} = await backupOf("WAN", "LAN iperf3");
        await seedTests(server.tests, []);

        assert.equal((await put("/storage/tests/history", history)).status, 200);

        assert.deepEqual(await attribution(), ["LAN iperf3", "WAN"]);
        assert.deepEqual(await restoredIds(), [lan.id, wan.id],
            "a same-instance restore moved rows off the ids they were exported with");
    });

    /**
     * The rebuild in the order that works: the configuration first, which
     * restores the targets under their own ids - "so the history's targetId
     * column keeps pointing at the right rows" - and then the history, whose
     * names now all resolve.
     */
    it("keeps the attribution when the configuration goes back first", async () => {
        const {history, config, wan, lan} = await backupOf("WAN", "LAN iperf3");
        await wipe();

        assert.equal((await put("/storage/config", config)).status, 200);
        assert.equal((await put("/storage/tests/history", history)).status, 200);

        assert.deepEqual(await attribution(), ["LAN iperf3", "WAN"]);
        assert.deepEqual(await restoredIds(), [lan.id, wan.id]);
    });

    /**
     * The rebuild whose targets were made by hand rather than restored from the
     * configuration file - the same names, new ids, because the sequence never
     * reuses one - imported twice: once before this instance has measured
     * anything of its own, and once after.
     *
     * Both have to answer the same, and that is the whole reason nothing but
     * the name is read. The scheduled round is a cron expression, not an
     * interval: DEFAULTS.cron in config.js is "0 * * * *", so a reinstall at
     * :55 records a round of its own five minutes later, whether or not the
     * operator has reached the storage dialog. A rule that kept the file's own
     * ids while the history table was empty and resolved names once it was not
     * therefore gave the same restore two different answers depending on which
     * side of the hour the operator was on, behind two 200s and a green toast.
     */
    it("keeps the attribution whether or not a scheduled round has already run", async () => {
        const {history} = await backupOf("WAN", "LAN iperf3");

        const restoreOnto = async (ownRounds) => {
            await wipe();
            const [wan] = await seedTargets("WAN", "LAN iperf3");
            await seedTests(server.tests, ownRounds ? [{created: daysAgo(0), targetId: wan.id, download: 1}] : []);

            assert.equal((await put("/storage/tests/history", history)).status, 200);

            return await attribution();
        };

        assert.deepEqual(await restoreOnto(false), ["LAN iperf3", "WAN"]);
        assert.deepEqual(await restoreOnto(true), ["WAN", "LAN iperf3", "WAN"],
            "a round the reinstall recorded of its own changed how the backup was read");
    });

    /**
     * The retry, which the client makes routine: RequestUtil aborts after
     * REQUEST_TIMEOUT while PUT /storage/tests/history does not answer until the
     * whole file is written, and importTests commits chunk by chunk on purpose
     * - so a large restore reports an error with part of the file already
     * stored, and the operator's next move is to import the same file again.
     *
     * Regression this pins: under a rule that read the destination's state, the
     * first attempt's own rows made the table non-empty, so the retry was
     * judged by a different rule than the attempt it was repeating and
     * attributed what it carried differently. The targets here were recreated
     * by hand rather than restored from the configuration file - the same
     * names, new ids, since the sequence never reuses one - which is what makes
     * the two rules visibly disagree.
     */
    it("attributes a retried import exactly as the first attempt did", async () => {
        const {history} = await backupOf("WAN", "LAN iperf3");
        await wipe();
        await seedTargets("WAN", "LAN iperf3");
        await seedTests(server.tests, []);

        // The attempt the client aborted, one row into the file.
        assert.equal((await put("/storage/tests/history", history.slice(0, 1))).status, 200);
        const afterTheAbortedAttempt = await attribution();

        // The same file again, whole. The overlap duplicates rows, which is the
        // operator's problem; what may not happen is that they arrive orphaned.
        assert.equal((await put("/storage/tests/history", history)).status, 200);

        assert.deepEqual(afterTheAbortedAttempt, ["LAN iperf3"]);
        assert.deepEqual(await attribution(), ["LAN iperf3", "LAN iperf3", "WAN"],
            "a retried import was attributed differently from the attempt it repeated");
    });

    /**
     * The same shape without the error: IMPORT_BODY_LIMIT caps a PUT at 50mb,
     * so a history above that has to be sent in pieces - and the pieces have to
     * agree with each other.
     */
    it("attributes a split restore the same as one sent whole", async () => {
        const {history} = await backupOf("WAN", "LAN iperf3");
        await wipe();
        await seedTargets("WAN", "LAN iperf3");
        await seedTests(server.tests, []);

        assert.equal((await put("/storage/tests/history", history.slice(0, 1))).status, 200);
        assert.equal((await put("/storage/tests/history", history.slice(1))).status, 200);

        assert.deepEqual(await attribution(), ["LAN iperf3", "WAN"],
            "the second half of a split restore was attributed differently from the first");
    });

    /**
     * The order the dialog invites, and the price of this rule stated as a
     * test: the dialog opens on the history, so the history is routinely
     * restored before the configuration that names its targets - and at that
     * moment no name in the file resolves to anything, because the targets are
     * not back yet.
     *
     * Those rows land unattributed rather than under whichever target the
     * reinstall's welcome dialog created, and the configuration restore that
     * follows cannot repair them. It is visible - they show with no target
     * rather than under a wrong one - the file still holds the truth, and
     * importing it again once the targets are back puts every row where it
     * belongs, which is what the second half of this case does.
     */
    it("leaves the rows unattributed when the history goes back before the configuration", async () => {
        const {history, config, wan, lan} = await backupOf("WAN", "LAN iperf3");
        await wipe();
        await targetAt(wan.id, "Home");

        assert.equal((await put("/storage/tests/history", history)).status, 200);
        assert.equal((await put("/storage/config", config)).status, 200);

        assert.deepEqual(await attribution(), [null, null],
            "rows restored before the targets were attributed to something anyway");

        // The repair, without touching the database: clear the history and
        // import the same file now that the configuration is back.
        await seedTests(server.tests, []);
        assert.equal((await put("/storage/tests/history", history)).status, 200);

        assert.deepEqual(await attribution(), ["LAN iperf3", "WAN"]);
        assert.deepEqual(await restoredIds(), [lan.id, wan.id]);
    });

    /**
     * The reinstall an operator actually meets, and the reason the case above
     * is worth stating: the welcome dialog is mounted `disableClose` and is the
     * only dialog with no way back, so a fresh instance has a target before its
     * storage dialog can be opened at all - taking the first id of an empty
     * database, which is the id the file's own first target has.
     *
     * With the configuration restored first that target is gone, replaced by
     * the file's own under the file's own ids, and the id collision it used to
     * cause cannot arise: the import never reads an id from the file.
     */
    it("is unharmed by the target the welcome dialog could not be stopped from making", async () => {
        const {history, config, wan, lan} = await backupOf("WAN", "LAN iperf3");
        await wipe();
        await targetAt(wan.id, "Home");

        assert.equal((await put("/storage/config", config)).status, 200);
        assert.equal((await put("/storage/tests/history", history)).status, 200);

        assert.deepEqual(await attribution(), ["LAN iperf3", "WAN"]);
        assert.deepEqual(await restoredIds(), [lan.id, wan.id],
            "a placeholder target the operator could not decline moved the restored rows");
    });

    /**
     * The disclosed cost at the route, in its sharpest form: the fibre line was
     * replaced, so the old target was renamed "WAN (old ISP)" and the freed
     * name "WAN" given to the line that took over. A backup taken before any of
     * that is then restored.
     *
     * The name is all the file states, so the old fibre rows follow the name to
     * the line that wears it now, and the rows of the line that was called
     * "Backup LTE" resolve to nothing. A rename without the reuse simply
     * orphans; the reuse moves rows.
     *
     * It is the price of a rule that cannot be flipped by a cron tick or a
     * retry - and it is bounded by something an operator can see and undo:
     * renaming the targets back to what the backup calls them, and importing
     * the file again, attributes every row.
     */
    it("follows a name that moved between targets since the backup", async () => {
        const {history, wan, lan} = await backupOf("WAN", "Backup LTE");
        await wipe();
        const renamed = await targetAt(wan.id, "WAN (old ISP)");
        const tookTheName = await targetAt(lan.id, "WAN");

        assert.equal((await put("/storage/tests/history", history)).status, 200);

        assert.deepEqual(await attribution(), [null, "WAN"]);
        assert.deepEqual(await restoredIds(), [null, tookTheName.id],
            "a name that moved did not take the rows exported under it");
        assert.notEqual(renamed.id, tookTheName.id, "the two lines have to be different targets");
    });
});

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

    /**
     * The whole point of the two halves together, which no single-endpoint case
     * states: a history leaves one instance and lands on another that already
     * measures lines of its own, whose targets carry the same names under
     * different ids.
     *
     * Both instances number their targets from the same sequence - a second
     * MySpeed install starts at the same place - so every id in the file is a
     * live local target here, wearing the other line's name. Under the old
     * import each row kept its file's id and came back attributed to the wrong
     * line, and nothing about the restore reported it.
     */
    it("puts each merged row back on the target whose name it measured", async () => {
        const [wan, lan] = await seedTargets("WAN", "LAN iperf3");
        await seedTests(server.tests, [
            {created: daysAgo(2), targetId: wan.id, download: 940},
            {created: daysAgo(1), targetId: lan.id, download: 112}
        ]);

        const {body: exported} = await api(server.baseUrl, "/storage/tests/history/json");

        // The destination: the same two names, swapped onto each other's ids,
        // and a measurement of its own, so the file is not the only thing in
        // the table.
        await targets.removeAll();
        const movedLan = await targetAt(wan.id, "LAN iperf3");
        const movedWan = await targetAt(lan.id, "WAN");
        await seedTests(server.tests, [{created: daysAgo(30), targetId: movedWan.id, download: 1}]);

        const {status} = await api(server.baseUrl, "/storage/tests/history", {
            method: "PUT",
            headers: {"content-type": "application/json"},
            body: JSON.stringify(exported)
        });

        assert.equal(status, 200);
        const restored = await server.tests.findAll({order: [["download", "ASC"]]});
        assert.deepEqual(restored.map((test) => test.targetId),
            [movedWan.id, movedLan.id, movedWan.id],
            "a merged history was attributed by the ids of the instance that wrote it");
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
