import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isThresholdNumber } from "../../client/src/common/utils/TestUtil.js";

const ROOT = path.resolve(fileURLToPath(import.meta.url), "..", "..", "..");

const read = (file) => fs.readFileSync(path.join(ROOT, file), "utf8");

const DIALOG = "client/src/common/components/OptimalValuesDialog/OptimalValuesDialog.jsx";

/**
 * The server's copy of the rule, read out of its source.
 *
 * Restating it here would let the two drift and still agree with the test.
 */
const serverPattern = () => {
    const source = read("server/controller/config.js");
    const match = source.match(/const THRESHOLD_NUMBER = \/(.+)\/;/);

    assert.notEqual(match, null, "the server no longer declares THRESHOLD_NUMBER as a literal");

    return new RegExp(match[1]);
};

/**
 * Everything the three threshold fields can be handed, and what a number is.
 *
 * The dotted entries are the whole point: `/[^0-9.]/` asks whether every
 * character is a digit or a dot, which "1.2.3", ".." and "." all satisfy while
 * being no number at all. Number("1.2.3") is NaN, and getIconBySpeed answers
 * "blue" for a threshold it cannot read - so every speed on the dashboard goes
 * grey with nothing on screen naming the value that did it.
 */
const NUMBERS = ["1", "25", "100", "0", "0.5", "12.34", "000", ".5", "1.", ".0", "0."];
const NOT_NUMBERS = ["1.2.3", "..", ".", "1..2", "1.2.", "1e3", "-1", "+1", " 1 ", "1 ",
    "NaN", "Infinity", "abc", "1a", "1,5", "2.5e1", "٣", "１"];

describe("a speed or latency threshold", () => {
    NUMBERS.forEach((value) => {
        it(`takes ${JSON.stringify(value)}`, () => {
            assert.equal(isThresholdNumber(value), true);
        });
    });

    NOT_NUMBERS.forEach((value) => {
        it(`refuses ${JSON.stringify(value)}`, () => {
            assert.equal(isThresholdNumber(value), false);
        });
    });

    /*
     * ".5" and "1." are 0.5 and 1, and the check this replaced took both - so an
     * instance can be holding one now. The server states the same allowance for
     * the same reason: importConfig runs every stored key back through its
     * validator and abandons the whole restore on the first refusal.
     */
    it("keeps the values a bare dot on either end can mean", () => {
        [".5", "1.", ".0", "0."].forEach((value) =>
            assert.equal(isThresholdNumber(value), true,
                `${value} was legal when it was saved and has to stay restorable`));
    });

    it("answers a non-string by what it reads as", () => {
        assert.equal(isThresholdNumber(25), true);
        assert.equal(isThresholdNumber(0.5), true);
        assert.equal(isThresholdNumber(null), false);
        assert.equal(isThresholdNumber(undefined), false);
        assert.equal(isThresholdNumber({}), false);
        assert.equal(isThresholdNumber(true), false);
    });
});

/**
 * The client and the server hold the same rule, and the client's copy is the one
 * that was left behind: the server anchored its check while this one went on
 * asking `/[^0-9.]/`, so the dialog waved "1.2.3" through to a 400 rather than
 * naming it where the operator typed it.
 *
 * Read out of the server's source rather than restated here, so the two cannot
 * drift again without this failing.
 */
describe("the client's threshold rule and the server's", () => {
    it("agree on every value either could be given", () => {
        const server = serverPattern();

        [...NUMBERS, ...NOT_NUMBERS].forEach((value) =>
            assert.equal(isThresholdNumber(value), server.test(value),
                `the client and the server disagree about ${JSON.stringify(value)}`));
    });
});

