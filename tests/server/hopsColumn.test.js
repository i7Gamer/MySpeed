import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DataTypes } from "sequelize";
import { bodyOf, readSource, withoutJsComments } from "../helpers/source.js";
import speedtests from "../../server/models/Speedtests.js";
import { up } from "../../server/migrations/0018-add-hops-column.js";
import { parsedHops, presentHops, storedHops } from "../../server/controller/speedtests.js";
import { stripConnectionIdentity } from "../../server/util/connectionIdentity.js";
import { configDefaults, validateInput } from "../../server/controller/config.js";
import { TRACEROUTE_KEY } from "../../server/tasks/hopDiagnostics.js";
import { FAILED_VARIABLES, FINISHED_VARIABLES } from "../../server/util/notificationPayload.js";
import { CSV_COLUMNS, toCsv } from "../../server/util/csv.js";

/*
 * Where a degraded run's hop table lives, and every door it passes through:
 * the column, the migration that creates it, the JSON it is stored as and
 * read back from, the import that must not hand the database an array, the
 * viewer it is withheld from, and the switch that turns the whole thing on.
 */

const COLUMN = "hops";

// RFC 4180 cells: every field is quoted and an inner quote is doubled, so a
// split on the separator alone would cut the JSON text at its own quotes.
const csvCells = (line) => [...line.matchAll(/"((?:[^"]|"")*)"/g)].map(([, cell]) => cell.replaceAll('""', '"'));
const HOPS = [{hop: 1, address: "192.168.1.1", rtt: [1], lost: 0}, {hop: 2, address: null, rtt: [], lost: 3}];

describe("where the hop table is stored", () => {
    const attributes = speedtests.getAttributes();

    it("declares the column on the model, nullable, with no default", () => {
        assert.ok(attributes[COLUMN], `${COLUMN} is not declared on the speedtests model`);
        assert.notEqual(attributes[COLUMN].allowNull, false);
        assert.equal(attributes[COLUMN].defaultValue, null);
    });

    // TEXT, not STRING: twenty hops with three latencies each run far past the
    // 255 characters a VARCHAR holds, and MySQL in strict mode refuses rather
    // than truncates - from inside the tail of a run that measured perfectly.
    it("stores it as text, since a route is longer than a VARCHAR", () => {
        assert.equal(String(attributes[COLUMN].type), "TEXT");
    });
});

describe("the migration that adds it", () => {
    const recording = (existing = {}) => {
        const added = [];
        return {
            added,
            queryInterface: {
                describeTable: async () => existing,
                addColumn: async (table, name, options) => { added.push({table, name, options}); }
            }
        };
    };

    it("adds a nullable text column to the speedtests table", async () => {
        const {added, queryInterface} = recording();

        await up(queryInterface);

        assert.equal(added.length, 1);
        assert.equal(added[0].table, "speedtests");
        assert.equal(added[0].name, COLUMN);
        assert.equal(String(added[0].options.type), String(DataTypes.TEXT));
        assert.equal(added[0].options.allowNull, true);
    });

    it("leaves a table that already has it alone", async () => {
        const {added, queryInterface} = recording({[COLUMN]: {}});

        await up(queryInterface);

        assert.deepEqual(added, []);
    });
});

/**
 * The column holds JSON and the API answers an array. One writer and one
 * reader, so the two cannot disagree about the encoding.
 */
