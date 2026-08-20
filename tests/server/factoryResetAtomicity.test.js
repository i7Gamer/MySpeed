import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { bodyOf, readSource } from "../helpers/source.js";

/**
 * A factory reset either happened or it did not.
 *
 * The transaction covered the config table alone - clear and re-seed - while
 * the node, recommendation and integration tables were cleared afterwards,
 * each on its own implicit commit. A failure among those three left an
 * instance whose configuration says "factory fresh" beside tables that still
 * carry the old install: nodes that keep polling, integrations that keep
 * firing against defaults they were never configured for. The route answers
 * 500 for that, so the operator retries a reset that half-happened - or
 * trusts the error and is left with the mixture.
 *
 * Read as source rather than run, the way the write-ordering tests are: firing
 * a real reset needs a database, a timer and the session store, and what is
 * asserted is only which statements share the transaction.
 */
const body = bodyOf(readSource("server/controller/config.js"), "export const factoryReset");
const transactionBlock = bodyOf(body, "db.transaction");

const TABLES = ["config", "node", "recommendations", "integration"];

describe("the factory reset", () => {
    for (const model of TABLES) {
        it(`clears ${model} inside the transaction, on the transaction`, () => {
            assert.match(transactionBlock, new RegExp(`${model}\\.destroy\\(\\{[^)]*transaction[^)]*\\)`),
                `${model} is cleared on its own commit, outside the all-or-nothing`);
        });
    }

    it("re-seeds the defaults inside the same transaction", () => {
        assert.match(transactionBlock, /insertDefaults\(transaction\)/);
    });

    it("clears nothing outside it", () => {
        const clears = (text) => (text.match(/\w+\.destroy\(\{/g) ?? []).length;

        assert.equal(clears(body), TABLES.length, "a table is cleared somewhere this test is not looking");
        assert.equal(clears(transactionBlock), TABLES.length,
            "a clear has moved back outside the transaction");
    });

    /**
     * Revoked only once the reset is real. Thrown out of the transaction, the
     * old configuration - password included - is still standing, and logging
     * everyone out of an instance that did not reset revokes access the
     * password still guards.
     */
    it("revokes the sessions after the commit, not before it", () => {
        const committed = body.indexOf(transactionBlock) + transactionBlock.length;
        const revoked = body.indexOf("destroyAllSessions()");

        assert.notEqual(revoked, -1, "the reset no longer revokes the sessions at all");
        assert.ok(revoked > committed, "the sessions are revoked before the reset is known to have happened");
    });
});
