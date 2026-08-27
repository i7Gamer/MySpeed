import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DataTypes, Sequelize } from "sequelize";
import { bootServer } from "./helpers/boot.js";
import sqlite3Shim from "../../server/util/bun-sqlite-shim.js";
import migrations from "../../server/migrations/index.js";
import { seedTarget, up as addTargets } from "../../server/migrations/0013-add-targets.js";

let server;
let queryInterface;

before(async () => {
    server = await bootServer();
    queryInterface = server.db.getQueryInterface();
});

after(async () => {
    await server?.close();
});

describe("migrations", () => {
    it("records every migration it ran", async () => {
        const [rows] = await server.db.query("SELECT name FROM SequelizeMeta ORDER BY name ASC");
        const names = rows.map((row) => row.name);

        assert.ok(names.includes("0001-initial-setup.js"));
        assert.ok(names.includes("0004-index-speedtests-created.js"));
        assert.ok(names.includes("0005-add-quality-columns.js"));
        assert.ok(names.includes("0006-add-connection-identity-columns.js"));
        assert.ok(names.includes("0007-widen-speedtest-error.js"));
        assert.ok(names.includes("0008-add-provider-column.js"));
        assert.ok(names.includes("0009-add-transfer-columns.js"));
        assert.ok(names.includes("0010-widen-speedtest-ping.js"));
        assert.ok(names.includes("0011-add-server-location-column.js"));
    });

    /**
     * The latency keeps its decimals.
     *
     * The column was declared INTEGER, so the parsers rounded to whole
     * milliseconds on the way in - and the rounding is not recoverable, since
     * the API, the CSV export, the Prometheus exporter and every integration all
     * read what was stored. On a fibre or local line most of the measurement
     * lives below the millisecond, which is what upstream #1387 and #999 ask
     * for back.
     *
     * The declared type is what this asserts, because it is what actually
     * differs by dialect and the suite only ever runs sqlite: sqlite's INTEGER
     * affinity is numeric, so it quietly keeps a REAL and the round trip below
     * passes either way, while MySQL's INT rounds the value away on write. The
     * declaration is also what sequelize validates a value against before it
     * reaches any database at all.
     */
    it("declares a latency column that can hold a fraction", () => {
        assert.doesNotMatch(server.tests.getAttributes().ping.type.key, /^INTEGER$/i,
            "ping is declared INTEGER, which rounds the measurement away on MySQL");
    });

    it("stores a latency with its decimals", async () => {
        const stored = await server.tests.create({
            ping: 12.64, download: 100, upload: 50, time: 10, serverId: 0, type: "auto",
            created: new Date().toISOString()
        });

        const read = await server.tests.findOne({where: {id: stored.id}});
        assert.equal(read.ping, 12.64);

        await server.tests.destroy({where: {id: stored.id}});
    });

    it("stores a sub-millisecond latency as more than zero", async () => {
        const stored = await server.tests.create({
            ping: 0.42, download: 100, upload: 50, time: 10, serverId: 0, type: "auto",
            created: new Date().toISOString()
        });

        const read = await server.tests.findOne({where: {id: stored.id}});
        assert.equal(read.ping, 0.42);

        await server.tests.destroy({where: {id: stored.id}});
    });

    // The placeholder a failed row carries in every numeric column, which the
    // client tells a failure apart by. A widened column must still hold it
    // exactly - -1.0 and -1 compare equal, but the client compares strictly.
    it("still stores the failure placeholder exactly", async () => {
        const stored = await server.tests.create({
            ping: -1, download: -1, upload: -1, time: null, serverId: 0, type: "auto",
            error: "no route to host", created: new Date().toISOString()
        });

        const read = await server.tests.findOne({where: {id: stored.id}});
        assert.equal(read.ping, -1);

        await server.tests.destroy({where: {id: stored.id}});
    });

    it("creates the columns the model expects", async () => {
        const columns = await queryInterface.describeTable("speedtests");

        for (const column of ["ping", "jitter", "download", "upload", "time", "type", "created", "error",
            "serverId", "serverName", "serverHost", "serverLocation", "resultId",
            "packetLoss", "downloadLatency", "uploadLatency", "isp", "externalIp",
            "provider", "bytesDownloaded", "bytesUploaded"])
            assert.ok(columns[column], `speedtests.${column} is missing`);
    });

    /**
     * A column the model declares but no migration creates is invisible until
     * the first query touches it, and then every read of the table fails. The
     * list above is hand-written, so it can only catch what someone remembered
     * to add; this asks the model itself.
     */
    it("leaves no model column without a column in the table", async () => {
        const columns = await queryInterface.describeTable("speedtests");
        const missing = Object.keys(server.tests.getAttributes())
            .filter((attribute) => !columns[attribute]);

        assert.deepEqual(missing, [], "declared on the model but never migrated");
    });

    /**
     * The declared type, not a stored value: sqlite's integer affinity is 64-bit
     * and dynamically typed, so it holds any byte count whatever the column
     * says, and the suite only ever runs sqlite. MySQL is the backend this
     * matters on - INTEGER caps there at 2 147 483 647, and one Ookla run
     * already moves more than half of that in a single direction, so a longer
     * test or a faster line would be truncated or refused outright.
     */
    it("declares the byte counts wide enough for a real test", async () => {
        const columns = await queryInterface.describeTable("speedtests");

        for (const column of ["bytesDownloaded", "bytesUploaded"])
            assert.doesNotMatch(columns[column].type, /^INT(EGER)?$/i,
                `speedtests.${column} is ${columns[column].type}, which overflows on MySQL`);
    });

    // Every read filters or sorts on `created`, so without this each one is a
    // full scan of the table.
    it("indexes the column every query orders by", async () => {
        const indexes = await queryInterface.showIndex("speedtests");
        const created = indexes.find((index) => index.name === "speedtests_created");

        assert.ok(created, `no index on created, found: ${indexes.map((i) => i.name).join(", ")}`);
        assert.deepEqual(created.fields.map((field) => field.attribute), ["created"]);
    });

    /**
     * The error column holds whatever the CLI printed to stderr, and Ookla logs
     * one line per candidate server it could not reach - three of those already
     * exceed 255 characters. sqlite ignores the declared length, but MySQL in
     * its default strict mode raises ER_DATA_TOO_LONG, and it does so from
     * inside the failure handler: the failed test was never recorded, the
     * integrations were never told, and the running flag was left set, which
     * suppressed the keep-alive ping until a test finally succeeded.
     */
    /**
     * The error column holds whatever the CLI printed to stderr, and Ookla logs
     * one line per candidate server it could not reach - three of those already
     * exceed 255 characters. MySQL in its default strict mode raises
     * ER_DATA_TOO_LONG, and it does so from inside the failure handler, so the
     * failed test was never recorded at all.
     *
     * sqlite ignores a declared length entirely, so what has to hold there is
     * the behaviour rather than the type.
     */
    it("stores an error far longer than a VARCHAR would hold", async () => {
        const message = "Error: [0] Cannot open socket to 2001:db8::1 port 8080\n".repeat(30);

        const stored = await server.tests.create({
            ping: -1, download: -1, upload: -1, time: null, serverId: 0, type: "auto",
            error: message, created: new Date().toISOString()
        });

        const read = await server.tests.findOne({where: {id: stored.id}});
        assert.equal(read.error.length, message.length);

        await server.tests.destroy({where: {id: stored.id}});
    });

    /**
     * Sequelize implements changeColumn on sqlite by rebuilding the table from
     * describeTable's output - and describeTable does not report autoIncrement.
     * Widening the error column there therefore stripped AUTOINCREMENT off the
     * primary key and took the created index with it.
     *
     * Without AUTOINCREMENT sqlite hands out max(rowid)+1, so deleting the
     * newest test frees its id for the next one. The client's list is keyed on
     * that id: a tab that still shows the deleted row would never see its
     * replacement, and deleteOne resolves by id alone, so clicking delete on
     * the ghost destroys the newer record.
     */
    it("keeps the primary key auto-incrementing", async () => {
        if (server.db.getDialect() !== "sqlite") return;

        const [{sql}] = await server.db.query(
            "SELECT sql FROM sqlite_master WHERE name = 'speedtests'", {type: server.db.QueryTypes.SELECT});

        assert.match(sql, /AUTOINCREMENT/i,
            "a migration rebuilt the table and dropped AUTOINCREMENT from the primary key");
    });

    it("does not hand out an id it has already used", async () => {
        const row = () => ({ping: 1, download: 1, upload: 1, time: 1, serverId: 0, type: "auto",
            created: new Date().toISOString()});

        const first = await server.tests.create(row());
        await server.tests.destroy({where: {id: first.id}});
        const second = await server.tests.create(row());

        assert.notEqual(second.id, first.id, "the id of a deleted test was handed out again");

        await server.tests.destroy({where: {id: second.id}});
    });

    // Every read of this table filters or sorts on `created`, so losing the
    // index turns each one into a full scan.
    it("keeps the created index", async () => {
        const indexes = await queryInterface.showIndex("speedtests");

        assert.ok(indexes.some((index) => index.name === "speedtests_created"),
            "a migration dropped the index on created");
    });

    it("leaves no rebuild scaffolding behind", async () => {
        const tables = await queryInterface.showAllTables();

        assert.ok(!tables.some((name) => String(name).endsWith("_backup")),
            `a table rebuild left its backup behind: ${tables.join(", ")}`);
    });

    /**
     * runMigrations is only ever exercised against a fresh database by the rest
     * of the suite, so nothing caught a migration that was not safe to re-run.
     * Running the whole set a second time has to be a no-op.
     */
    it("is idempotent", async () => {
        const {runMigrations} = await import("../../server/util/migrationRunner.js");

        await assert.doesNotReject(() => runMigrations());

        const indexes = await queryInterface.showIndex("speedtests");
        assert.equal(indexes.filter((index) => index.name === "speedtests_created").length, 1,
            "the index was created twice");
    });
});

