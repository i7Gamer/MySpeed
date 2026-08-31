import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DataTypes } from "sequelize";
import { bodyIn, readSource, withoutJsComments } from "../helpers/source.js";
import targets from "../../server/models/Targets.js";
import { up } from "../../server/migrations/0017-add-baseline-percent.js";
import { BASELINE_METRICS } from "../../server/util/baselineAlert.js";
import { BASELINE_ROW_COLUMNS } from "../../server/controller/speedtests.js";
import { targetProblem, viewerFacing } from "../../server/controller/targets.js";

/**
 * Everything about a target's baseline setting that is not the verdict itself:
 * where the percentage is stored, which write paths carry it, and which columns
 * the window it is judged against reads.
 *
 * Held together because the failure they share is silence. A column missing
 * from any one of the three whitelists costs nothing at write time - the
 * request succeeds, the row is written, the field is simply gone - and the
 * target then measures with no baseline while the dialog shows one set. The
 * restore path is the worst of them, because the operator finds out by opening
 * a dialog that has quietly reset itself.
 */

const COLUMN = "baselinePercent";

const attributes = targets.getAttributes();

describe("where a target's baseline percentage is stored", () => {
    it("declares the column on the model", () => {
        assert.ok(attributes[COLUMN], `${COLUMN} is not declared on the targets model`);
    });

    /**
     * Nullable, and null is the whole of how a target says the baseline is off
     * - the spelling the three optimal columns already use. A separate boolean
     * beside it would introduce a state those three deliberately do not have:
     * a row reading "baseline on, percentage unset" would need a rule of its
     * own, in every reader.
     */
    it("leaves it nullable, which is how a target says it has none", () => {
        assert.notEqual(attributes[COLUMN].allowNull, false, `${COLUMN} may not be null`);
        assert.equal(attributes[COLUMN].defaultValue, null, `${COLUMN} defaults to something`);
    });

    // A DOUBLE, not an integer: the door accepts a fraction because 72.5 per
    // cent of a line is an ordinary thing to want, and an INTEGER column would
    // round it on the way in with nothing saying so.
    it("stores it as a double, so a fraction survives the write", () => {
        assert.equal(String(attributes[COLUMN].type), "DOUBLE PRECISION",
            `${COLUMN} is not a double column`);
    });
});

/**
 * The migration that puts it in the table.
 *
 * Run against a recording queryInterface rather than a database: what matters
 * here is which column it asks for and with what, and the same file is run
 * against a real sqlite in tests/integration/migrations.test.js.
 */
describe("the migration that adds it", () => {
    const recorder = (table = {}) => {
        const added = [];

        return {
            added,
            describeTable: async (name) => {
                assert.equal(name, "targets", "the migration described the wrong table");
                return table;
            },
            addColumn: async (name, column, options) => added.push({name, column, options})
        };
    };

    it("adds the column to a table that lacks it", async () => {
        const queryInterface = recorder();

        await up(queryInterface);

        assert.deepEqual(queryInterface.added.map((entry) => entry.column), [COLUMN]);
        assert.deepEqual(queryInterface.added.map((entry) => entry.name), ["targets"]);
    });

    it("adds it with the type and nullability the model declares", async () => {
        const queryInterface = recorder();

        await up(queryInterface);

        const [{options}] = queryInterface.added;

        assert.equal(options.type, DataTypes.DOUBLE, `${COLUMN} is not a double column`);
        assert.equal(options.allowNull, true, `${COLUMN} was migrated NOT NULL`);
        assert.equal(options.defaultValue, null, `${COLUMN} was migrated with a default`);
    });

    /**
     * The runner records each migration by name and will not run it twice, but
     * the guard is what makes a re-run - a restored database, a half-applied
     * upgrade - safe rather than a duplicate-column error on boot. It is also
     * the pattern every column migration here already follows.
     */
    it("adds nothing to a table that already has it", async () => {
        const queryInterface = recorder({[COLUMN]: {}});

        await up(queryInterface);

        assert.deepEqual(queryInterface.added, []);
    });
});

/**
 * Every path that writes a target row.
 *
 * All three are explicit whitelists, on purpose - a request body is not a row,
 * and an unknown key is a typo rather than a column to invent. The cost of that
 * discipline is that a new column is invisible to all three until it is named
 * in each, and nothing fails when it is not.
 */
describe("the write paths that must carry it", () => {
    it("lets a request set it", () => {
        const source = withoutJsComments(readSource("server/routes/targets.js"));
        const whitelist = /const WRITABLE = \[[^\]]*\]/.exec(source);

        assert.ok(whitelist, "the writable whitelist is no longer a literal array");
        assert.ok(whitelist[0].includes(COLUMN), `a PUT or PATCH carrying ${COLUMN} would drop it`);
    });

    it("writes it onto a target being created", () => {
        const body = withoutJsComments(bodyIn("server/controller/targets.js", "export const create ="));

        assert.ok(body.includes(COLUMN), `a new target loses ${COLUMN}`);
    });

    it("puts it back when a configuration backup is restored", () => {
        const body = withoutJsComments(bodyIn("server/controller/config.js",
            "targetRows = targetRows.map("));

        assert.ok(body.includes(COLUMN), `a restored backup silently drops ${COLUMN}`);
    });
});

