import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolveInterfaces } from "../../server/util/loadInterfaces.js";

/**
 * The interface map is module state that the hourly sweep refreshes, and it
 * only ever grew.
 *
 * Nothing deleted the key for an adapter that was no longer there, so a VPN
 * that went down stayed in GET /api/info/interfaces, stayed accepted by
 * updateValue("interface"), and - because the stale key made
 * `if (!interfaces[current])` false - defeated the very fallback that exists
 * for this. Every scheduled test then kept binding to an address that was gone.
 *
 * The prune is keyed on the adapter being absent from the operating system, not
 * on this round's probe: a live interface whose Cloudflare probe happened to
 * fail is still there, and dropping it would fire the one-way fallback and
 * overwrite the operator's pinned choice for good.
 */
describe("resolveInterfaces", () => {
    it("keeps an adapter the probe reached", () => {
        const next = resolveInterfaces({}, {eth0: ["192.168.1.2"]}, ["eth0"]);

        assert.deepEqual(next, {eth0: "192.168.1.2"});
    });

    it("drops an adapter the operating system no longer reports", () => {
        const next = resolveInterfaces({eth0: "192.168.1.2", tun0: "10.8.0.2"},
            {eth0: ["192.168.1.2"]}, ["eth0"]);

        assert.deepEqual(next, {eth0: "192.168.1.2"});
    });

    // The distinction that matters: a probe can fail for a moment on an
    // interface that is perfectly present.
    it("keeps an adapter that is still there but did not answer this round", () => {
        const next = resolveInterfaces({eth0: "192.168.1.2", wlan0: "192.168.1.9"},
            {eth0: ["192.168.1.2"]}, ["eth0", "wlan0"]);

        assert.deepEqual(next, {eth0: "192.168.1.2", wlan0: "192.168.1.9"});
    });

    it("prefers an IPv4 address when the adapter has both", () => {
        const next = resolveInterfaces({}, {eth0: ["fe80::1", "192.168.1.2"]}, ["eth0"]);

        assert.equal(next.eth0, "192.168.1.2");
    });

    it("takes the only address when it is IPv6", () => {
        const next = resolveInterfaces({}, {eth0: ["2001:db8::1"]}, ["eth0"]);

        assert.equal(next.eth0, "2001:db8::1");
    });

    /**
     * The second half of the same bug. The fallback that picks an address read
     * the *stored* map rather than this round's result, so once an adapter had
     * an IPv4 address it could never be updated to an IPv6-only one - the very
     * case that happens when a dual-stack interface loses its v4 lease.
     */
    it("replaces a stored IPv4 with the address the adapter now has", () => {
        const next = resolveInterfaces({eth0: "192.168.1.2"}, {eth0: ["2001:db8::1"]}, ["eth0"]);

        assert.equal(next.eth0, "2001:db8::1");
    });

    it("changes nothing when the round found the same addresses", () => {
        const previous = {eth0: "192.168.1.2"};

        assert.deepEqual(resolveInterfaces(previous, {eth0: ["192.168.1.2"]}, ["eth0"]), previous);
    });

    it("empties the map when every adapter is gone", () => {
        assert.deepEqual(resolveInterfaces({tun0: "10.8.0.2"}, {}, []), {});
    });
});