/**
 * What 0013 writes, driven through the real up() against a database of its own.
 *
 * The case above cannot reach this. Once a name is in SequelizeMeta,
 * runMigrations() never re-enters its up() - it logs "No pending migrations
 * found" - so "is idempotent" proves the *runner* skips, not that a migration
 * survives being run twice. The one time 0013 genuinely runs twice is the boot
 * after a boot that died inside it, before the name was recorded: nothing here
 * is transactional, so the seed it had already inserted is still there while
 * the legacy config keys it deletes last are still there too. That is the run
 * that used to come up with two identical enabled targets - roundTargets()
 * returns both, so every scheduled round measures the same server twice.
 *
 * So 0013 is called directly, on a throwaway database migrated to 0012, with
 * the statement that realistically fails made to fail. tests/server/
 * targetsMigration.test.js covers the two folds as pure functions; only from
 * here can it be seen which of them up() actually writes, and what a second
 * run leaves behind.
 */

// The keys an instance upgrading from 1.3.5 carries, with the librespeed
// backend URL in the shape older versions stored behind a 200 - `new URL()`
// parses it as scheme "localhost:", so their bare-parse check let it through.
const LEGACY_CONFIG = {provider: "libre", libreId: "none", libreUrl: "localhost:8080"};

const HISTORY_ROWS = 3;

