import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DataTypes } from "sequelize";
import { bodyIn, readSource, withoutJsComments } from "../helpers/source.js";
import targets from "../../server/models/Targets.js";
import { up } from "../../server/migrations/0015-add-target-tuning.js";
import { IPERF_CONNECT_TIMEOUT_MS, IPERF_DURATION_SECONDS, IPERF_MAX_DURATION_SECONDS,
    IPERF_OMIT_SECONDS, iperfRunSeconds } from "../../server/util/providers/registry.js";

/**
 * Everything about an iperf3 target's own tuning that is not one function's
 * judgement: where the two numbers are stored, which write paths carry them,
 * and how they reach the run.
 *
 * They are held together because the failure they share is silence. A column
 * missing from any one of the three whitelists costs nothing at write time -
 * the request succeeds, the row is written, the field is simply gone - and the
 * target then measures at the defaults with nothing anywhere saying so.
 */

// The columns the feature adds. Named once, because every assertion below is
// "and this one too".
const TUNING_COLUMNS = ["iperfDuration", "iperfStreams"];

const attributes = targets.getAttributes();

describe("where a target's iperf3 tuning is stored", () => {
    it("declares both columns on the model", () => {
        for (const column of TUNING_COLUMNS)
            assert.ok(attributes[column], `${column} is not declared on the targets model`);
    });

    /**
     * Nullable, because null is not "no value" here - it is the whole of how a
     * target says "inherit the registry default", the same spelling the three
     * optimal columns already use. A NOT NULL column with the default written
     * into it would freeze today's default onto every existing row.
     */
    it("leaves both nullable, which is what inheriting the default means", () => {
        for (const column of TUNING_COLUMNS) {
            assert.notEqual(attributes[column].allowNull, false, `${column} may not be null`);
            assert.equal(attributes[column].defaultValue, null, `${column} defaults to something`);
        }
    });

    // Whole seconds and whole streams. A DOUBLE would store 10.5 happily and
    // hand iperf3 a duration it refuses, on a schedule, forever.
    it("stores both as whole numbers", () => {
        for (const column of TUNING_COLUMNS)
            assert.equal(String(attributes[column].type), "INTEGER",
                `${column} is not an integer column`);
    });
});

/**
 * The migration that puts them in the table.
 *
 * Run against a recording queryInterface rather than a database: what matters
 * here is which columns it asks for and with what, and the same file is run
 * against a real sqlite in tests/integration/migrations.test.js.
 */
describe("the migration that adds them", () => {
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

    it("adds both columns to a table that has neither", async () => {
        const queryInterface = recorder();

        await up(queryInterface);

        assert.deepEqual(queryInterface.added.map((entry) => entry.column), TUNING_COLUMNS);
        assert.deepEqual(queryInterface.added.map((entry) => entry.name), ["targets", "targets"]);
    });

    it("adds them with the types and nullability the model declares", async () => {
        const queryInterface = recorder();

        await up(queryInterface);

        for (const {column, options} of queryInterface.added) {
            assert.equal(options.type, DataTypes.INTEGER, `${column} is not an integer column`);
            assert.equal(options.allowNull, true, `${column} was migrated NOT NULL`);
            assert.equal(options.defaultValue, null, `${column} was migrated with a default`);
        }
    });

    /**
     * The runner records each migration by name and will not run it twice, but
     * the guard is what makes a re-run - a restored database, a half-applied
     * upgrade - safe rather than a duplicate-column error on boot. It is also
     * the pattern every column migration here already follows.
     */
    it("adds nothing to a table that already has them", async () => {
        const queryInterface = recorder({iperfDuration: {}, iperfStreams: {}});

        await up(queryInterface);

        assert.deepEqual(queryInterface.added, []);
    });

    // Half-applied is the case the loop exists for: one column present, one not.
    it("adds only what is missing", async () => {
        const queryInterface = recorder({iperfDuration: {}});

        await up(queryInterface);

        assert.deepEqual(queryInterface.added.map((entry) => entry.column), ["iperfStreams"]);
    });
});

/**
 * Every path that writes a target row.
 *
 * All three are explicit whitelists, on purpose - a request body is not a row,
 * and an unknown key is a typo rather than a column to invent. The cost of that
 * discipline is that a new column is invisible to all three until it is named
 * in each, and nothing fails when it is not: the write succeeds and the value
 * is gone. The restore path is the worst of them, because the operator finds
 * out by looking at a dialog that has quietly reset itself.
 */
