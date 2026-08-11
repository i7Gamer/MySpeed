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
    });

    it("creates the columns the model expects", async () => {
        const columns = await queryInterface.describeTable("speedtests");

        for (const column of ["ping", "jitter", "download", "upload", "time", "type", "created", "error",
            "serverId", "serverName", "serverHost", "resultId",
            "packetLoss", "downloadLatency", "uploadLatency", "isp", "externalIp"])
            assert.ok(columns[column], `speedtests.${column} is missing`);
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
    it("stores the CLI's error output in a column that can hold it", async () => {
        const columns = await queryInterface.describeTable("speedtests");

        assert.match(columns.error.type, /TEXT/i,
            `speedtests.error is ${columns.error.type}, which truncates or rejects a real stderr dump`);
    });

    // Sequelize implements changeColumn on sqlite by rebuilding the table, which
    // drops every index defined on it. Widening the error column must not cost
    // the index every read of this table depends on.
    it("keeps the created index after the column was widened", async () => {
        const indexes = await queryInterface.showIndex("speedtests");

        assert.ok(indexes.some((index) => index.name === "speedtests_created"),
            "widening a column dropped the index on created");
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
