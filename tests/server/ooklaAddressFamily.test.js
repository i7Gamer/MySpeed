import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { bodyOf, readSource } from "../helpers/source.js";
import { DNS_TIMEOUT_MS, DNS_TRIES, hasGlobalIpv6, hostName, isIpv4Only, ipv4OnlyServerId, ooklaServerFor }
    from "../../server/util/providers/ooklaAddressFamily.js";

/**
 * The Ookla CLI on Windows is bound by address (--interface cannot bind
 * there), and MySpeed binds it to the interface's IPv4 address. On a host
 * that also has a global IPv6 address the CLI opens a server's AAAA record
 * first, cannot reach it from an IPv4 socket, and gives up with "Cannot open
 * socket" instead of trying the A record. These pin the way round that: an
 * unpinned run is pointed at the nearest server that has no AAAA at all.
 */

const failure = (code) => Object.assign(new Error(code), {code});

// A resolver answering from a table: host -> {a, aaaa}, each an address list
// or an error code. A host missing from the table does not exist.
const fakeResolver = (table) => {
    const answer = (host, family) => {
        const entry = table[host];
        if (!entry) return Promise.reject(failure("ENOTFOUND"));

        const value = entry[family];
        return typeof value === "string" ? Promise.reject(failure(value)) : Promise.resolve(value);
    };

    return {resolve4: (host) => answer(host, "a"), resolve6: (host) => answer(host, "aaaa")};
};

const V4 = ["192.0.2.10"];
const V6 = ["2001:db8::10"];

const IPV4 = {address: "192.168.1.24", family: "IPv4", internal: false};
const GLOBAL_V6 = {address: "2001:db8:1::24", family: "IPv6", internal: false};
const LINK_LOCAL_V6 = {address: "fe80::1", family: "IPv6", internal: false};
const LOOPBACK_V6 = {address: "::1", family: "IPv6", internal: true};

describe("whether the host has a global IPv6 address", () => {
    it("is true for a non-internal, non-link-local IPv6 address", () => {
        assert.equal(hasGlobalIpv6({eth: [IPV4, GLOBAL_V6]}), true);
    });

    it("reads the numeric family older Node versions report", () => {
        assert.equal(hasGlobalIpv6({eth: [{...GLOBAL_V6, family: 6}]}), true);
    });

    it("ignores link-local and loopback addresses", () => {
        assert.equal(hasGlobalIpv6({eth: [IPV4, LINK_LOCAL_V6], lo: [LOOPBACK_V6]}), false);
        assert.equal(hasGlobalIpv6({eth: [{...LINK_LOCAL_V6, address: "FE80::abcd"}]}), false);
    });

    it("is false for an IPv4-only host and for no interfaces at all", () => {
        assert.equal(hasGlobalIpv6({eth: [IPV4]}), false);
        assert.equal(hasGlobalIpv6({}), false);
        assert.equal(hasGlobalIpv6(undefined), false);
    });
});

describe("the host name of a listed server", () => {
    it("drops the port", () => {
        assert.equal(hostName("speedtest.example.net:8080"), "speedtest.example.net");
    });

    it("leaves a bare name alone", () => {
        assert.equal(hostName("speedtest.example.net"), "speedtest.example.net");
    });

    it("unwraps a bracketed IPv6 literal", () => {
        assert.equal(hostName("[2001:db8::1]:8080"), "2001:db8::1");
    });
});

describe("whether a server is reachable over IPv4 only", () => {
    it("is true with an A record and no AAAA", async () => {
        assert.equal(await isIpv4Only("a.test:8080", fakeResolver({"a.test": {a: V4, aaaa: "ENODATA"}})), true);
    });

    // Bun answers a name with no AAAA with ENOTFOUND, where Node says ENODATA.
    // The A record already proved the name exists, so both mean "no AAAA".
    it("takes Bun's ENOTFOUND for a missing AAAA the same way", async () => {
        assert.equal(await isIpv4Only("a.test", fakeResolver({"a.test": {a: V4, aaaa: "ENOTFOUND"}})), true);
    });

    it("takes an empty AAAA answer as none", async () => {
        assert.equal(await isIpv4Only("a.test", fakeResolver({"a.test": {a: V4, aaaa: []}})), true);
    });

    it("is false when the server also has an AAAA record", async () => {
        assert.equal(await isIpv4Only("a.test", fakeResolver({"a.test": {a: V4, aaaa: V6}})), false);
    });

    it("is false with an AAAA record and no A", async () => {
        assert.equal(await isIpv4Only("a.test", fakeResolver({"a.test": {a: "ENODATA", aaaa: V6}})), false);
        assert.equal(await isIpv4Only("a.test", fakeResolver({"a.test": {a: [], aaaa: V6}})), false);
    });

    it("is false when the name does not resolve", async () => {
        assert.equal(await isIpv4Only("gone.test", fakeResolver({})), false);
    });

    // A timeout or SERVFAIL says nothing about whether an AAAA exists, so the
    // server is not trusted to be IPv4 only.
    it("is false when the AAAA lookup fails for any other reason", async () => {
        for (const code of ["ETIMEOUT", "ESERVFAIL", "ECONNREFUSED"])
            assert.equal(await isIpv4Only("a.test", fakeResolver({"a.test": {a: V4, aaaa: code}})), false, code);
    });

    it("answers an address literal without asking DNS", async () => {
        const resolver = {resolve4: () => assert.fail("asked DNS"), resolve6: () => assert.fail("asked DNS")};

        assert.equal(await isIpv4Only("192.0.2.1:8080", resolver), true);
        assert.equal(await isIpv4Only("[2001:db8::1]:8080", resolver), false);
    });

    it("is false for a server with no host", async () => {
        assert.equal(await isIpv4Only(undefined, fakeResolver({})), false);
        assert.equal(await isIpv4Only("", fakeResolver({})), false);
    });
});