describe("how the table travels through the column", () => {
    it("stores the table as JSON", () => {
        assert.equal(storedHops(HOPS), JSON.stringify(HOPS));
    });

    it("reads it back as the array it was", () => {
        assert.deepEqual(presentHops({id: 1, [COLUMN]: JSON.stringify(HOPS)})[COLUMN], HOPS);
    });

    // Absent, not null: every list path already drops a null error and a
    // null resultId, so a row without a trace looks like every row did before
    // the column existed - and no reader has to learn a new null.
    it("drops the key from a row that has no table", () => {
        for (const value of [null, undefined]) {
            const row = presentHops({id: 1, [COLUMN]: value});
            assert.equal(Object.hasOwn(row, COLUMN), false, `${value} left the key on the row`);
        }
    });

    it("drops a column holding something that is not a table", () => {
        for (const value of ["not json", "{}", "\"text\"", "42"]) {
            const row = presentHops({id: 1, [COLUMN]: value});
            assert.equal(Object.hasOwn(row, COLUMN), false, `${value} came back as a table`);
        }
    });

    // A hand-edited backup can put anything into the column the import
    // accepts. The pane dereferences every hop it is handed, so a table with
    // one malformed hop is no table at all rather than a crash on open.
    it("drops a table with a hop the pane could not draw", () => {
        for (const table of [[null], [{hop: 1}], [{hop: 1, address: null, rtt: "1", lost: 0}], ["hop"]]) {
            const row = presentHops({id: 1, [COLUMN]: JSON.stringify(table)});
            assert.equal(Object.hasOwn(row, COLUMN), false, `${JSON.stringify(table)} came back as a table`);
            assert.equal(parsedHops(JSON.stringify(table)), null);
        }
    });

    it("hands back the row it was given", () => {
        const row = {id: 1, [COLUMN]: null};
        assert.equal(presentHops(row), row);
    });

    // The export names every column on every row, so there the absent table
    // is a null rather than a missing key - the same reader, one step short.
    it("reads the column for the export as the array or null", () => {
        assert.deepEqual(parsedHops(JSON.stringify(HOPS)), HOPS);
        assert.equal(parsedHops(null), null);
        assert.equal(parsedHops("not json"), null);
        assert.equal(parsedHops("{}"), null);
    });
});