let fixture;

/** A database one migration short of the subject, with a legacy config and some history. */
const migratedToTwelve = async (values) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "myspeed-0013-"));

    // Opened with the options server/config/database.js uses, because 0013
    // destructures what `query` hands back and `raw` is what decides that shape.
    const db = new Sequelize({
        dialect: "sqlite",
        dialectModule: sqlite3Shim,
        storage: path.join(directory, "storage.db"),
        logging: false,
        query: {raw: true}
    });

    const target = db.getQueryInterface();

    for (const {name, up} of migrations) {
        if (name.startsWith("0013")) break;
        await up(target, DataTypes);
    }

    await target.bulkInsert("config", Object.entries(values).map(([key, value]) => ({key, value})));

    await target.bulkInsert("speedtests", Array.from({length: HISTORY_ROWS}, (unused, index) => ({
        ping: 10, download: 100, upload: 50, time: 1, serverId: 0, type: "auto",
        created: `2020-01-0${index + 1}T00:00:00.000Z`
    })));

    return {directory, db, queryInterface: target};
};

/**
 * The same query interface with one statement made to fail, which is how a boot
 * that dies inside up() is reproduced without killing this process.
 *
 * Derived from the real one rather than hand-written: up() reaches
 * showAllTables, describeTable, createTable, addColumn, bulkInsert and
 * bulkDelete, and a stub of all six would only assert that the fixture agrees
 * with itself. Everything but the one statement asked about still runs against
 * sqlite, and what it committed before the failure stays committed - which is
 * the whole point.
 */
const failingOn = (queryInterface, statement) => {
    const sequelize = Object.create(queryInterface.sequelize, {
        query: {
            value: (sql, options) => {
                if (String(sql).startsWith(statement))
                    throw new Error("the connection went away mid-migration");

                return queryInterface.sequelize.query(sql, options);
            }
        }
    });

    return Object.create(queryInterface, {sequelize: {value: sequelize}});
};

