import { before, after, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { Op } from "sequelize";
import { bootServer, seedTests, setConfig } from "./helpers/boot.js";
import { readSource } from "../helpers/source.js";
import { asDataObject } from "../../server/controller/integrations.js";

let server, speedtests, changes, targets, integrations;
const CREATED = "2020-01-01T00:00:00.000Z";
const TARGET_CHUNK_ROWS = 500;
const target = (id, name = `Target ${id}`) => ({id, name, provider: "ookla"});
const backup = (overrides = {}) => ({config: {}, nodes: [], integrations: [], recommendations: [], targets: [], ...overrides});
const measurement = (overrides = {}) => ({created: CREATED, type: "auto", ping: 10, download: 100, upload: 50, ...overrides});

before(async () => {
    server = await bootServer();
    speedtests = await import("../../server/controller/speedtests.js");
    changes = (await import("../../server/models/ConnectionChanges.js")).default;
    targets = (await import("../../server/models/Targets.js")).default;
    integrations = (await import("../../server/models/IntegrationData.js")).default;
});
after(async () => { await server?.close(); });
beforeEach(async () => {
    await changes.destroy({where: {}});
    await server.tests.destroy({where: {}});
    await targets.destroy({where: {}});
    await integrations.destroy({where: {}});
});

describe("atomic single-test deletion", () => {
    const seedPair = async () => {
        await seedTests(server.tests, [{created: CREATED}]);
        const row = await server.tests.findOne();
        await changes.create({testId: row.id, created: CREATED, provider: "ookla"});
        return row.id;
    };

    it("rolls back both rows if deleting the associated change fails", async (t) => {
        const id = await seedPair();
        t.mock.method(changes, "destroy", async () => { throw new Error("second delete failed"); });
        await assert.rejects(speedtests.deleteOne(id), /second delete failed/);
        assert.equal(await server.tests.count(), 1, "speedtest deletion escaped rollback");
        assert.equal(await changes.count(), 1);
    });

    it("passes the same real transaction to both deletes", async (t) => {
        const id = await seedPair();
        const testDestroy = t.mock.method(server.tests, "destroy");
        const changeDestroy = t.mock.method(changes, "destroy");
        assert.equal(await speedtests.deleteOne(id), true);
        const transaction = testDestroy.mock.calls[0].arguments[0].transaction;
        assert.ok(transaction, "the speedtest delete needs its transaction option");
        assert.equal(changeDestroy.mock.calls[0].arguments[0].transaction, transaction);
        assert.equal(transaction.finished, "commit");
        assert.equal(await server.tests.count(), 0);
        assert.equal(await changes.count(), 0);
    });

    it("returns false for absent IDs without opening a transaction or deleting", async (t) => {
        await seedPair();
        const transaction = t.mock.method(server.db, "transaction");
        const destroy = t.mock.method(server.tests, "destroy");
        assert.equal(await speedtests.deleteOne(), false);
        for (const id of [undefined, null]) assert.equal(await speedtests.deleteOne(id), false);
        assert.equal(transaction.mock.callCount(), 0);
        assert.equal(destroy.mock.callCount(), 0);
        assert.equal(await server.tests.count(), 1);
    });

    it("rejects non-primary-key arguments before they become delete conditions", async (t) => {
        const id = await seedPair();
        const transaction = t.mock.method(server.db, "transaction");
        const destroy = t.mock.method(server.tests, "destroy");
        for (const invalid of [[id], {[Op.ne]: null}, {}, true, () => id])
            await assert.rejects(speedtests.deleteOne(invalid));
        assert.equal(transaction.mock.callCount(), 0);
        assert.equal(destroy.mock.callCount(), 0);
        assert.equal(await server.tests.count(), 1);
    });

    it("keeps missing-row and no-associated-change results, including string and zero keys", async (t) => {
        const changeDestroy = t.mock.method(changes, "destroy");
        assert.equal(await speedtests.deleteOne(0), false);
        assert.equal(changeDestroy.mock.callCount(), 0);
        const row = await server.tests.create(measurement());
        assert.equal(await speedtests.deleteOne(String(row.id)), true);
        assert.equal(await speedtests.deleteOne(row.id), false);
    });

    it("keeps accepted numeric, bigint, string and Buffer key arguments", async () => {
        for (const key of [0, 17n, "18", Buffer.from("19")]) {
            const expected = await server.tests.findByPk(key);
            assert.equal(await speedtests.deleteOne(key), expected !== null);
        }
        await server.tests.create(measurement({id: 0}));
        assert.equal(await speedtests.deleteOne(0), true, "zero is a supported key, not an absent argument");
    });
});

describe("integration restore preflight", () => {
    for (const [name, invalid] of Object.entries({null: null, array: [], missing: {}, nullName: {name: null}, blank: {name: "   "}, nonString: {name: 1}, malformed: {name: "discord", data: "{"}})) {
        it(`names integrations for ${name} before replacement starts`, async (t) => {
            await integrations.create({id: "keep", name: "old", data: {secret: "retained"}});
            await targets.create(target(1, "Keep"));
            await setConfig(server.config, "download", "321");
            const transaction = t.mock.method(server.db, "transaction");
            const response = await server.config.importConfig(backup({config: {download: "123"}, integrations: [invalid]}));
            assert.deepEqual(response, {ok: false, key: "integrations"});
            assert.equal(transaction.mock.callCount(), 0, "replacement transaction must not start");
            assert.equal(await server.config.getValue("download"), "321");
            assert.equal(asDataObject((await integrations.findByPk("keep")).data).secret, "retained");
            assert.equal((await targets.findByPk(1)).name, "Keep");
        });
    }

    it("keeps unknown names, legacy JSON and omitted defaulted columns", async () => {
        assert.deepEqual(await server.config.importConfig(backup({integrations: [
            {name: " retired-provider ", data: JSON.stringify({send_success: "yes"})},
            {name: "unknown"}
        ]})), {ok: true});
        const rows = await integrations.findAll({raw: true});
        assert.equal(rows[0].name, " retired-provider ");
        assert.deepEqual(asDataObject(rows[0].data), {send_success: "yes"});
        assert.equal(rows[1].displayName, "Untitled");
        assert.deepEqual(asDataObject(rows[1].data), {});
    });
});

describe("bounded target history occupancy reads", () => {
    for (const count of [0, TARGET_CHUNK_ROWS - 1, TARGET_CHUNK_ROWS, TARGET_CHUNK_ROWS + 1]) {
        it(`uses deduplicated candidate queries for ${count} IDs`, async (t) => {
            const rows = Array.from({length: count}, (_, i) => target(i + 1));
            if (count) await seedTests(server.tests, Array.from({length: TARGET_CHUNK_ROWS}, () => ({created: CREATED, targetId: 1})));
            const original = server.tests.findAll;
            const queries = [];
            t.mock.method(server.tests, "findAll", async function (options) {
                const result = await original.call(this, options);
                if (options?.where?.targetId?.[Op.in]) {
                    queries.push(options);
                    assert.deepEqual(options.attributes, ["targetId"]);
                    assert.ok(result.length <= options.where.targetId[Op.in].length, "database returned duplicate history IDs");
                    assert.equal(result.length, new Set(result.map((row) => row.targetId)).size,
                        "history occupancy must return at most one row for each candidate");
                }
                return result;
            });
            const countCalls = t.mock.method(server.tests, "count");
            assert.deepEqual(await server.config.importConfig(backup({targets: rows})), {ok: true});
            assert.equal(queries.length, Math.ceil(count / TARGET_CHUNK_ROWS));
            assert.equal(countCalls.mock.callCount(), 0, "per-target count returned");
            assert.deepEqual(queries.flatMap((query) => query.where.targetId[Op.in]), rows.map((row) => row.id));
            for (const query of queries) assert.ok(query.where.targetId[Op.in].length <= TARGET_CHUNK_ROWS);
            if (count) assert.notEqual((await targets.findOne({where: {name: "Target 1"}})).id, 1);
        });
    }

    it("normalizes driver string IDs before deciding that orphan history is occupied", async (t) => {
        await seedTests(server.tests, [{created: CREATED, targetId: 3}]);
        const original = server.tests.findAll;
        t.mock.method(server.tests, "findAll", async function (options) {
            const result = await original.call(this, options);
            return options?.where?.targetId?.[Op.in] ? result.map((row) => ({targetId: String(row.targetId)})) : result;
        });
        assert.deepEqual(await server.config.importConfig(backup({targets: [target(3)]})), {ok: true});
        assert.notEqual((await targets.findOne()).id, 3);
    });

    for (const invalid of ["bad", "", {}, "9007199254740993", "4"]) {
        it(`fails preflight for unexpected occupied ID ${JSON.stringify(invalid)}`, async (t) => {
            await targets.create(target(8, "Keep"));
            const original = server.tests.findAll;
            t.mock.method(server.tests, "findAll", function (options) {
                return options?.where?.targetId?.[Op.in] ? Promise.resolve([{targetId: invalid}]) : original.call(this, options);
            });
            const transaction = t.mock.method(server.db, "transaction");
            await assert.rejects(server.config.importConfig(backup({targets: [target(3)]})), /historical target/i);
            assert.equal(transaction.mock.callCount(), 0);
            assert.equal((await targets.findByPk(8)).name, "Keep");
        });
    }

    it("retains sequential name precedence, taken collisions, fresh IDs and warning meanings", async (t) => {
        await targets.bulkCreate([target(3, "WAN"), target(4, "Backup")]);
        await seedTests(server.tests, [3, 4, 5].map((targetId) => ({created: CREATED, targetId})));
        const warnings = t.mock.method(console, "warn", () => {});
        assert.deepEqual(await server.config.importConfig(backup({targets: [
            target(10, "WAN"), target(3, "WAN"), target(4, "Backup"), target(5, "Foreign"), target(undefined, "Automatic"), target(12, "Free")
        ]})), {ok: true});
        const rows = await targets.findAll({raw: true, order: [["sortOrder", "ASC"]]});
        assert.equal(rows[0].id, 3);
        assert.notEqual(rows[1].id, 3);
        assert.equal(rows[2].id, 4);
        assert.notEqual(rows[3].id, 5);
        assert.equal(rows[5].id, 12);
        assert.equal(new Set(rows.map((row) => row.id)).size, rows.length);
        assert.match(warnings.mock.calls[0].arguments[0], /Restored 1 target\(s\) under new ids/);
        assert.match(warnings.mock.calls[1].arguments[0], /Restored 2 target\(s\) under different ids/);
        assert.match(warnings.mock.calls[2].arguments[0], /share a name/);
    });

    it("rejects duplicate file IDs before history queries", async (t) => {
        const findAll = t.mock.method(server.tests, "findAll");
        assert.deepEqual(await server.config.importConfig(backup({targets: [target(3), target(3, "Other")]})), {ok: false, key: "targets"});
        assert.equal(findAll.mock.callCount(), 0);
    });
});

describe("required import measurements stay on the bulk path", () => {
    it("filters null and absent required fields even on error rows before any write", async (t) => {
        const {REQUIRED_MEASUREMENTS} = await import("../../server/util/testOutcome.js");
        const invalid = REQUIRED_MEASUREMENTS.flatMap((column) => [null, undefined].flatMap((value) => [undefined, "failed"].map((error) => measurement({[column]: value, error}))));
        const valid = [measurement({ping: 0, download: 0, upload: 0, jitter: null}),
            measurement({ping: -1, download: -1, upload: -1}),
            measurement({ping: -1, download: -1, upload: -1, error: "failed"})];
        const bulk = t.mock.method(server.tests, "bulkCreate");
        const create = t.mock.method(server.tests, "create");
        const errors = t.mock.method(console, "error", () => {});
        assert.deepEqual(await speedtests.importTests([...invalid, ...valid]), {ok: true, imported: valid.length, skipped: invalid.length});
        assert.equal(bulk.mock.callCount(), 1);
        assert.equal(bulk.mock.calls[0].arguments[0].length, valid.length, "invalid rows reached bulkCreate");
        assert.equal(create.mock.callCount(), 0, "valid siblings were retried individually");
        assert.equal(errors.mock.callCount(), 0, "avoidable database validation errors were logged");
        assert.equal(await server.tests.count(), valid.length);
    });

    it("uses the shared required-measurements list in the importer", () => {
        const source = readSource("server/controller/speedtests.js");
        assert.match(source, /import\s*\{[^}]*REQUIRED_MEASUREMENTS[^}]*\}\s*from ['"]\.\.\/util\/testOutcome\.js/);
        assert.doesNotMatch(source, /const REQUIRED_MEASUREMENTS/);
    });
});