describe("the read paths", () => {
    const controller = withoutJsComments(readSource("server/controller/speedtests.js"));

    // The list, the single row, the latest row of the status payload, the
    // backup walk and the dashboard export: each one hands rows to a reader,
    // and a reader that gets a JSON string where every other gets an array is
    // the kind of drift no single test of the helper can see.
    for (const reader of ["getOne", "listTests", "listPages", "getLatest", "latestOfTargets"])
        it(`${reader} presents the table`, () => {
            assert.match(bodyOf(controller, `export const ${reader} =`), /\bpresentHops\b/,
                `${reader} hands rows out without presenting the hop table`);
        });

    it("exportTests names the column on every row", () => {
        assert.match(bodyOf(controller, "export const exportTests ="), /hops: parsedHops\(entry\.hops\)/,
            "the export drops or mis-encodes the hop table");
    });

    // The import spreads the file's row straight into bulkCreate. A backup
    // written by the JSON export carries the table as an array, and an array
    // reaching a TEXT column is whatever the dialect makes of it.
    it("re-serialises an imported table and drops anything else", () => {
        const body = bodyOf(controller, "export const importTests =");

        assert.match(body, /storedHops\(/, "an imported hop table reaches bulkCreate as an array");
        assert.match(body, /isHopTable\(row\.hops\)/, "the import stores any array as a table, malformed hops included");
    });
});

/**
 * A hop table shows the LAN gateway and the provider's path - what the
 * connection identity masking exists to withhold from a viewer. Deleted
 * rather than nulled, for the reason resultId is: absence is what a row with
 * no trace already looks like.
 */
describe("what a viewer sees of it", () => {
    it("is nothing", () => {
        const stripped = stripConnectionIdentity({id: 1, isp: "x", externalIp: "y", [COLUMN]: HOPS});

        assert.equal(Object.hasOwn(stripped, COLUMN), false);
    });

    it("is an empty cell in the CSV", () => {
        const [, line] = toCsv([stripConnectionIdentity({id: 1, [COLUMN]: HOPS})]).split("\n");

        assert.equal(csvCells(line)[CSV_COLUMNS.indexOf(COLUMN)], "");
    });

    // The payload keys are the variables a message template offers, and a
    // table is not a value a template can print - it would substitute as
    // "[object Object],[object Object]".
    it("is nothing in a notification", () => {
        assert.equal(FINISHED_VARIABLES.includes(COLUMN), false);
        assert.equal(FAILED_VARIABLES.includes(COLUMN), false);
    });
});

/**
 * The dashboard export names every column, so the table goes out too: as
 * the array in the JSON, and as that array's JSON text in one CSV cell, where
 * the writer's unconditional quoting keeps the commas inside it from shifting
 * the row. Before `error`, which the CSV keeps last.
 */
describe("what the CSV carries of it", () => {
    it("names the column before the error column", () => {
        assert.ok(CSV_COLUMNS.includes(COLUMN), "the CSV drops the hop table");
        assert.equal(CSV_COLUMNS.indexOf(COLUMN), CSV_COLUMNS.length - 2);
    });

    it("writes the table as JSON text in one cell", () => {
        const [, line] = toCsv([{id: 1, [COLUMN]: HOPS}]).split("\n");
        const cells = csvCells(line);

        assert.equal(cells.length, CSV_COLUMNS.length, "the table's commas split the row");
        assert.deepEqual(JSON.parse(cells[CSV_COLUMNS.indexOf(COLUMN)]), HOPS);
    });
});

describe("the switch", () => {
    it("is a config key, off unless the operator turns it on", () => {
        assert.equal(configDefaults[TRACEROUTE_KEY], "false");
    });

    it("accepts only true or false, as a string", async () => {
        assert.deepEqual(await validateInput(TRACEROUTE_KEY, "true"), {value: "true"});
        assert.deepEqual(await validateInput(TRACEROUTE_KEY, "false"), {value: "false"});
        // A raw boolean is stored as its string, not as the dialect's rendering of a bound boolean.
        assert.deepEqual(await validateInput(TRACEROUTE_KEY, true), {value: "true"});

        for (const value of ["yes", "1", "", "TRUE"])
            assert.equal(typeof await validateInput(TRACEROUTE_KEY, value), "string", `${value} was accepted`);
    });

    // An operator's setting, not something a public dashboard has any use
    // for - the same list the cron and the quiet hours are on.
    it("is withheld from an untrusted reader", () => {
        const route = readSource("server/routes/config.js");
        const list = route.match(/const WITHHELD_FROM_UNTRUSTED = \[([\s\S]*?)\];/)?.[1] ?? "";

        assert.match(list, new RegExp(`"${TRACEROUTE_KEY}"`));
    });
});

/**
 * Where the run loop asks. After the row is written and the integrations are
 * told, on both paths - the trace takes seconds, and the row and the
 * notification must not wait on it.
 */
describe("where the run loop asks for a trace", () => {
    const source = withoutJsComments(readSource("server/tasks/speedtest.js"));
    const body = bodyOf(source, "const executeTarget = async (target, type, retried = false) => {");

    const catchAt = body.indexOf("} catch (e) {");
    const success = body.slice(0, catchAt);
    const failure = body.slice(catchAt);

    it("asks once on each path", () => {
        assert.equal((success.match(/diagnoseRun\(/g) ?? []).length, 1, "the success path asks");
        assert.equal((failure.match(/diagnoseRun\(/g) ?? []).length, 1, "the failure path asks");
    });

    it("asks after the row is written and the integrations are told", () => {
        assert.ok(success.indexOf("diagnoseRun(") > success.indexOf("sendFinished("));
        assert.ok(failure.indexOf("diagnoseRun(") > failure.indexOf("sendError("));
    });

    it("asks only once the retry has been decided", () => {
        assert.ok(failure.indexOf("diagnoseRun(") > failure.indexOf("return await executeTarget(target, type, true)"));
    });

    it("tells the failure path which failures are the provider's own doing", () => {
        assert.match(failure, /diagnoseRun\([^;]*rateLimited/);
    });

    it("hands the success path what the verdict needs", () => {
        const call = success.slice(success.indexOf("diagnoseRun("));

        for (const fact of ["serverHost", "ping", "baselineBreached"])
            assert.match(call.slice(0, call.indexOf(";")), new RegExp(`\\b${fact}\\b`), `${fact} is not handed over`);
    });

    // Awaited: the running latch and the round's own wait are what keep the
    // next scheduled run off the same line while the trace probes it.
    it("waits for the trace inside the run", () => {
        assert.match(success, /await diagnoseRun\(/);
        assert.match(failure, /await diagnoseRun\(/);
    });
});
