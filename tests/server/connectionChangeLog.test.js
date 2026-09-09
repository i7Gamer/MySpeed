import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DataTypes } from "sequelize";
import { bodyOf, readSource, withoutJsComments } from "../helpers/source.js";
import model from "../../server/models/ConnectionChanges.js";
import { CREATED_INDEX_NAME, up } from "../../server/migrations/0020-add-connection-changes.js";
import { CHANGE_LOG_LIMIT, LOOKBACK_DAYS, MAX_LISTED } from "../../server/controller/connectionChanges.js";

/*
 * Where a change is kept, and every door it passes through: the table and
 * the migration that creates it, the point in the run loop that judges and
 * tells, the sweep that forgets it with the tests it describes, and the
 * route that hands it out.
 */

const TABLE = "connection_changes";

describe("the table a change is kept in", () => {
    const attributes = model.getAttributes();

    it("is the one table, without timestamps of its own", () => {
        assert.equal(model.getTableName(), TABLE);
        assert.equal(model.options.timestamps, false);
    });

    it("keeps the instant, which test saw it and which member ran that test", () => {
        assert.equal(attributes.created.allowNull, false);
        assert.equal(String(attributes.created.type), "VARCHAR(255)");
        assert.equal(attributes.testId.allowNull, true);
        assert.equal(attributes.targetId.allowNull, true);
        assert.equal(attributes.provider.allowNull, false);
    });

    // Nullable rather than blank: only the half that changed is filled, and
    // "the address changed and the provider did not" must be readable from
    // the row without the reader guessing what an empty string meant.
    it("keeps each half of the change nullable", () => {
        for (const column of ["previousIp", "ip", "previousIsp", "isp"]) {
            assert.ok(attributes[column], `${column} is not declared`);
            assert.equal(attributes[column].allowNull, true, column);
        }
    });

    // No foreign key: the retention sweep deletes the test a change points
    // at long before anyone stops caring when the address rotated.
    it("does not bind the test id", () => {
        assert.equal(attributes.testId.references, undefined);
    });
});

describe("the migration that adds it", () => {
    const recording = ({tables = [], indexes = []} = {}) => {
        const calls = [];
        return {
            calls,
            queryInterface: {
                showAllTables: async () => tables,
                showIndex: async () => indexes.map((name) => ({name})),
                createTable: async (table, schema) => { calls.push({createTable: table, schema}); },
                addIndex: async (table, fields, options) => { calls.push({addIndex: table, fields, options}); }
            }
        };
    };

    it("creates the table and the index the list is read through", async () => {
        const {calls, queryInterface} = recording();

        await up(queryInterface);

        assert.equal(calls[0].createTable, TABLE);
        assert.equal(calls[0].schema.created.allowNull, false);
        assert.equal(String(calls[0].schema.previousIp.type), String(DataTypes.STRING));
        assert.equal(calls[0].schema.testId.allowNull, true);
        assert.deepEqual(calls[1], {addIndex: TABLE, fields: ["created"], options: {name: CREATED_INDEX_NAME}});
    });

    it("leaves a database that already has both alone", async () => {
        const {calls, queryInterface} = recording({tables: [TABLE], indexes: [CREATED_INDEX_NAME]});

        await up(queryInterface);

        assert.deepEqual(calls, []);
    });

    it("adds the index to a table that exists without it", async () => {
        const {calls, queryInterface} = recording({tables: [TABLE]});

        await up(queryInterface);

        assert.equal(calls.length, 1);
        assert.equal(calls[0].addIndex, TABLE);
    });
});

describe("the bounds", () => {
    it("keeps the log finite whatever the line does", () => {
        assert.ok(Number.isInteger(CHANGE_LOG_LIMIT) && CHANGE_LOG_LIMIT > 0);
        assert.ok(Number.isInteger(MAX_LISTED) && MAX_LISTED > 0 && MAX_LISTED <= CHANGE_LOG_LIMIT);
    });

    it("looks a bounded way back for the previous address", () => {
        assert.ok(Number.isInteger(LOOKBACK_DAYS) && LOOKBACK_DAYS > 0);
    });
});

/**
 * Where the run loop asks. After the row and the finished notification, so
 * the change is told after the measurement it came with and never delays
 * it; before the trace, which takes seconds. Only on the success path - a
 * failed run reports no address - and never on a demo, whose address is
 * whatever the simulation made up.
 */
