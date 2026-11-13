import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolveInterfaces, externalAddresses, preferAnswered } from "../../server/util/loadInterfaces.js";
import { bodyIn, readSource } from "../helpers/source.js";

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
    const addresses = (...values) => values.map((address) => ({address, internal: false}));

    it("keeps an adapter the probe reached", () => {
        const next = resolveInterfaces({}, {eth0: ["192.168.1.2"]}, {eth0: addresses("192.168.1.2")});

        assert.deepEqual(next, {eth0: "192.168.1.2"});
    });

    it("drops an adapter the operating system no longer reports", () => {
        const next = resolveInterfaces({eth0: "192.168.1.2", tun0: "10.8.0.2"},
            {eth0: ["192.168.1.2"]}, {eth0: addresses("192.168.1.2")});

        assert.deepEqual(next, {eth0: "192.168.1.2"});
    });

    // The distinction that matters: a probe can fail for a moment on an
    // interface that is perfectly present.
    it("keeps an adapter that is still there but did not answer this round", () => {
        const next = resolveInterfaces({eth0: "192.168.1.2", wlan0: "192.168.1.9"},
            {eth0: ["192.168.1.2"]}, {eth0: addresses("192.168.1.2"), wlan0: addresses("192.168.1.9")});

        assert.deepEqual(next, {eth0: "192.168.1.2", wlan0: "192.168.1.9"});
    });

    it("prefers an IPv4 address when the adapter has both", () => {
        const next = resolveInterfaces({}, {eth0: ["fe80::1", "192.168.1.2"]},
            {eth0: addresses("fe80::1", "192.168.1.2")});

        assert.equal(next.eth0, "192.168.1.2");
    });

    it("takes the only address when it is IPv6", () => {
        const next = resolveInterfaces({}, {eth0: ["2001:db8::1"]}, {eth0: addresses("2001:db8::1")});

        assert.equal(next.eth0, "2001:db8::1");
    });

    /**
     * The second half of the same bug. The fallback that picks an address read
     * the *stored* map rather than this round's result, so once an adapter had
     * an IPv4 address it could never be updated to an IPv6-only one - the very
     * case that happens when a dual-stack interface loses its v4 lease.
     */
    it("replaces a stored IPv4 with the address the adapter now has", () => {
        const next = resolveInterfaces({eth0: "192.168.1.2"}, {eth0: ["2001:db8::1"]},
            {eth0: addresses("2001:db8::1")});

        assert.equal(next.eth0, "2001:db8::1");
    });

    /**
     * The other side of that rule. A dual-stack adapter whose IPv4 probe
     * missed one round while its IPv6 one answered was repointed at IPv6 for
     * the hour until the next round - and the Ookla CLI, whose configuration
     * endpoint is IPv4 only, failed every run in that hour with "Could not
     * retrieve or read configuration (Network is unreachable)". Twelve of
     * twelve such failures on a Windows install were runs bound to the
     * adapter's IPv6 address. A lost lease takes the address off the adapter;
     * a missed probe does not, and only the first is a reason to change family.
     */
    describe("when only IPv6 answered on an adapter that had IPv4", () => {
        const V4 = "192.168.1.24";
        const V6 = "2001:db8::bd78";

        it("keeps the IPv4 address while the adapter still has it", () => {
            const next = resolveInterfaces({eth0: V4}, {eth0: [V6]}, {eth0: addresses(V4, V6)});

            assert.equal(next.eth0, V4);
        });

        it("comes through a missed round and back on the same address", () => {
            const present = {eth0: addresses(V4, V6)};

            const first = resolveInterfaces({}, {eth0: [V4, V6]}, present);
            const missed = resolveInterfaces(first, {eth0: [V6]}, present);
            const recovered = resolveInterfaces(missed, {eth0: [V4, V6]}, present);

            assert.deepEqual([first.eth0, missed.eth0, recovered.eth0], [V4, V4, V4]);
        });

        it("moves to IPv6 once the IPv4 address is gone from the adapter", () => {
            const next = resolveInterfaces({eth0: V4}, {eth0: [V6]}, {eth0: addresses(V6)});

            assert.equal(next.eth0, V6);
        });

        it("moves to the adapter's new IPv4 address when that is the one answering", () => {
            const NEW_V4 = "192.168.1.30";
            const next = resolveInterfaces({eth0: V4}, {eth0: [NEW_V4, V6]}, {eth0: addresses(V4, NEW_V4, V6)});

            assert.equal(next.eth0, NEW_V4);
        });

        // Nothing stored means nothing was ever shown to work over IPv4, so
        // there is no address to hold on to and the answer is taken as it is.
        it("takes IPv6 when nothing was stored for the adapter", () => {
            const next = resolveInterfaces({}, {eth0: [V6]}, {eth0: addresses(V4, V6)});

            assert.equal(next.eth0, V6);
        });

        it("leaves an adapter already on IPv6 there", () => {
            const next = resolveInterfaces({eth0: V6}, {eth0: [V6]}, {eth0: addresses(V4, V6)});

            assert.equal(next.eth0, V6);
        });

        // 169.254/16 is what an adapter gives itself when DHCP did not answer,
        // and it routes nowhere - holding it would pin the adapter to a dead
        // address while IPv6 works.
        it("does not hold a self-assigned link-local IPv4 address", () => {
            const LINK_LOCAL_V4 = "169.254.12.34";
            const next = resolveInterfaces({eth0: LINK_LOCAL_V4}, {eth0: [V6]},
                {eth0: addresses(LINK_LOCAL_V4, V6)});

            assert.equal(next.eth0, V6);
        });

        it("only holds the adapter whose own IPv4 is still assigned", () => {
            const next = resolveInterfaces({eth0: V4, wlan0: "192.168.1.40"},
                {eth0: [V6], wlan0: ["2001:db8::40"]},
                {eth0: addresses(V4, V6), wlan0: addresses("2001:db8::40")});

            assert.deepEqual(next, {eth0: V4, wlan0: "2001:db8::40"});
        });
    });

    it("changes nothing when the round found the same addresses", () => {
        const previous = {eth0: "192.168.1.2"};

        assert.deepEqual(resolveInterfaces(previous, {eth0: ["192.168.1.2"]},
            {eth0: addresses("192.168.1.2")}), previous);
    });

    it("empties the map when every adapter is gone", () => {
        assert.deepEqual(resolveInterfaces({tun0: "10.8.0.2"}, {}, {}), {});
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

    // The config read and write at the end of a refresh can reject on a
    // database outage. The retention sweep on the line below already says
    // what failed; this one reached the process-level hook and was logged as
    // a bare server fault naming nothing.
    it("names its own failure when the interval run rejects", () => {
        const source = readSource("server/index.js");
        const line = source.split("\n").find((candidate) => candidate.includes("setInterval(() => requestInterfaces()"));

        assert.ok(line, "the refresh is no longer scheduled from index.js");
        assert.match(line, /\.catch\(/, "a refresh that rejects is logged as a bare server fault");
    });

    it("admits the adapters the probe could not vouch for", () => {
        assert.match(requestInterfaces, /externalAddresses\(interfacesNode\)/,
            "unprobed adapters are no longer listed, and upstream #806 is back");
    });

    it("hands the fallback the answered adapters first", () => {
        assert.match(requestInterfaces, /preferAnswered\(Object\.keys\(interfacesResult\)/,
            "the fallback would pick a merely-present adapter over one that answered");
    });
});
