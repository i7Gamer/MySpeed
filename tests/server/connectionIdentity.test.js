import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { stripConnectionIdentity } from "../../server/util/connectionIdentity.js";

/**
 * Who the connection is - the operator's provider and external address - is
 * stored for the operator and withheld from read-only viewers: an instance
 * shared as a public dashboard must not tell every visitor where its owner
 * lives on the network.
 */
describe("stripConnectionIdentity", () => {
    const row = () => ({id: 1, ping: 10, isp: "Salt Mobile", externalIp: "203.0.113.7",
        resultId: "f2cfac79", error: null});

    it("nulls the provider and the address", () => {
        const stripped = stripConnectionIdentity(row());

        assert.equal(stripped.isp, null);
        assert.equal(stripped.externalIp, null);
    });

    /**
     * The result id is identity through a side door: it links to the
     * provider's public result page, which names the ISP and the rough
     * location - the very things the masking withholds.
     *
     * Deleted rather than nulled, unlike the other two, because absence is
     * what a row without a result already looks like: every list path strips
     * a null resultId key, so a null here would say "there is a result you
     * cannot see" where deletion says nothing at all.
     */
    it("removes the link to the provider's public result page", () => {
        const stripped = stripConnectionIdentity(row());

        assert.equal("resultId" in stripped, false);
    });

    it("touches nothing else", () => {
        const {isp, externalIp, ...rest} = stripConnectionIdentity(row());

        assert.deepEqual(rest, {id: 1, ping: 10, error: null});
    });

    // The routes hand the same object on to res.json, so the contract is
    // mutate-in-place and return it.
    it("mutates and returns the same object", () => {
        const original = row();

        assert.equal(stripConnectionIdentity(original), original);
        assert.equal(original.isp, null);
    });

    // Null rather than deleted, and set even where the column never existed: a
    // masked row must be byte-identical to one that never measured anything, or
    // the response itself tells a viewer that something was withheld.
    it("makes a masked row indistinguishable from an unmeasured one", () => {
        const stripped = stripConnectionIdentity({id: 2, ping: 12});

        assert.equal(stripped.isp, null);
        assert.equal(stripped.externalIp, null);
        assert.equal("resultId" in stripped, false);
    });

    // The status route builds `lastTest: null` on an install that has never run
    // a test, and masking must not turn that into a crash.
    it("passes a missing row through", () => {
        assert.equal(stripConnectionIdentity(null), null);
        assert.equal(stripConnectionIdentity(undefined), undefined);
    });
});