describe("where the run loop judges the connection", () => {
    const source = withoutJsComments(readSource("server/tasks/speedtest.js"));
    const body = bodyOf(source, "const executeTarget = async (target, type, retried = false) => {");

    const catchAt = body.indexOf("} catch (e) {");
    const success = body.slice(0, catchAt);
    const failure = body.slice(catchAt);

    it("asks once, on the success path only", () => {
        assert.equal((success.match(/recordChange\(/g) ?? []).length, 1);
        assert.equal((failure.match(/recordChange\(/g) ?? []).length, 0);
    });

    it("asks after the finished notification and before the trace", () => {
        assert.ok(success.indexOf("recordChange(") > success.indexOf("sendFinished("));
        assert.ok(success.indexOf("recordChange(") < success.indexOf("diagnoseRun("));
    });

    it("never asks on a demo", () => {
        const call = success.slice(success.lastIndexOf("\n", success.indexOf("recordChange(")) - 200, success.indexOf("recordChange("));

        assert.match(call, /mode !== "preview"/);
    });

    it("hands over what the verdict needs", () => {
        const call = success.slice(success.indexOf("recordChange("));
        const args = call.slice(0, call.indexOf(";"));

        for (const fact of ["created", "isp", "externalIp", "provider", "target"])
            assert.match(args, new RegExp(`\\b${fact}\\b`), `${fact} is not handed over`);
    });

    // Contained the way createRecommendations is: a log that cannot be
    // written must not fail the test it follows, and the send is fire and
    // forget like sendFinished above it.
    it("cannot fail the test it follows", () => {
        const call = success.slice(success.indexOf("recordChange("));

        assert.match(call.slice(0, call.indexOf(";")), /\.catch\(/);
        assert.match(success, /sendConnectionChanged\(connectionChangedPayload\(/);
        assert.match(success.slice(success.indexOf("sendConnectionChanged(")).split(";")[0], /\.catch\(/);
    });

    it("tells the notifiers which member saw it and whether it alerts", () => {
        const send = success.slice(success.indexOf("sendConnectionChanged("));
        const args = send.slice(0, send.indexOf(";"));

        assert.match(args, /targetName: target\.name/);
        assert.match(args, /alerts: Boolean\(target\.alerts\)/);
    });
});

/**
 * The log describes the history, so it goes where the history goes: pruned
 * by the retention sweep, cleared with "delete all tests", and gone after
 * a factory reset. An address log that outlives the history it explains is
 * a disclosure the operator explicitly asked to end.
 */
describe("where the log is forgotten", () => {
    const controller = withoutJsComments(readSource("server/controller/speedtests.js"));
    const config = withoutJsComments(readSource("server/controller/config.js"));

    it("is pruned with the tests, by the same cutoff", () => {
        const body = bodyOf(controller, "export const removeOld = async () => {");

        assert.match(body, /removeOlderThan\(cutoff\)/);
    });

    it("is cleared with the history", () => {
        const body = bodyOf(controller, "export const deleteTests = async () => {");

        assert.match(body, /connectionChanges\.removeAll\(transaction\)/);
    });

    it("is cleared by the factory reset, inside its transaction", () => {
        const body = bodyOf(config, "export const factoryReset");

        assert.match(body, /connectionChanges\.destroy\(\{where: \{\}, transaction\}\)/);
    });
});

describe("the route", () => {
    const routes = readSource("server/routes/speedtests.js");

    // Above "/:id", which would otherwise answer it as a test called
    // "connections".
    it("is mounted above the one-test route", () => {
        assert.ok(routes.indexOf('app.get("/connections"') > 0, "there is no connections route");
        assert.ok(routes.indexOf('app.get("/connections"') < routes.indexOf('app.get("/:id"'));
    });

    // Nothing but identity, so nothing for a viewer - and nothing for a
    // demo, whose password gate opens to everyone.
    it("is sealed from viewers and demos", () => {
        const line = routes.split("\n").find((candidate) => candidate.startsWith('app.get("/connections"'));

        assert.match(line, /password\(false\)/);
        assert.match(line, /previewReadOnly\.blocking\(/);
    });
});
