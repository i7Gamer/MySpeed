import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { validateInput } from "../../server/controller/config.js";

/**
 * The ping threshold keeps its fraction, like the two beside it.
 *
 * THRESHOLD_NUMBER admits decimals for all three keys, and the stored value is
 * what validateInput returns - but ping alone was then cut at its dot: 5.5 was
 * stored as 5, and ".5" - a value the rule deliberately accepts - was stored
 * as the empty string. Measured pings have been DOUBLE since migration 0010
 * and the recommended ping since 0012, so "use recommended" on a fibre line
 * handed this a 0.4 and stored a 0: a threshold no latency is ever under,
 * behind a dialog that said "changes applied".
 */
describe("a fractional threshold", () => {
    for (const key of ["ping", "download", "upload"]) {
        it(`${key} keeps its fraction`, async () => {
            assert.deepEqual(await validateInput(key, "5.5"), {value: "5.5"});
        });
    }

    // The spelling the shared rule goes out of its way to accept - cutting it
    // at the dot stored an empty value, which reads as "no threshold at all".
    it("keeps a bare-dot fraction whole", async () => {
        assert.deepEqual(await validateInput("ping", ".5"), {value: ".5"});
    });

    it("keeps an integer exactly as it came", async () => {
        assert.deepEqual(await validateInput("ping", "25"), {value: "25"});
    });

    it("still refuses what is not a number", async () => {
        for (const value of ["5.5.5", "..", "5,5", "fast"])
            assert.equal(typeof await validateInput("ping", value), "string",
                `"${value}" was accepted as a threshold`);
    });
});
