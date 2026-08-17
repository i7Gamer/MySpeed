import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DataTypes } from "sequelize";
import { readSource } from "../helpers/source.js";
import { up as widenRecommendationPing } from "../../server/migrations/0012-widen-recommendation-ping.js";

const controllerSource = readSource("server/controller/recommendations.js");
const modelSource = readSource("server/models/Recommendations.js");

/**
 * The figures `update` stores, taken out of the controller and computed.
 *
 * Only the arithmetic is wanted - the write and the integration event behind it
 * need a database - so the object literal is lifted out and evaluated on its
 * own. Run rather than read, because what was wrong is a value, not a spelling.
 */
const storedFor = (ping, download, upload) => {
    const start = controllerSource.indexOf("const configuration =");
    assert.notEqual(start, -1, "update no longer builds the row it stores in one place");

    const from = controllerSource.indexOf("{", start);
    let depth = 0;
    let end = -1;

    for (let index = from; index < controllerSource.length; index++) {
        if (controllerSource[index] === "{") depth++;
        else if (controllerSource[index] === "}" && --depth === 0) { end = index; break; }
    }

    assert.notEqual(end, -1, "the row literal is never closed");

    return new Function("ping", "download", "upload",
        `return ${controllerSource.slice(from, end + 1)};`)(ping, download, upload);
};

/**
 * The recommended targets are read off the ten best recent tests, and the ping
 * among them was rounded to a whole millisecond before it was stored - the
 * column is INTEGER and the controller rounded to match.
 *
 * On anything better than a slow line that is most of the reading: an idle
 * latency of 0.4 ms and one of 1.4 ms became the same recommendation, and a
 * sub-millisecond one became 0. Zero then reads as "the best latency ever
 * measured here", which no later test can beat, so the recommendation it
 * poisons is the one nothing can ever clear. Download and upload beside it have
 * always been stored to two decimals.
 */
describe("the recommended ping", () => {
    it("keeps a sub-millisecond latency rather than flattening it to nothing", () => {
        assert.equal(storedFor(0.3, 100, 50).ping, 0.3,
            "a fibre latency was stored as 0, which no later test can improve on");
    });

    it("keeps the fraction on an ordinary latency", () => {
        assert.equal(storedFor(12.4, 100, 50).ping, 12.4);
    });

    it("stores it to the same two decimals as the speeds beside it", () => {
        const stored = storedFor(12.345678, 100.987654, 50.123456);

        assert.equal(stored.ping, 12.35);
        assert.equal(stored.download, 100.99);
        assert.equal(stored.upload, 50.12);
    });

    it("leaves a whole-millisecond latency exactly as it was", () => {
        assert.equal(storedFor(14, 100, 50).ping, 14);
    });

    it("declares a floating-point column to hold it", () => {
        assert.match(modelSource, /ping:\s*\{[^}]*type:\s*Sequelize\.(DOUBLE|FLOAT)/,
            "the model still rounds every latency to a whole millisecond");
    });
});

/**
 * A fake queryInterface, recording what the migration asked it to change.
 *
 * `describeTable` answers with the column type the database reports, which is
 * what decides whether there is anything to do.
 */
const queryInterface = (dialect, pingType) => {
    const changes = [];

    return {
        changes,
        sequelize: {getDialect: () => dialect},
        describeTable: async () => ({
            id: {type: "INTEGER"},
            ping: {type: pingType},
            download: {type: "DOUBLE PRECISION"},
            upload: {type: "DOUBLE PRECISION"}
        }),
        changeColumn: async (table, column, spec) => changes.push({table, column, spec})
    };
};

/**
 * Widening the column on the databases where it actually rounds.
 *
 * Follows 0010, which did the same for speedtests.ping and documents the
 * reasoning: sqlite is skipped because sequelize implements changeColumn there
 * by rebuilding the table from describeTable's output, which does not report
 * autoIncrement - so the rebuild strips AUTOINCREMENT off the primary key.
 * Nothing is lost by skipping it, because sqlite's INTEGER affinity is numeric
 * rather than integral and stores a fractional value as REAL regardless.
 */
describe("the migration that widens it", () => {
    it("widens an INTEGER column to double precision", async () => {
        const db = queryInterface("mysql", "INT(11)");

        await widenRecommendationPing(db, DataTypes);

        assert.equal(db.changes.length, 1);
        assert.equal(db.changes[0].table, "recommendations");
        assert.equal(db.changes[0].column, "ping");
        assert.equal(db.changes[0].spec.type, DataTypes.DOUBLE);
    });

    it("keeps the column required, as the model has it", async () => {
        const db = queryInterface("mysql", "INT(11)");

        await widenRecommendationPing(db, DataTypes);

        assert.equal(db.changes[0].spec.allowNull, false,
            "widening the column also made it nullable");
    });

    // Re-running a migration is what a restored SequelizeMeta table produces.
    it("does nothing when the column has already been widened", async () => {
        const db = queryInterface("postgres", "DOUBLE PRECISION");

        await widenRecommendationPing(db, DataTypes);

        assert.deepEqual(db.changes, []);
    });

    it("leaves sqlite alone, where the rebuild would cost the primary key", async () => {
        const db = queryInterface("sqlite", "INTEGER");

        await widenRecommendationPing(db, DataTypes);

        assert.deepEqual(db.changes, [], "the sqlite table was rebuilt, dropping AUTOINCREMENT with it");
    });

    it("is registered so it actually runs", async () => {
        const registry = (await import("../../server/migrations/index.js")).default;

        assert.ok(registry.some((migration) => migration.name === "0012-widen-recommendation-ping.js"),
            'the migration is on disk but not in the registry - run "npm run generate-migrations"');
    });
});
