import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { withoutComments } from "../helpers/source.js";
import { isThresholdNumber } from "../../client/src/common/utils/TestUtil.js";

const ROOT = path.resolve(fileURLToPath(import.meta.url), "..", "..", "..");

const read = (file) => fs.readFileSync(path.join(ROOT, file), "utf8");

const DIALOG = "client/src/common/components/OptimalValuesDialog/OptimalValuesDialog.jsx";

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
    const serverPattern = () => {
        const source = read("server/controller/config.js");
        const match = source.match(/const THRESHOLD_NUMBER = \/(.+)\/;/);

        assert.notEqual(match, null, "the server no longer declares THRESHOLD_NUMBER as a literal");

        return new RegExp(match[1]);
    };

    it("agree on every value either could be given", () => {
        const server = serverPattern();

        [...NUMBERS, ...NOT_NUMBERS].forEach((value) =>
            assert.equal(isThresholdNumber(value), server.test(value),
                `the client and the server disagree about ${JSON.stringify(value)}`));
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
        const calls = withoutComments(read(DIALOG)).match(/isThresholdNumber\(/g) ?? [];

        assert.equal(calls.length, 3,
            `the dialog makes ${calls.length} threshold checks, one per field expected`);
    });

    /*
     * The negated class itself, because that is the defect: it reads as "every
     * character is a digit or a dot", which is not what a number is.
     *
     * Against the code rather than the file. The comment beside the fix names
     * the form it replaced - that is what the comment is for - and an assertion
     * that the form is gone finds it there and fails, which would leave the
     * prose written to suit the scan.
     */
    it("no longer asks whether every character is a digit or a dot", () => {
        assert.doesNotMatch(withoutComments(read(DIALOG)), /\[\^0-9\.]/,
            "the dialog still carries the unanchored check the server replaced");
    });
});
