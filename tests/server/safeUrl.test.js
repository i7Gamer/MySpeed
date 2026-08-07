import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { checkNodeTarget, isBlockedAddress } from "../../server/util/safeUrl.js";

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
