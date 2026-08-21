import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { checkNodeTarget, isBlockedAddress, isMetadataAddress } from "../../server/util/safeUrl.js";

/**
 * The IPv6 metadata endpoint, refused on the node path too.
 *
 * fd00:ec2::254 is where AWS answers IMDS over IPv6, and it sits in
 * Unique-Local space rather than link-local - so the range checks that catch
 * 169.254.169.254 and fe80::/10 walked straight past it. Blocked as one
 * address rather than as a range, because fd00::/8 is the IPv6 LAN and a node
 * on one is ordinary.
 */
describe("the IPv6 metadata address", () => {
    it("is blocked in every spelling", () => {
        for (const spelling of ["fd00:ec2::254", "fd00:ec2:0:0:0:0:0:254", "FD00:EC2::0254"])
            assert.equal(isBlockedAddress(spelling), true, `${spelling} is not recognised`);
    });

    it("is recognised on its own, so both guards can share the rule", () => {
        assert.equal(isMetadataAddress("fd00:ec2::254"), true);
        assert.equal(isMetadataAddress("169.254.169.254"), true);
        assert.equal(isMetadataAddress("fd00::1234"), false);
    });

    it("leaves the rest of the Unique-Local range alone", () => {
        assert.equal(isBlockedAddress("fd00::1234"), false);
        assert.equal(isBlockedAddress("fd12:3456:789a::1"), false);
    });

    it("refuses a node pointed at it", async () => {
        const {safe, reason} = await checkNodeTarget("http://[fd00:ec2::254]:5216");

        assert.equal(safe, false);
        assert.match(reason, /metadata|loopback or link-local/i);
    });
});

const originalOptOut = process.env.ALLOW_LOCAL_NODES;

beforeEach(() => { delete process.env.ALLOW_LOCAL_NODES; });

afterEach(() => {
    if (originalOptOut === undefined) delete process.env.ALLOW_LOCAL_NODES;
    else process.env.ALLOW_LOCAL_NODES = originalOptOut;
});

describe("isBlockedAddress", () => {
    describe("blocked", () => {
        const blocked = [
            "127.0.0.1", "127.1.2.3", "0.0.0.0",
            // The AWS/GCP/Azure metadata endpoint, and the range it sits in.
            "169.254.169.254", "169.254.0.1",
            "::1", "::", "fe80::1", "FE80::1", "febf::1",
            "::ffff:127.0.0.1"
        ];

        for (const address of blocked)
            it(`refuses ${address}`, () => assert.equal(isBlockedAddress(address), true));
    });

    describe("allowed", () => {
        // Private ranges are the normal case for this feature: a second MySpeed
        // on the same LAN.
        const allowed = [
            "192.168.1.50", "10.0.0.5", "172.16.0.1",
            "8.8.8.8", "1.1.1.1",
            "2606:4700:4700::1111", "fd00::1", "fec0::1"
        ];

        for (const address of allowed)
            it(`permits ${address}`, () => assert.equal(isBlockedAddress(address), false));
    });

    describe("non-addresses", () => {
        it("does not treat a hostname as an address", () => {
            assert.equal(isBlockedAddress("example.com"), false);
        });

        it("handles empty and non-string input", () => {
            for (const value of ["", null, undefined, 42, {}])
                assert.equal(isBlockedAddress(value), false);
        });

        // "999.1.1.1" is not a v4 address at all; it must not be mistaken for one.
        it("ignores a malformed dotted quad", () => {
            assert.equal(isBlockedAddress("999.1.1.1"), false);
        });
    });
});

describe("checkNodeTarget", () => {
    describe("protocol", () => {
        it("accepts http", async () => {
            assert.deepEqual(await checkNodeTarget("http://192.168.1.50:5216"), {safe: true});
        });

        it("accepts https", async () => {
            assert.deepEqual(await checkNodeTarget("https://192.168.1.50:5216"), {safe: true});
        });

        for (const value of ["file:///etc/passwd", "ftp://example.com", "gopher://example.com"])
            it(`refuses ${value}`, async () => {
                const result = await checkNodeTarget(value);
                assert.equal(result.safe, false);
                assert.match(result.reason, /http or https/);
            });
    });

    describe("malformed input", () => {
        for (const value of ["", "not a url", "://missing-scheme"])
            it(`refuses ${JSON.stringify(value)}`, async () => {
                assert.equal((await checkNodeTarget(value)).safe, false);
            });
    });

    describe("blocked targets", () => {
        it("refuses a loopback literal", async () => {
            const result = await checkNodeTarget("http://127.0.0.1:5216");
            assert.equal(result.safe, false);
            assert.match(result.reason, /loopback or link-local/);
        });

        it("refuses the cloud metadata endpoint", async () => {
            assert.equal((await checkNodeTarget("http://169.254.169.254/latest/meta-data")).safe, false);
        });

        it("refuses a bracketed IPv6 loopback", async () => {
            assert.equal((await checkNodeTarget("http://[::1]:5216")).safe, false);
        });

        // The literal is fine; what it resolves to is not. Without the lookup
        // this would be a trivial way round the check.
        it("refuses a hostname that resolves to loopback", async () => {
            const result = await checkNodeTarget("http://localhost:5216");
            assert.equal(result.safe, false);
            assert.match(result.reason, /loopback or link-local/);
        });

        it("refuses a hostname that does not resolve at all", async () => {
            const result = await checkNodeTarget("http://this-host-does-not-exist.invalid");
            assert.equal(result.safe, false);
            assert.match(result.reason, /could not be resolved/);
        });
    });

    describe("opt-out", () => {
        it("permits loopback when the operator asks for it", async () => {
            process.env.ALLOW_LOCAL_NODES = "true";
            assert.deepEqual(await checkNodeTarget("http://127.0.0.1:5216"), {safe: true});
        });

        // The opt-out is about address ranges, not about turning the guard off.
        it("still refuses a non-http protocol", async () => {
            process.env.ALLOW_LOCAL_NODES = "true";
            assert.equal((await checkNodeTarget("file:///etc/passwd")).safe, false);
        });
    });
});