describe("the write paths that must carry it", () => {
    it("lets a request set both fields", () => {
        const source = withoutJsComments(readSource("server/routes/targets.js"));
        const whitelist = /const WRITABLE = \[[^\]]*\]/.exec(source);

        assert.ok(whitelist, "the writable whitelist is no longer a literal array");

        for (const column of TUNING_COLUMNS)
            assert.ok(whitelist[0].includes(column),
                `a PUT or PATCH carrying ${column} would drop it`);
    });

    it("writes both onto a target being created", () => {
        const body = withoutJsComments(bodyIn("server/controller/targets.js",
            "export const create ="));

        for (const column of TUNING_COLUMNS)
            assert.ok(body.includes(column), `a new target loses ${column}`);
    });

    it("puts both back when a configuration backup is restored", () => {
        const body = withoutJsComments(bodyIn("server/controller/config.js",
            "targetRows = targetRows.map("));

        for (const column of TUNING_COLUMNS)
            assert.ok(body.includes(column), `a restored backup silently drops ${column}`);
    });
});

/**
 * And how the two numbers reach the run they describe.
 *
 * Read from the source because firing this needs a spawned CLI and a bound
 * interface, which is the very thing these assertions are about not having. The
 * behaviour either side of the plumbing - what buildArgs answers, what the bar
 * divides by - is executed in iperf3.test.js and progress.test.js.
 */
describe("how the tuning reaches the run", () => {
    const runner = withoutJsComments(readSource("server/util/speedtest.js"));

    it("hands both fields to the argument builder", () => {
        for (const column of TUNING_COLUMNS)
            assert.ok(runner.includes(column), `the runner never names ${column}`);
    });

    /**
     * The bar's denominator. Left at the module constant, a sixty-second run
     * fills it in the first ten seconds and then sits at 100% for fifty, which
     * reads as a run that has hung - the one thing progress exists to
     * distinguish from a slow line.
     */
    it("measures progress against the length this run was asked for", () => {
        const body = withoutJsComments(bodyIn("server/util/speedtest.js", "const runOnce ="));

        assert.match(body, /parseProgressLine\(mode, line\.trim\(\), phase, [A-Za-z][\w.]*\)/,
            "the progress reader is still given no duration, so it divides by the default");
    });

    it("takes the target's own length where it has one", () => {
        assert.equal(iperfRunSeconds({iperfDuration: IPERF_MAX_DURATION_SECONDS}),
            IPERF_MAX_DURATION_SECONDS);
    });

    // A row that inherits, a fragment that never carried the field, and the
    // absent tuning of every other provider's run.
    it("falls back to the registry default for a target that names none", () => {
        assert.equal(iperfRunSeconds({iperfDuration: null}), IPERF_DURATION_SECONDS);
        assert.equal(iperfRunSeconds({}), IPERF_DURATION_SECONDS);
        assert.equal(iperfRunSeconds(undefined), IPERF_DURATION_SECONDS);
    });
});

/**
 * Why the ceiling is where it is.
 *
 * The runner arms its timeout per invocation, and an iperf3 test is two of them
 * - so the longest a target may be tuned to, plus the warm-up it omits and the
 * time the control connection is allowed, has to sit comfortably inside that
 * timeout. Raised past it, the ceiling would let an operator configure a target
 * that can only ever be killed halfway and recorded as a test that did not
 * finish.
 */
describe("the longest run a target may ask for", () => {
    const MS_PER_SECOND = 1000;

    // Read out of the runner rather than exported for this: the timeout is that
    // file's own business, and a test is not a reason to widen its surface.
    const cliTimeoutMs = () => {
        const declaration = /const CLI_TIMEOUT = (\d+) \* MS_PER_SECOND;/
            .exec(readSource("server/util/speedtest.js"));

        assert.ok(declaration, "the runner no longer declares CLI_TIMEOUT in seconds");

        return Number(declaration[1]) * MS_PER_SECOND;
    };

    it("fits inside the timeout a single invocation is given", () => {
        const longest = (IPERF_MAX_DURATION_SECONDS + IPERF_OMIT_SECONDS) * MS_PER_SECOND
            + IPERF_CONNECT_TIMEOUT_MS;

        assert.ok(longest < cliTimeoutMs(),
            `a target tuned to ${IPERF_MAX_DURATION_SECONDS}s cannot finish inside the run's timeout`);
    });
});
