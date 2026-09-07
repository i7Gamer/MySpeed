import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { bodyOf, readSource } from "../helpers/source.js";
import { NODE_NAME_LIMIT, nodeNameProblem } from "../../server/util/nodeName.js";

/**
 * nodes.name is VARCHAR(255) on MySQL, and both routes that write it checked
 * only that something was sent: a longer name passed and the insert failed
 * with ER_DATA_TOO_LONG, answered as a 500. sqlite stored it whole, so the
 * suite never saw it.
 */
describe("nodeNameProblem", () => {
    it("accepts a name the column can hold", () => {
        assert.equal(nodeNameProblem("Living room"), null);
        assert.equal(nodeNameProblem("x".repeat(NODE_NAME_LIMIT)), null, "the limit itself is refused");
    });

    it("refuses a name longer than the column", () => {
        assert.match(nodeNameProblem("x".repeat(NODE_NAME_LIMIT + 1)), /255 characters or fewer/);
    });

    it("refuses anything that is not a string", () => {
        for (const name of [42, null, undefined, {}, ["a"], true])
            assert.match(nodeNameProblem(name), /must be a string/, `${JSON.stringify(name)} passed as a name`);
    });

    // Blankness is the routes' question, asked before this one; a backup must
    // not be refused over a name the instance that wrote it was carrying.
    it("does not judge blankness", () => {
        assert.equal(nodeNameProblem(""), null);
        assert.equal(nodeNameProblem("   "), null);
    });
});

describe("the places a node name is written", () => {
    const routes = readSource("server/routes/nodes.js");

    it("are both judged by the one validator, and answer 400", () => {
        const create = bodyOf(routes, 'app.put("/"');
        const rename = bodyOf(routes, 'app.patch("/:nodeId/name"');

        for (const [name, handler] of [["create", create], ["rename", rename]]) {
            assert.match(handler, /nodeNameProblem\(req\.body\.name\)/, `the ${name} route writes the name unjudged`);
            assert.match(handler, /status\(400\)\.json\(\{message: nameProblem, type: "INVALID_NAME"\}\)/,
                `the ${name} route does not answer the problem as a 400`);
        }
    });

    it("judges the name before the reachability check on create", () => {
        const create = bodyOf(routes, 'app.put("/"');

        assert.ok(create.indexOf("nodeNameProblem(") < create.indexOf("checkNodeTarget("),
            "an unholdable name is only refused after the node has been reached");
    });

    it("include the config import", () => {
        const problem = bodyOf(readSource("server/controller/config.js"), "const nodeProblem = ");

        assert.match(problem, /nodeNameProblem\(row\.name\)/,
            "a restored node row is held to a different rule than a created one");
    });

    // The url and the password are the same column type as the name, and a
    // restore that held only the name to it refused the whole backup on
    // ER_DATA_TOO_LONG with nothing naming the row.
    it("hold the url and the password to the same column", () => {
        const problem = bodyOf(readSource("server/controller/config.js"), "const nodeProblem = ");

        assert.match(problem, /row\.url\.length > NODE_NAME_LIMIT/);
        assert.match(problem, /row\.password\.length > NODE_NAME_LIMIT/);
    });
});