/**
 * Regression: the guard recognised only the readable `::ffff:127.0.0.1`, which
 * is the one spelling a URL never produces. WHATWG serialises a mapped address
 * to hex - `new URL('http://[::ffff:127.0.0.1]').hostname` is `[::ffff:7f00:1]`
 * - so the text-prefix strip left `7f00:1`, still colon-bearing, which the v6
 * checks passed as safe. Both loopback and the cloud metadata endpoint were
 * reachable this way, and dns.lookup returns the same string so the
 * post-resolve check missed it too.
 *
 * These go through checkNodeTarget, the real entry point, because testing
 * isBlockedAddress with hand-written spellings is exactly what hid the gap.
 */
describe("IPv4 embedded in an IPv6 address", () => {
    const mapped = [
        "http://[::ffff:127.0.0.1]:5216",
        "http://[::ffff:169.254.169.254]/latest/meta-data",
        "http://[::ffff:0.0.0.0]:5216",
        // NAT64, which embeds IPv4 the same way, and the deprecated
        // IPv4-compatible form. Measured: the mapped form really does reach an
        // IPv4-only loopback listener, while the compat form times out on a
        // current stack - it is refused as free defence, not because it routes.
        "http://[64:ff9b::127.0.0.1]/",
        "http://[::127.0.0.1]:5216"
    ];

    for (const url of mapped)
        it(`refuses ${url}`, async () => {
            const result = await checkNodeTarget(url);
            assert.equal(result.safe, false, `${url} was accepted`);
        });

    it("refuses the hex spellings a URL actually emits", () => {
        assert.equal(isBlockedAddress("::ffff:7f00:1"), true, "mapped loopback");
        assert.equal(isBlockedAddress("::ffff:a9fe:a9fe"), true, "mapped metadata endpoint");
    });

    // A mapped address that is not itself blocked has to stay usable: LAN nodes
    // are the normal case for the feature.
    it("still allows a mapped private address", async () => {
        assert.equal(isBlockedAddress("::ffff:c0a8:132"), false, "mapped 192.168.1.50");
        assert.equal((await checkNodeTarget("http://[::ffff:192.168.1.50]:5216")).safe, true);
    });

    it("does not mistake an ordinary IPv6 address for a mapped one", async () => {
        assert.equal(isBlockedAddress("2606:4700:4700::1111"), false);
        assert.equal(isBlockedAddress("fd00::1"), false);
    });
});

/**
 * An optional narrowing, for an instance reachable from outside the house: it
 * turns "any URL an admin types" into "one of these". It never widens the
 * guard, and it is checked before the local opt-out so ALLOW_LOCAL_NODES cannot
 * be used to step around a list the operator set on purpose.
 */