/**
 * And both answer a long value in linear time.
 *
 * `[0-9]+\.?[0-9]*` puts two digit runs on either side of an optional dot, so a
 * run of digits that fails at the end can be divided between them in as many
 * ways as it is long - and the engine tries every one before giving up. That is
 * quadratic: doubling the input quadruples the work.
 *
 * It is reachable with nothing but a request. importConfig runs every stored key
 * back through this validator, and the import body is parsed at a 50mb limit -
 * so one restore carrying a long enough threshold blocks the event loop for as
 * long as it takes to finish, and a default install has no password to stop
 * anyone sending it. CodeQL flags it as js/polynomial-redos.
 *
 * The fix is to require the dot inside the optional group, which leaves the two
 * runs unable to trade characters. The language is unchanged - the table above
 * is what says so.
 *
 * Timed rather than reasoned about, and with four orders of magnitude of margin:
 * unambiguous, this answers in well under a millisecond; ambiguous, in seconds.
 */
describe("a threshold rule handed a long value", () => {
    // Enough to be unmistakable and still quick to build. The ambiguous form
    // takes seconds on this; the budget is what separates the two.
    const ATTACK = "0".repeat(100_000) + "!";
    const BUDGET_MS = 500;

    const millisecondsFor = (run) => {
        const started = process.hrtime.bigint();
        run();

        return Number(process.hrtime.bigint() - started) / 1e6;
    };

    for (const [whose, test] of [
        ["client", (value) => isThresholdNumber(value)],
        ["server", (value) => serverPattern().test(value)]
    ]) {
        it(`answers the ${whose}'s copy without stalling`, () => {
            const spent = millisecondsFor(() => test(ATTACK));

            assert.ok(spent < BUDGET_MS,
                `the ${whose}'s rule spent ${spent.toFixed(0)}ms on ${ATTACK.length} characters, `
                + "so a longer one blocks for as long as the caller cares to make it");
        });
    }

    it("still refuses it", () => {
        assert.equal(isThresholdNumber(ATTACK), false);
        assert.equal(serverPattern().test(ATTACK), false);
    });
});

describe("the optimal values dialog", () => {
    /*
     * Called, not merely imported. Asking whether the name appears anywhere is
     * satisfied by the import line on its own, so the assertion held while the
     * guard below it went on using the rule it replaced - which is the state
     * this file exists to catch.
     */
    it("asks the shared rule for each of its three fields", () => {
        const source = read(DIALOG);

        assert.match(source, /isThresholdNumber\(/,
            "the dialog validates thresholds with something other than the shared rule");

        ["ping", "download", "upload"].forEach((field) =>
            assert.match(source, new RegExp(`invalid\\(${field}, config\\.${field}\\)`),
                `${field} is not put through the guard, so a bad value in it reaches the server`));
    });

    /*
     * The negated class itself, because that is the defect: it reads as "every
     * character is a digit or a dot", which is not what a number is.
     *
     * The whole file, comments included, which is why the comment beside the
     * fix describes the class in words rather than writing it out. A scan for
     * something's absence is answered by prose, and the alternative - teaching
     * the scan to skip comments - needs a lexer that can tell a regex from a
     * division, which in JSX nothing short of a parser does.
     */
    it("no longer asks whether every character is a digit or a dot", () => {
        assert.doesNotMatch(read(DIALOG), /\[\^0-9\.]/,
            "the dialog still carries the unanchored check the server replaced");
    });
});

/**
 * And only the fields it is going to send.
 *
 * `update` patches a field only when it differs from the stored config, so a
 * malformed value already on the instance - every MySpeed up to 1.3.4 stored
 * whatever the same unanchored check let through - is seeded into the form and
 * then never sent. Validating it anyway turns it into a refusal of the whole
 * save, including the field the operator did change, and the offending input
 * reads empty on screen because a number input drops what it cannot parse.
 */
describe("the optimal values dialog only refuses what it would send", () => {
    const guard = () => {
        const source = read(DIALOG);
        const start = source.indexOf("const update = async");

        return source.slice(start, source.indexOf("updateToast", start));
    };

    it("checks each field against the stored value before validating it", () => {
        assert.match(guard(), /value !== stored/,
            "a stored value the dialog never sends can still refuse the whole save");
    });

    it("still refuses a bad value in a field that has changed", () => {
        assert.match(guard(), /!isThresholdNumber/,
            "the dialog no longer validates anything at all");
    });
});
