import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { bootServer, api } from "./helpers/boot.js";

const ROOT = path.resolve(fileURLToPath(import.meta.url), "..", "..", "..");

let server;
let testModel;

before(async () => {
    server = await bootServer();
    testModel = (await import("../../server/models/Speedtests.js")).default;
});

after(async () => {
    await server?.close();
});

const row = (index) => ({
    type: "auto",
    created: `2020-01-01T00:00:${String(index % 60).padStart(2, "0")}.000Z`,
    ping: 10,
    download: 100,
    upload: 50
});

const history = (count) => Array.from({length: count}, (unused, index) => row(index));

const importHistory = (payload) => api(server.baseUrl, "/storage/tests/history", {
    method: "PUT",
    headers: {"Content-Type": "application/json"},
    body: JSON.stringify(payload)
});

/**
 * The check that stands in for the model's own validation.
 *
 * create() validates before it writes and bulkCreate() does not, so batching the
 * import moved the only guard onto NUMERIC_COLUMNS - the list the loop tests
 * every row against before the row is ever queued. Measured, that costs nothing
 * today: every DOUBLE column in the model is on that list, so a value the model
 * would have refused is skipped before the write either way, and turning
 * validation back on for the batch was 51% slower for no change in what is
 * stored.
 *
 * What it does cost is a coupling between two lists that have to stay in step.
 * A DOUBLE column added to the model and forgotten here would be the jitter bug
 * again, which the list's own comment describes: the series is filtered on null
 * rather than on being a number, so a text value is summed and the whole range's
 * average comes back NaN.
 */
describe("the columns a restore checks before writing", () => {
    it("covers every measurement column the model has", () => {
        const source = fs.readFileSync(
            path.join(ROOT, "server", "controller", "speedtests.js"), "utf8");
        const declared = source.match(/const NUMERIC_COLUMNS = \[([\s\S]*?)];/);

        assert.notEqual(declared, null, "NUMERIC_COLUMNS is no longer a literal list");

        const checked = [...declared[1].matchAll(/"([^"]+)"/g)].map((match) => match[1]);
        const doubles = Object.entries(testModel.rawAttributes)
            .filter(([, attribute]) => /DOUBLE|FLOAT|DECIMAL/.test(attribute.type.constructor.key ?? ""))
            .map(([name]) => name);

        assert.notEqual(doubles.length, 0, "the model declares no measurement columns at all");
        assert.deepEqual(doubles.filter((column) => !checked.includes(column)), [],
            "a measurement column is written without being checked for being a number, "
            + "and bulkCreate does not validate - so a text value reaches the column and every average over it is NaN");
    });
});

describe("importing a history", () => {
    it("writes every row it was given", async () => {
        await testModel.destroy({where: {}});

        const {status, body} = await importHistory(history(2_000));

        assert.equal(status, 200);
        assert.deepEqual({imported: body.imported, skipped: body.skipped}, {imported: 2_000, skipped: 0});
        assert.equal(await testModel.count(), 2_000);
    });

    /**
     * A row the database itself refuses must not take the rest down with it.
     *
     * Everything the payload can get wrong is caught by the checks above the
     * write - a bad `type`, a malformed `created`, a value that is not a number
     * - and those are counted as skipped without ever reaching the database. So
     * this is about the other kind: a row that passes all of them and is refused
     * on the way in. Whatever the rows are written in, one refusal has to cost
     * one row.
     */
    it("keeps the rest of a batch when one row is refused", async () => {
        await testModel.destroy({where: {}});

        const payload = history(600);
        /*
         * An object where a string belongs, which the column's own validator
         * refuses - the same shape that made an over-long integration name a
         * 500. It has to be a column nothing above the write looks at, and it
         * has to be one sqlite actually refuses: sqlite is typeless, so an
         * over-long string is stored happily and would prove nothing here.
         */
        payload[300].resultId = {};

        const {status, body} = await importHistory(payload);

        assert.equal(status, 200);
        assert.equal(body.imported, 599,
            `one refused row cost ${600 - body.imported} rows, so the batch it was in went down with it`);
        assert.equal(body.skipped, 1);
        assert.equal(await testModel.count(), 599);
    });

    /**
     * And the server answers something else while it is writing.
     *
     * The import is one statement per row inside one transaction, and the sqlite
     * driver is synchronous - node:sqlite's DatabaseSync, resolved through
     * process.nextTick - so `await` never leaves the microtask queue and the
     * event loop does not turn once for the whole import. Nothing else is
     * served: not another request, not a timer, and not the container
     * healthcheck, which then times out and restarts the container in the middle
     * of the write.
     *
     * That is not only an attacker's lever. A genuine multi-year history is
     * hundreds of thousands of rows - a test a minute is half a million a year -
     * so this is what an ordinary restore does.
     *
     * Asked without a stopwatch: the question is whether /api/health is answered
     * *before* the import finishes, not how many milliseconds either took. On a
     * blocked loop the health request cannot be answered until the import
     * releases the loop, so it necessarily lands after it.
     */
    it("keeps answering other requests while it writes", async () => {
        await testModel.destroy({where: {}});

        let importDone = false;
        const importing = importHistory(history(20_000)).then((result) => {
            importDone = true;
            return result;
        });

        // Long enough for the request to arrive and the writing to start.
        await new Promise((resolve) => setTimeout(resolve, 100));

        const health = await api(server.baseUrl, "/health");

        assert.equal(importDone, false,
            "the health check was only answered once the import had finished, so nothing else was served for its whole duration");
        assert.equal(health.status, 200);

        const {status, body} = await importing;
        assert.equal(status, 200);
        assert.equal(body.imported, 20_000, "the rows did not all arrive");
    });

    /**
     * And it does not refuse the writes it now lets through.
     *
     * The turn of the event loop is between the chunks, never inside one, and
     * this is the reason. sqlite refuses a second writer while a transaction
     * holds the lock, and it refuses rather than waits - "database is locked",
     * immediately. So an import that yielded while its own transaction was open
     * would answer the healthcheck and drop the scheduled speedtest that
     * finished during it, which is a worse bargain than the freeze.
     *
     * The writes go through the same process and the same sequelize instance the
     * server uses, so this is the collision a scheduled test would have, not a
     * model of one.
     */
    it("does not refuse another write while it is writing", async () => {
        await testModel.destroy({where: {}});

        let importDone = false;
        const importing = importHistory(history(20_000)).then((result) => {
            importDone = true;
            return result;
        });

        await new Promise((resolve) => setTimeout(resolve, 100));

        const refused = [];
        let attempted = 0;

        while (!importDone && attempted < 20) {
            attempted++;
            await testModel
                .create({type: "custom", created: "2021-06-06T06:06:06.000Z", ping: 1, download: 1, upload: 1})
                .catch((error) => refused.push(error.message));
            await new Promise((resolve) => setTimeout(resolve, 20));
        }

        await importing;

        assert.ok(attempted > 0, "the import finished before a single write could be attempted against it");
        assert.deepEqual(refused, [],
            `${refused.length} of ${attempted} writes made during the import were refused outright`);
    });
});