describe("the nearest IPv4-only server", () => {
    const servers = {
        "10": {distance: 5, host: "dual.test:8080"},
        "20": {distance: 9, host: "far-v4.test:8080"},
        "30": {distance: 7, host: "near-v4.test:8080"},
        "40": {distance: 1, host: "gone.test:8080"}
    };
    const resolver = fakeResolver({
        "dual.test": {a: V4, aaaa: V6},
        "near-v4.test": {a: V4, aaaa: "ENODATA"},
        "far-v4.test": {a: V4, aaaa: "ENODATA"}
    });

    // The list is keyed by id, which JavaScript orders numerically - so the
    // distance has to be read, not the key order.
    it("is chosen by distance, not by id", async () => {
        assert.equal(await ipv4OnlyServerId(servers, resolver), "30");
    });

    it("skips servers whose distance is unknown until the known ones are tried", async () => {
        const list = {"1": {host: "far-v4.test"}, "2": {distance: 3, host: "near-v4.test"}};

        assert.equal(await ipv4OnlyServerId(list, resolver), "2");
        assert.equal(await ipv4OnlyServerId({"1": {host: "far-v4.test"}}, resolver), "1");
    });

    it("is none when every server has an AAAA record or does not resolve", async () => {
        assert.equal(await ipv4OnlyServerId({"10": servers["10"], "40": servers["40"]}, resolver), undefined);
    });

    it("is none for an empty or missing list", async () => {
        assert.equal(await ipv4OnlyServerId({}, resolver), undefined);
        assert.equal(await ipv4OnlyServerId(undefined, resolver), undefined);
    });

    it("skips malformed entries", async () => {
        assert.equal(await ipv4OnlyServerId({"1": null, "2": {distance: 1}, "3": servers["30"]}, resolver), "3");
    });

    it("survives a resolver that throws instead of rejecting", async () => {
        const throwing = {resolve4: () => { throw new Error("boom"); }, resolve6: () => { throw new Error("boom"); }};

        assert.equal(await ipv4OnlyServerId(servers, throwing), undefined);
    });
});

describe("the server an Ookla run measures against", () => {
    const servers = {"30": {distance: 7, host: "near-v4.test:8080"}, "10": {distance: 5, host: "dual.test:8080"}};
    const resolver = fakeResolver({"dual.test": {a: V4, aaaa: V6}, "near-v4.test": {a: V4, aaaa: "ENODATA"}});
    const dualStack = {eth: [IPV4, GLOBAL_V6]};
    const base = {mode: "ookla", platform: "win32", address: IPV4.address, interfacesNode: dualStack,
        servers, resolver, log: () => {}};

    it("is the nearest IPv4-only server for an unpinned run bound to IPv4 on a dual-stack Windows host",
        async () => {
            assert.equal(await ooklaServerFor({...base}), "30");
        });

    it("keeps a pinned server, which is the operator's own choice", async () => {
        assert.equal(await ooklaServerFor({...base, serverId: "10"}), "10");
    });

    it("keeps a custom endpoint's run unpinned", async () => {
        assert.equal(await ooklaServerFor({...base, serverUrl: "https://speed.test"}), undefined);
    });

    it("leaves other providers alone", async () => {
        assert.equal(await ooklaServerFor({...base, mode: "libre"}), undefined);
    });

    // Linux binds by interface name, which carries both families.
    it("leaves other platforms alone", async () => {
        assert.equal(await ooklaServerFor({...base, platform: "linux"}), undefined);
    });

    it("leaves a run bound to an IPv6 address alone", async () => {
        assert.equal(await ooklaServerFor({...base, address: GLOBAL_V6.address}), undefined);
    });

    // Without a global IPv6 address Windows hands out no AAAA records, so the
    // provider's own (latency-based) choice is kept.
    it("leaves an IPv4-only host alone", async () => {
        assert.equal(await ooklaServerFor({...base, interfacesNode: {eth: [IPV4, LINK_LOCAL_V6]}}), undefined);
    });

    it("falls back to the provider's choice when no server is IPv4 only", async () => {
        assert.equal(await ooklaServerFor({...base, servers: {"10": servers["10"]}}), undefined);
    });

    it("says which server it chose, and when it found none", async () => {
        const lines = [];

        await ooklaServerFor({...base, log: (line) => lines.push(line)});
        await ooklaServerFor({...base, servers: {}, log: (line) => lines.push(line)});

        assert.match(lines[0], /30/);
        assert.match(lines[1], /no .*IPv4/i);
    });
});

describe("the lookup budget", () => {
    it("bounds each lookup so a silent DNS server cannot stall the run", () => {
        assert.ok(DNS_TIMEOUT_MS > 0 && DNS_TIMEOUT_MS <= 5000);
        assert.equal(DNS_TRIES, 1);
    });
});

describe("the runner", () => {
    const run = bodyOf(readSource("server/util/speedtest.js"), "export default async (mode");

    it("asks for the server before it builds the arguments", () => {
        const choice = run.indexOf("await ooklaServerFor(");
        assert.ok(choice > 0, "the runner never asks which server an Ookla run should use");
        assert.ok(choice < run.indexOf("provider.buildArgs("), "the server is chosen after the arguments were built");
    });
});
