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
 * A grid row is as tall as its tallest cell, and three of these facts carry a
 * second line under their value - the duration under the timestamp, the result
 * link under the provider, the host under the server. Scattered through the
 * grid, each of them made its whole row two lines tall and left the one-line
 * facts beside it sitting in the empty half: on a three-column layout every one
 * of the three rows was a tall one. Gathered into a single row, only that row
 * grows and the short facts close up beneath it.
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
        for (const key of ["measured_at", "measured_with", "server"])
            assert.match(factBody(key), /detail-secondary/,
                `the ${key} fact no longer has a second line to group`);
    });

    it("puts the timestamp, the provider and the server together", () => {
        assert.ok(factAt("measured_at") < factAt("measured_with"),
            "the provider no longer follows the timestamp");
        assert.ok(factAt("measured_with") < factAt("server"),
            "the server is not beside the provider it was measured with");
    });

    // The whole point: nothing one line tall may sit between them, or it takes
    // the empty half of a row that the grouping was meant to remove.
    it("lets no single-line fact in between them", () => {
        const tallRowEnds = factAt("server");

        for (const key of ["data_used", "trigger"])
            assert.ok(factAt(key) > tallRowEnds,
                `the ${key} fact splits the tall row and takes a tall row of its own`);
    });

    /**
     * The connection is two lines too - the address sits under the provider -
     * and there is no room left for it: three columns hold three of the four.
     * It goes after the short facts rather than among them, where it would put
     * a second tall row under the first and leave two short facts in its empty
     * half.
     */
    it("leaves the fourth two-line fact to trail the short ones", () => {
        assert.match(factBody("connection"), /detail-secondary/,
            "the connection no longer carries an address under its provider");
        assert.ok(factAt("connection") > factAt("trigger"),
            "the connection sits among the short facts and makes their row tall");
    });
});
