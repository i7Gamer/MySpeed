import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PANE = path.resolve(fileURLToPath(import.meta.url), "..", "..", "..",
    "client", "src", "common", "components", "TestDetails", "TestDetails.jsx");

const pane = fs.readFileSync(PANE, "utf8");
const facts = pane.slice(pane.indexOf('className="detail-facts"'));

const factAt = (key) => {
    const at = facts.indexOf(`t("test.details.${key}")`);
    assert.notEqual(at, -1, `the ${key} fact is gone from the grid`);
    return at;
};

const factBody = (key) => {
    const at = factAt(key);
    return facts.slice(at, facts.indexOf("</DetailFact>", at));
};

/**
 * Which facts share a row, and why it is worth arranging deliberately.
 *
 * A grid row is as tall as its tallest cell, and four of these facts carry a
 * second line under their value - the duration under the timestamp, the result
 * link under the provider, the host under the server, the address under the
 * connection. Scattered through the grid, each of them made its whole row two
 * lines tall and left the one-line facts beside it sitting in the empty half.
 * Gathered, only their row grows and the short facts close up beneath it.
 *
 * The connection joined them once the column count was measured rather than
 * assumed: the grid is `auto-fit` over an 18rem minimum, which comes out at
 * four columns from 1366px up - the common desktop case, not a rare one - so
 * all four fit a single row there. Measured on a complete record, at four
 * columns the pane goes from a 55px row over a 75px one to a 75px row over a
 * 37px one, and at two columns from 268px to 252px. At three, where they
 * cannot all fit, it comes out the same height either way.
 *
 * A source scan for the order, as the other rendering rules here are: the
 * arrangement is entirely a matter of which cell follows which, and node cannot
 * render JSX to measure it.
 */
describe("the facts grid keeps its two-line facts in one row", () => {
    // The premise the ordering rests on. If one of these stops carrying a
    // second line it no longer belongs in the tall row, and the grouping below
    // would be arranging something that is not there.
    it("is arranging the facts that really do carry a second line", () => {
        for (const key of ["measured_at", "measured_with", "server", "connection"])
            assert.match(factBody(key), /detail-secondary/,
                `the ${key} fact no longer has a second line to group`);
    });

    it("puts the timestamp, the provider, the server and the connection together", () => {
        assert.ok(factAt("measured_at") < factAt("measured_with"),
            "the provider no longer follows the timestamp");
        assert.ok(factAt("measured_with") < factAt("server"),
            "the server is not beside the provider it was measured with");
        assert.ok(factAt("server") < factAt("connection"),
            "the connection no longer completes the tall row");
    });

    // The whole point: nothing one line tall may sit between them, or it takes
    // the empty half of a row that the grouping was meant to remove.
    it("lets no single-line fact in between them", () => {
        const tallRowEnds = factAt("connection");

        for (const key of ["data_used", "trigger", "bufferbloat"])
            assert.ok(factAt(key) > tallRowEnds,
                `the ${key} fact splits the tall row and takes a tall row of its own`);
    });

    /**
     * Four is all there is, so the row is full and the rest are one-liners.
     * A fifth two-line fact would have to displace one of these rather than be
     * appended, which is the trap the connection itself was in.
     */
    it("leaves nothing two lines tall among the short facts", () => {
        for (const key of ["data_used", "trigger", "bufferbloat"])
            assert.doesNotMatch(factBody(key), /detail-secondary/,
                `the ${key} fact grew a second line and now makes the short row tall`);
    });
});