describe("ALLOWED_NODE_HOSTS", () => {
    const originalList = process.env.ALLOWED_NODE_HOSTS;

    const withList = async (value, run) => {
        if (value === undefined) delete process.env.ALLOWED_NODE_HOSTS;
        else process.env.ALLOWED_NODE_HOSTS = value;

        try {
            return await run();
        } finally {
            if (originalList === undefined) delete process.env.ALLOWED_NODE_HOSTS;
            else process.env.ALLOWED_NODE_HOSTS = originalList;
        }
    };

    // IP literals throughout, so nothing here depends on DNS.
    const allows = async (list, url) => (await withList(list, () => checkNodeTarget(url))).safe;

    it("changes nothing while it is unset", async () => {
        assert.equal(await allows(undefined, "http://192.168.1.50:5216"), true);
        assert.equal(await allows("", "http://192.168.1.50:5216"), true);
        assert.equal(await allows("   ", "http://192.168.1.50:5216"), true);
    });

    it("allows a listed host on any port", async () => {
        assert.equal(await allows("192.168.1.50", "http://192.168.1.50:5216"), true);
        assert.equal(await allows("192.168.1.50", "http://192.168.1.50:9999"), true);
    });

    it("refuses a host that is not listed", async () => {
        assert.equal(await allows("192.168.1.50", "http://192.168.1.51:5216"), false);
        assert.equal(await allows("192.168.1.50", "http://10.0.0.5:5216"), false);
    });

    it("pins the port when the entry names one", async () => {
        assert.equal(await allows("192.168.1.50:5216", "http://192.168.1.50:5216"), true);
        assert.equal(await allows("192.168.1.50:5216", "http://192.168.1.50:9999"), false);
    });

    /**
     * Entries were normalised through `new URL("http://" + entry)`, whose
     * parser strips the *http* default port - so `host:80` stored an empty
     * port, which isAllowedHost reads as the documented "any port" wildcard.
     * The operator's pin was silently discarded.
     *
     * The other direction locked them out instead: `host:443` stored "443",
     * but `new URL("https://host:443").port` is also "" - so the entry could
     * never match the https URL it was written for.
     */
    it("pins a port the URL parser treats as a default", async () => {
        assert.equal(await allows("192.168.1.50:80", "http://192.168.1.50"), true);
        assert.equal(await allows("192.168.1.50:80", "http://192.168.1.50:80"), true);
        assert.equal(await allows("192.168.1.50:80", "https://192.168.1.50:8443"), false,
            "a pinned default port must not become a wildcard");
    });

    // IP literals here too, so nothing depends on DNS.
    it("matches an https URL pinned to its default port", async () => {
        assert.equal(await allows("192.168.1.50:443", "https://192.168.1.50"), true);
        assert.equal(await allows("192.168.1.50:443", "https://192.168.1.50:443"), true);
        assert.equal(await allows("192.168.1.50:443", "https://192.168.1.50:5216"), false);
    });

    // Reading the port off the entry's own text rather than the parser means
    // its text has to be normalised the way the parser would have: "080" and
    // "80" name the same port, and refusing the first is the same silent
    // lockout the other way round.
    it("reads a zero-padded port as the port it names", async () => {
        assert.equal(await allows("192.168.1.50:080", "http://192.168.1.50:80"), true);
        assert.equal(await allows("192.168.1.50:05216", "http://192.168.1.50:5216"), true);
        assert.equal(await allows("192.168.1.50:080", "http://192.168.1.50:8080"), false);
    });

    it("still allows any port when the entry names none", async () => {
        assert.equal(await allows("192.168.1.50", "http://192.168.1.50"), true);
        assert.equal(await allows("192.168.1.50", "https://192.168.1.50"), true);
    });

    it("accepts several entries, and tolerates spacing", async () => {
        const list = " 192.168.1.50 , 10.0.0.5:5216 ";

        assert.equal(await allows(list, "http://192.168.1.50:1234"), true);
        assert.equal(await allows(list, "http://10.0.0.5:5216"), true);
        assert.equal(await allows(list, "http://10.0.0.5:1234"), false);
    });

    it("handles a bracketed IPv6 entry", async () => {
        assert.equal(await allows("[fd00::1]", "http://[fd00::1]:5216"), true);
        assert.equal(await allows("[fd00::1]", "http://[fd00::2]:5216"), false);
    });

    it("matches a hostname regardless of case", async () => {
        // Compared through the URL parser, which lowercases both sides.
        const reason = await withList("MySpeed.Example.NET",
            () => checkNodeTarget("http://myspeed.example.net:5216"));

        assert.notEqual(reason.reason, "This host is not in ALLOWED_NODE_HOSTS");
    });

    // An entry the operator got wrong must not silently become "allow anything".
    it("refuses everything when no entry could be read", async () => {
        assert.equal(await allows("not a host!!", "http://192.168.1.50:5216"), false);
    });

    it("still refuses a listed loopback address without the local opt-out", async () => {
        assert.equal(await allows("127.0.0.1", "http://127.0.0.1:5216"), false);
    });

    it("is not something ALLOW_LOCAL_NODES can step around", async () => {
        process.env.ALLOW_LOCAL_NODES = "true";

        try {
            assert.equal(await allows("192.168.1.50", "http://192.168.1.51:5216"), false);
            assert.equal(await allows("127.0.0.1", "http://127.0.0.1:5216"), true);
        } finally {
            delete process.env.ALLOW_LOCAL_NODES;
        }
    });

    it("says which control refused the URL", async () => {
        const result = await withList("192.168.1.50", () => checkNodeTarget("http://10.0.0.5:5216"));
        assert.match(result.reason, /ALLOWED_NODE_HOSTS/);
    });
});
