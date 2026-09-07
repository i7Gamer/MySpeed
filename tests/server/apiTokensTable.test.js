import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DataTypes } from "sequelize";
import { bodyOf, listSources, readSource, withoutJsComments } from "../helpers/source.js";
import apiTokens from "../../server/models/ApiTokens.js";
import { up } from "../../server/migrations/0019-add-api-tokens.js";
import { SCOPE_RUN } from "../../server/controller/tokens.js";

/*
 * Where a token lives and which doors it passes through: the table, the
 * migration that creates it, the backup that carries it only with the other
 * secrets, and the two routes a token may open.
 */

describe("the api_tokens model", () => {
    const attributes = apiTokens.getAttributes();

    it("stores the digest, never the token, and refuses a row without one", () => {
        assert.ok(attributes.digest, "no digest column");
        assert.equal(attributes.digest.allowNull, false);
        assert.equal(attributes.digest.unique, true, "two rows could hold the same digest");
        assert.equal(attributes.token, undefined, "the model has a column for the secret itself");
    });

    // STRING(64) on purpose: a bare STRING is 255 characters, and a unique
    // index over 255 utf8mb4 characters is more than MySQL's compact row
    // format allows.
    it("sizes the digest column to a sha256 hex", () => {
        assert.equal(String(attributes.digest.type), "VARCHAR(64)");
    });

    it("requires a name and a scope, and defaults the scope to run", () => {
        assert.equal(attributes.name.allowNull, false);
        assert.equal(attributes.scope.allowNull, false);
        assert.equal(attributes.scope.defaultValue, SCOPE_RUN);
    });

    it("leaves last-used nullable, which is how a token says it was never used", () => {
        assert.notEqual(attributes.lastUsed.allowNull, false);
        assert.equal(attributes.lastUsed.defaultValue, null);
    });

    it("keeps its table name", () => {
        assert.equal(apiTokens.getTableName(), "api_tokens");
    });
});

describe("the migration that creates it", () => {
    const recording = (tables = []) => {
        const created = [];
        const indexes = [];
        return {
            created,
            indexes,
            queryInterface: {
                showAllTables: async () => tables,
                createTable: async (name, schema) => { created.push({name, schema}); },
                addIndex: async (table, fields, options) => { indexes.push({table, fields, options}); },
                showIndex: async () => []
            }
        };
    };

    it("creates the table with every column the model reads", async () => {
        const {created, queryInterface} = recording();

        await up(queryInterface);

        assert.equal(created.length, 1);
        assert.equal(created[0].name, "api_tokens");

        const columns = Object.keys(created[0].schema);
        for (const column of Object.keys(apiTokens.getAttributes()))
            assert.ok(columns.includes(column), `the migration creates no ${column} column`);

        assert.equal(created[0].schema.id.autoIncrement, true);
        assert.equal(created[0].schema.digest.allowNull, false);
        assert.equal(String(created[0].schema.digest.type), String(DataTypes.STRING(64)));
    });

    it("puts a named unique index on the digest", async () => {
        const {indexes, queryInterface} = recording();

        await up(queryInterface);

        const digest = indexes.find((index) => index.fields.includes("digest"));
        assert.ok(digest, "the digest is not indexed, so every lookup scans the table");
        assert.equal(digest.options.unique, true);
        assert.equal(typeof digest.options.name, "string");
    });

    it("leaves an instance that already has the table alone", async () => {
        const {created, queryInterface} = recording(["api_tokens", "speedtests"]);

        await up(queryInterface);

        assert.deepEqual(created, []);
    });
});

/**
 * A backup carries the digests only beside the other secrets. A digest is not
 * the token, but a file that can be written back is a file that can hand the
 * run endpoint to whoever holds it - and the redacted export is the one that
 * gets attached to bug reports.
 */
describe("what the backup carries", () => {
    const controller = withoutJsComments(readSource("server/controller/config.js"));
    const exporter = bodyOf(controller, "export const exportConfig =");
    const importer = bodyOf(controller, "export const importConfig =");

    it("exports the tokens only with the secrets", () => {
        assert.match(exporter, /if \(includeSecrets\) obj\.tokens =/,
            "the redacted export carries the digests, or the full export drops them");
    });

    // An older backup, or a redacted one, names no tokens key - and restoring
    // it must not delete the automation the operator set up since.
    it("restores the tokens only when the file names them", () => {
        assert.match(importer, /obj\.tokens !== undefined/,
            "a file without a tokens key wipes the table, or one with it is ignored");
        assert.doesNotMatch(controller, /\{key: "tokens", model: apiTokens\}/,
            "tokens joined IMPORTED_TABLES, so every backup written before them is refused");
    });

    it("judges every row before the restore touches anything", () => {
        assert.match(importer, /importableToken/);
        assert.match(importer, /return \{ok: false, key: "tokens"\}/);
    });
});

/**
 * Exactly two routes honour a token, and both keep their password gate for
 * everyone else: the trigger, and the cheap status the dashboard polls during
 * a run, which carries no identity and no schedule.
 */
describe("the routes a token opens", () => {
    const source = readSource("server/routes/speedtests.js");

    it("are the run trigger and the live status, at the run scope", () => {
        assert.match(source, /app\.post\("\/run", tokenOrPassword\(SCOPE_RUN\)/);
        assert.match(source, /app\.get\("\/status\/live", tokenOrPassword\(SCOPE_RUN, true\)/);
    });

    it("do not include the full status, which names the schedule and the line", () => {
        assert.match(source, /app\.get\("\/status", password\(true\)/);
    });

    it("say in the log which token started a run", () => {
        const run = source.slice(source.indexOf('app.post("/run"'), source.indexOf('app.get("/status"'));
        assert.match(run, /req\.apiToken/, "a run started by a token is indistinguishable from a click");
    });

    it("are the only mounts that read a token", () => {
        // Every route file there is, read off the directory rather than
        // listed here: a list named eight of fourteen, so a token gate
        // added to any of the other six left this green.
        const others = listSources("server/routes").filter((name) => name !== "speedtests.js");
        assert.ok(others.length >= 10, `only ${others.length} route files were found`);

        for (const other of others)
            assert.doesNotMatch(readSource(`server/routes/${other}`), /tokenOrPassword/, other);
    });
});