const rows = async (sql) => (await fixture.db.query(sql, {raw: true}))[0];

afterEach(async () => {
    if (!fixture) return;

    await fixture.db.close();
    fs.rmSync(fixture.directory, {recursive: true, force: true});
    fixture = null;
});

describe("0013 seeding the first target", () => {
    describe("after a boot that died in the back-fill", () => {
        /**
         * The realistic way to die: the UPDATE rewrites every historical row,
         * so a MySQL lock-wait timeout, an OOM, or an MSI service stop during
         * the upgrade lands there - after the seed has committed, and before
         * the legacy keys the old guard rode on are deleted.
         */
        beforeEach(async () => {
            fixture = await migratedToTwelve(LEGACY_CONFIG);

            await assert.rejects(() => addTargets(
                failingOn(fixture.queryInterface, "UPDATE `speedtests`")));

            const keys = await rows("SELECT `key` FROM `config`");
            assert.equal(keys.length, Object.keys(LEGACY_CONFIG).length,
                "the legacy keys were already gone, so this is not the state a retry sees");

            // The retry the runner performs on the next boot, 0013 still absent
            // from SequelizeMeta.
            await addTargets(fixture.queryInterface);
        });

        it("leaves one target, not the duplicate the legacy-key guard let through", async () => {
            const targets = await rows("SELECT * FROM `targets`");

            assert.equal(targets.length, 1, `the retry seeded again: ${JSON.stringify(targets)}`);
        });

        it("still attributes the history the failed attempt never reached", async () => {
            const [target] = await rows("SELECT `id` FROM `targets`");
            const orphans = await rows("SELECT `id` FROM `speedtests` WHERE `targetId` IS NULL");

            assert.equal(orphans.length, 0,
                "the back-fill was skipped because the retry inserted nothing");

            const attributed = await rows(
                `SELECT \`id\` FROM \`speedtests\` WHERE \`targetId\` = ${target.id}`);
            assert.equal(attributed.length, HISTORY_ROWS);
        });

        it("clears the legacy keys once it gets through", async () => {
            assert.deepEqual(await rows("SELECT `key` FROM `config`"), []);
        });
    });

    describe("on the run that succeeds", () => {
        beforeEach(async () => {
            fixture = await migratedToTwelve(LEGACY_CONFIG);
            await addTargets(fixture.queryInterface);
        });

        /**
         * The written row is seedTarget's answer, not legacyTarget's.
         *
         * That distinction is the whole of the endpoint fix: the row outlives
         * the upgrade and is re-judged whole by targetProblem on every later
         * PATCH - the dialog's scheduled switch sends {enabled} by itself - so
         * a "localhost:8080" carried in verbatim is a target the operator can
         * neither run nor edit. Compared against seedTarget rather than against
         * a literal, so this says which fold up() is required to write.
         */
        it("writes the row seedTarget answers, not the raw legacy fold", async () => {
            const [target] = await rows("SELECT * FROM `targets`");
            const seed = seedTarget(LEGACY_CONFIG);

            assert.equal(target.endpoint, null,
                "an endpoint the CLI cannot fetch was seeded verbatim");

            assert.deepEqual(
                {name: target.name, provider: target.provider,
                    serverId: target.serverId, endpoint: target.endpoint},
                {name: seed.name, provider: seed.provider,
                    serverId: seed.serverId, endpoint: seed.endpoint});
        });

        it("attributes the whole history to it", async () => {
            const [target] = await rows("SELECT `id` FROM `targets`");
            const attributed = await rows(
                `SELECT \`id\` FROM \`speedtests\` WHERE \`targetId\` = ${target.id}`);

            assert.equal(attributed.length, HISTORY_ROWS);
        });
    });

    /**
     * An instance that never chose a provider has nothing to seed, and its
     * history has no target to belong to - so the back-fill, now outside the
     * seed guard, must not invent one. It is the branch that reads the earliest
     * row back from a table this migration has just created empty.
     */
    it("folds nothing, and attributes nothing, when no provider was ever chosen", async () => {
        fixture = await migratedToTwelve({provider: "none"});

        await addTargets(fixture.queryInterface);

        assert.deepEqual(await rows("SELECT * FROM `targets`"), []);

        const attributed = await rows("SELECT `id` FROM `speedtests` WHERE `targetId` IS NOT NULL");
        assert.equal(attributed.length, 0);
    });
});
