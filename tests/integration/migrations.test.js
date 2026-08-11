import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { bootServer } from "./helpers/boot.js";

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
    });

    it("creates the columns the model expects", async () => {
        const columns = await queryInterface.describeTable("speedtests");

        for (const column of ["ping", "jitter", "download", "upload", "time", "type", "created", "error",
            "serverId", "serverName", "serverHost", "resultId",
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
