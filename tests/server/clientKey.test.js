import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { clientKey, normaliseAddress } from "../../server/util/clientKey.js";

/**
 * Both the request limiter and the failed-password throttle count against this,
 * so it decides who "one caller" is. Too narrow and the limits are bypassable;
 * too broad and unrelated people share a budget.
 */
describe("normaliseAddress", () => {
    it("passes an IPv4 address through", () => {
        assert.equal(normaliseAddress("203.0.113.5"), "203.0.113.5");
        assert.equal(normaliseAddress("127.0.0.1"), "127.0.0.1");
    });

    // The same caller must not get a second budget by arriving in mapped form.
    it("treats a mapped IPv4 address as that IPv4 address", () => {
        assert.equal(normaliseAddress("::ffff:203.0.113.5"), "203.0.113.5");
        assert.equal(normaliseAddress("::ffff:203.0.113.5"), normaliseAddress("203.0.113.5"));
    });

    /**
     * Regression: the key was the whole IPv6 address. A home allocation is a
     * /64 - eighteen quintillion addresses, one customer - so picking a fresh
     * address per request meant no counter ever reached two, and both limiters
     * were free to walk past.
     */
    it("collapses an IPv6 address to its /64", () => {
        const first = normaliseAddress("2001:db8:1234:5678:9abc:def0:1234:5678");
        const second = normaliseAddress("2001:db8:1234:5678:aaaa:bbbb:cccc:dddd");

        assert.equal(first, "2001:db8:1234:5678");
        assert.equal(first, second, "two addresses in one /64 counted separately");
    });

    it("keeps separate /64s apart", () => {
        assert.notEqual(
            normaliseAddress("2001:db8:1234:5678::1"),
            normaliseAddress("2001:db8:1234:9999::1")
        );
    });

    it("handles an elided address", () => {
        assert.equal(normaliseAddress("2001:db8::1"), "2001:db8:0:0");
        assert.equal(normaliseAddress("2001:db8::1"), normaliseAddress("2001:db8::2"));
    });

    // One /64, four spellings, one key. The prefix used to be cut from the
    // text as written, so the elided, the zero-padded and the bare spellings of
    // one network answered three keys - three throttle budgets for one caller
    // who reaches req.ip through a trusted proxy and can spell the address.
    it("keys every spelling of one prefix the same", () => {
        const spellings = ["2001:db8::1", "2001:0db8:0000:0000:0000:0000:0000:0001",
            "2001:db8:0:0:0:0:0:1", "2001:DB8:0:0::1", "2001:db8:0:0::"];
        const keys = new Set(spellings.map(normaliseAddress));

        assert.deepEqual([...keys], ["2001:db8:0:0"]);
        assert.equal(normaliseAddress("2001:0db8:1234:0099:aaaa:bbbb:cccc:dddd"), "2001:db8:1234:99");
        assert.equal(normaliseAddress("::1"), "0:0:0:0");
    });

    it("handles a fully written address with zero groups", () => {
        assert.equal(normaliseAddress("2001:db8:1234:9999:0:0:0:1"), "2001:db8:1234:9999");
    });

    // fe80::1%eth0 and fe80::1 are the same caller; the zone would be a free
    // extra bucket.
    it("ignores the zone identifier", () => {
        assert.equal(normaliseAddress("fe80::1%eth0"), normaliseAddress("fe80::1"));
    });

    it("is case-insensitive", () => {
        assert.equal(normaliseAddress("2001:DB8:1234:5678::1"), normaliseAddress("2001:db8:1234:5678::1"));
    });
});

describe("clientKey", () => {
    it("prefers the resolved address", () => {
        assert.equal(clientKey({ip: "203.0.113.5", socket: {remoteAddress: "127.0.0.1"}}), "203.0.113.5");
    });

    it("falls back to the transport address", () => {
        assert.equal(clientKey({socket: {remoteAddress: "::ffff:198.51.100.7"}}), "198.51.100.7");
    });

    // Everything unidentifiable shares one bucket rather than each getting a
    // free pass of its own.
    it("gives an unidentifiable caller a single shared key", () => {
        assert.equal(clientKey({}), "unknown");
        assert.equal(clientKey({socket: {}}), "unknown");
        assert.equal(clientKey(undefined), "unknown");
        assert.equal(clientKey({ip: ""}), "unknown");
    });
});
