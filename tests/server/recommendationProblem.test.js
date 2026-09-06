import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { bodyOf, readSource } from "../helpers/source.js";
import { recommendationProblem } from "../../server/controller/config.js";

/**
 * A restore judged its node and target rows before touching anything and
 * bulk-inserted its recommendation rows as the file wrote them. The columns
 * are DOUBLE NOT NULL and nothing more, which sqlite does not enforce on the
 * type: a hand-edited backup put a string where the grading expects a
 * number, and the grade read it back as one.
 */
describe("recommendationProblem", () => {
    const valid = {ping: 12.5, download: 100, upload: 50};

    it("accepts a row of three non-negative numbers", () => {
        assert.equal(recommendationProblem(valid), null);
        assert.equal(recommendationProblem({...valid, ping: 0}), null, "a zero is a measurement");
        assert.equal(recommendationProblem({...valid, id: 3}), null, "the exported id is refused");
    });

    it("refuses anything that is not an object", () => {
        for (const row of [null, undefined, 4, "row", [valid]])
            assert.match(recommendationProblem(row), /must be an object/, `${JSON.stringify(row)} passed`);
    });

    it("refuses a figure that is not a finite non-negative number", () => {
        for (const figure of ["ping", "download", "upload"])
            for (const value of [-1, "12", null, undefined, NaN, Infinity, true])
                assert.match(recommendationProblem({...valid, [figure]: value}), new RegExp(`${figure} must be a non-negative number`),
                    `${figure}: ${String(value)} passed`);
    });
});

describe("the import", () => {
    it("judges the recommendation rows before the transaction, as it judges the nodes", () => {
        const body = bodyOf(readSource("server/controller/config.js"), "export const importConfig = ");
        const judged = body.indexOf("recommendationProblem(row)");

        assert.notEqual(judged, -1, "the recommendation rows are bulk-inserted as the file wrote them");
        assert.ok(judged < body.indexOf("db.transaction("), "the rows are judged after the tables were emptied");
        assert.match(body.slice(judged, judged + 200), /key: "recommendations"/,
            "the refusal does not name the key the operator can act on");
    });
});