describe("the door a percentage has to get through", () => {
    const valid = {name: "Frankfurt", provider: "ookla", serverId: "1234", endpoint: null};

    it("is asked by targetProblem, which is the door the API stands behind", () => {
        assert.equal(targetProblem({...valid, [COLUMN]: 70}), null);
        assert.equal(targetProblem({...valid, [COLUMN]: null}), null);
        assert.match(targetProblem({...valid, [COLUMN]: 0}), /baseline/i);
        assert.match(targetProblem({...valid, [COLUMN]: 100}), /baseline/i);
        assert.match(targetProblem({...valid, [COLUMN]: "70"}), /baseline/i);
    });

    // Every target on every instance that upgrades into this column names
    // nothing, and has nothing to answer for.
    it("leaves a target that names none alone", () => {
        assert.equal(targetProblem(valid), null);
    });

    /**
     * Deliberately not shown to a read-only visitor. viewerFacing answers what
     * the interface needs to label, order and grade a target - the optimal
     * values are the grading itself - and a percentage of a median the visitor
     * cannot see grades nothing. It is one more detail of how the operator
     * watches their own line.
     */
    it("is withheld from a read-only visitor", () => {
        const shown = viewerFacing({id: 4, name: "LAN", provider: "iperf3", enabled: true,
            sortOrder: 0, optimalPing: null, optimalDownload: null, optimalUpload: null,
            [COLUMN]: 70});

        assert.equal(COLUMN in shown, false);
    });
});

/**
 * And the window the median is taken over.
 *
 * A wide range holds every row it reads in memory at once, and most of a row's
 * weight is text this never looks at - a server name, a hostname, an ISP, a
 * result URL. The query selects exactly the two columns the median reads, which
 * is the lesson STATISTICS_COLUMNS records: a column added to the read but not
 * to the list arrives as undefined, silently.
 */
describe("the columns the baseline window reads", () => {
    it("is the one list the median and the query share", () => {
        assert.deepEqual(BASELINE_ROW_COLUMNS, BASELINE_METRICS);
    });

    it("selects them and nothing else", () => {
        const body = withoutJsComments(bodyIn("server/controller/speedtests.js",
            "export const listForBaseline ="));

        assert.match(body, /attributes:\s*BASELINE_ROW_COLUMNS/,
            "the window query no longer narrows to the columns the median reads");
    });

    /**
     * Newest first, because the first row it answers is the previous test - the
     * one the storm rule compares against. Ordered by the same pair the tests
     * list is, so "newest" means the same thing in both.
     */
    it("answers them newest first, which is what makes the first row the previous test", () => {
        const body = withoutJsComments(bodyIn("server/controller/speedtests.js",
            "export const listForBaseline ="));

        assert.match(body, /order:\s*LIST_ORDER/, "the window is no longer ordered newest first");
    });

    // Successful rows only. A failed run stores -1 in every numeric column, and
    // a median taken over those describes nothing.
    it("takes the median over successful rows alone", () => {
        const body = withoutJsComments(bodyIn("server/controller/speedtests.js",
            "export const listForBaseline ="));

        assert.ok(body.includes("SUCCESSFUL_TEST_FILTER"),
            "the window would include the rows a failed run wrote");
    });
});

/**
 * And how the verdict reaches the payload.
 *
 * Read from the source because firing this needs a spawned CLI and a real run;
 * the chain either side of it is executed in tests/integration/baselineAlert.
 * The failure this is written against is the one iperfUdp first landed with: a
 * column migrated, whitelisted, judged at the door and drawn in the dialog, and
 * inert - because nothing in the run ever names it.
 */
describe("how the verdict reaches the payload", () => {
    const body = withoutJsComments(bodyIn("server/tasks/speedtest.js", "const executeTarget ="));

    it("asks the target whether it has a baseline at all", () => {
        assert.ok(withoutJsComments(readSource("server/tasks/speedtest.js")).includes(COLUMN),
            `the run never names ${COLUMN}, so the feature is inert`);
    });

    /**
     * Before the row is written, and that ordering is the whole rule.
     *
     * The window query is ordered newest first, so a verdict reached after
     * tests.create finds the row it just wrote sitting at the head of the
     * window - the test becomes its own "previous", the edge the storm rule
     * fires on can never be crossed, and the feature is silent forever with
     * every unit test still green.
     */
    it("reaches the verdict before the row is written", () => {
        const judged = body.indexOf("baselineKeys(");
        const written = body.indexOf("tests.create(");

        assert.notEqual(judged, -1, "the run no longer reaches a baseline verdict");
        assert.notEqual(written, -1, "the row is no longer written here");
        assert.ok(judged < written,
            "the verdict is reached after the row is stored, so the test is its own previous");
    });

    /**
     * Degraded rather than thrown, the way wasPrimaryMember is and for the same
     * reason it says out loud: this runs inside executeTarget's try, whose catch
     * measures the whole member again and writes a second row. A database that
     * could not answer a question about the median would otherwise turn a
     * perfectly good measurement into a recorded failure and a failure
     * notification.
     */
    it("degrades to no baseline rather than failing the run", () => {
        assert.match(body, /baselineKeys\([^)]*\)[\s\S]{0,200}?\.catch\(/,
            "a database that cannot answer would turn a good measurement into a failure");
    });

    it("carries the verdict on the finished payload", () => {
        assert.match(body, /finishedPayload\(\{[\s\S]*?\.\.\.baseline[\s\S]*?\}\)/,
            "the verdict never reaches the gate that reads it");
    });
});
