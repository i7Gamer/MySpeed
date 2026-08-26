import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolveInterfaces, externalAddresses, preferAnswered } from "../../server/util/loadInterfaces.js";
import { bodyIn } from "../helpers/source.js";

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

/**
 * The probe's answer is a preference, not the price of admission.
 *
 * An adapter whose request to Cloudflare failed was not listed at all, which
 * conflated "can reach one CDN at boot" with "exists". A docker bridge with
 * restrictive DNS, an ipvlan without a route to that CDN, a firewall blocking
 * exactly that host (upstream #806) all run speedtests fine and were
 * invisible - and the invisibility cascaded: insertDefaults seeded "none",
 * validateInput refused the adapter's name when the operator typed it, and
 * every run threw "no usable address" before the CLI could say what was
 * actually wrong. externalAddresses is the probe-free listing that closes
 * that; the shape mirrors os.networkInterfaces().
 */
describe("externalAddresses", () => {
    const entry = (address, internal = false) =>
        ({address, internal, family: address.includes(".") ? "IPv4" : "IPv6"});

    it("lists an adapter the probe would have skipped", () => {
        assert.deepEqual(externalAddresses({eth0: [entry("192.168.1.2")]}),
            {eth0: "192.168.1.2"});
    });

    it("never lists an adapter with only internal addresses", () => {
        assert.deepEqual(externalAddresses({lo: [entry("127.0.0.1", true)]}), {});
    });

    it("prefers an IPv4 address when the adapter has both", () => {
        const external = externalAddresses({eth0: [entry("fe80::1"), entry("192.168.1.2")]});

        assert.equal(external.eth0, "192.168.1.2");
    });

    it("takes the only address when it is IPv6", () => {
        assert.equal(externalAddresses({eth0: [entry("2001:db8::1")]}).eth0, "2001:db8::1");
    });

    it("answers empty for no adapters at all", () => {
        assert.deepEqual(externalAddresses({}), {});
    });
});

/**
 * With unprobed adapters in the map, resolveFallback's available[0] pick
 * needs an order: a fresh install on a healthy network must still land on an
 * adapter that demonstrably reaches the internet, and only fall to a
 * merely-present one when nothing answered at all.
 */
describe("preferAnswered", () => {
    it("puts the adapters that answered ahead of the merely present", () => {
        assert.deepEqual(preferAnswered(["eth0"], ["docker0", "eth0", "wlan0"]),
            ["eth0", "docker0", "wlan0"]);
    });

    it("keeps every name when nothing answered", () => {
        assert.deepEqual(preferAnswered([], ["docker0", "eth0"]), ["docker0", "eth0"]);
    });

    it("names an answered adapter once, not twice", () => {
        assert.deepEqual(preferAnswered(["eth0"], ["eth0"]), ["eth0"]);
    });
});

/**
 * And the refresh actually routes through both. Read from the source because
 * requestInterfaces reaches os.networkInterfaces() and the configuration
 * directly; what is asserted is that the probe-free listing feeds the map and
 * that the fallback chooses from the answered-first order.
 */
describe("the hourly refresh", () => {
    const requestInterfaces = bodyIn("server/util/loadInterfaces.js", "export const requestInterfaces");

    it("admits the adapters the probe could not vouch for", () => {
        assert.match(requestInterfaces, /externalAddresses\(interfacesNode\)/,
            "unprobed adapters are no longer listed, and upstream #806 is back");
    });

    it("hands the fallback the answered adapters first", () => {
        assert.match(requestInterfaces, /preferAnswered\(Object\.keys\(interfacesResult\)/,
            "the fallback would pick a merely-present adapter over one that answered");
    });
});
