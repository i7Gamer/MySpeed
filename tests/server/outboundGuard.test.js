import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { checkOutboundTarget } from "../../server/util/safeUrl.js";
import { postJson, postText } from "../../server/util/http.js";

/**
 * safeUrl called itself "the one place the server fetches a URL the user typed:
 * adding a remote node". That was not true. Five integration modules also fetch
 * a stored, operator-supplied URL - webhook, healthChecks, gotify, ntfy and
 * influxdb - and every one of them goes through util/http.js, which called the
 * global fetch with no address filtering at all.
 *
 * The only gate was the field's own regex, /^https?:\/\/\S+$/, which matches
 * http://127.0.0.1:9200/ and http://169.254.169.254/ as happily as anything
 * else. So the machinery routes/nodes.js documents at length - and that
 * controller/node.js re-runs on *every* proxied request rather than trusting
 * creation time - covered one of the six user-typed URLs in the app.
 *
 * The node allowlist is deliberately not part of this. ALLOWED_NODE_HOSTS names
 * the machines that may be nodes; applying it to notifications would refuse
 * discord on any instance that set it.
 */
describe("checkOutboundTarget", () => {
    it("refuses the cloud metadata address", () => {
        assert.equal(checkOutboundTarget("http://169.254.169.254/latest/meta-data").safe, false);
    });

    it("refuses the rest of the link-local range", () => {
        assert.equal(checkOutboundTarget("http://169.254.1.1/").safe, false);
        assert.equal(checkOutboundTarget("http://[fe80::1]/hook").safe, false);
    });

    it("refuses link-local spelled as an IPv4-mapped IPv6 literal", () => {
        assert.equal(checkOutboundTarget("http://[::ffff:169.254.169.254]/").safe, false);
        assert.equal(checkOutboundTarget("http://[::ffff:a9fe:a9fe]/").safe, false);
    });

    /**
     * Loopback is allowed, and that is a decision rather than a gap.
     *
     * A node is another machine by definition, so loopback there is never
     * anything but a mistake or an attack. An integration endpoint on the same
     * host is ordinary - InfluxDB on 127.0.0.1:8086, a gotify container beside
     * MySpeed - and refusing it would break more working installs than it
     * protected. The escalation worth closing is the metadata service, and that
     * is not in this range.
     */
    it("allows an endpoint on the same host", () => {
        assert.deepEqual(checkOutboundTarget("http://127.0.0.1:8086/api/v2/write"), {safe: true});
        assert.deepEqual(checkOutboundTarget("http://localhost:8086/api/v2/write"), {safe: true});
    });

    it("refuses anything that is not http", () => {
        assert.equal(checkOutboundTarget("file:///etc/passwd").safe, false);
        assert.equal(checkOutboundTarget("gopher://127.0.0.1/").safe, false);
    });

    it("refuses a value that is not a URL at all", () => {
        assert.equal(checkOutboundTarget("not a url").safe, false);
    });

    /**
     * A LAN address is allowed, exactly as it is for a node: self-hosters run
     * gotify and influx on the same network as MySpeed, and refusing RFC1918
     * would break the ordinary install. safeUrl says the same thing about nodes
     * and for the same reason.
     */
    it("allows an ordinary private address", () => {
        assert.deepEqual(checkOutboundTarget("http://192.168.1.50:8086/api/v2/write"), {safe: true});
    });

    /**
     * It does not resolve the hostname, and must not start: this runs inside the
     * run lock on every finished test, so a lookup here would put a DNS round
     * trip in front of every webhook and would refuse a working endpoint that is
     * momentarily unresolvable. checkNodeTarget resolves because a node is added
     * once, by hand.
     */
    it("allows a name it cannot resolve rather than waiting on DNS", () => {
        assert.deepEqual(checkOutboundTarget("https://hooks.example/services/T000"), {safe: true});
    });

    /**
     * The node allowlist must not reach this path. An operator who pinned which
     * hosts may be nodes has said nothing about where their notifications go.
     */
    it("ignores ALLOWED_NODE_HOSTS", () => {
        const original = process.env.ALLOWED_NODE_HOSTS;
        process.env.ALLOWED_NODE_HOSTS = "192.168.1.99";

        try {
            assert.deepEqual(checkOutboundTarget("http://192.168.1.50:8086/"), {safe: true});
        } finally {
            if (original === undefined) delete process.env.ALLOWED_NODE_HOSTS;
            else process.env.ALLOWED_NODE_HOSTS = original;
        }
    });
});

describe("an integration pointed at an address it may not reach", () => {
    const realFetch = globalThis.fetch;
    let attempted;

    beforeEach(() => {
        attempted = [];
        globalThis.fetch = async (url) => {
            attempted.push(String(url));
            return new Response("{}", {status: 200});
        };
    });

    afterEach(() => {
        globalThis.fetch = realFetch;
    });

    it("is not sent by postJson", async () => {
        const outcome = await postJson("http://169.254.169.254/latest/meta-data", {a: 1});

        assert.deepEqual(attempted, [], "the request went out anyway");
        assert.equal(outcome, null);
    });

    it("is not sent by postText", async () => {
        const outcome = await postText("http://169.254.169.254/latest/meta-data", "x");

        assert.deepEqual(attempted, []);
        assert.equal(outcome, null);
    });

    // The refusal is an integration failure like any other, so the card says the
    // endpoint is not working rather than staying silent about it.
    it("is recorded against the integration", async () => {
        const noted = [];
        await postJson("http://169.254.169.254/", {}, {activity: (failed) => noted.push(failed)});

        assert.deepEqual(noted, [true]);
    });

    // The common self-hosted shape, which must keep working.
    it("still sends to an endpoint on the same host", async () => {
        const outcome = await postText("http://127.0.0.1:8086/api/v2/write", "line");

        assert.deepEqual(attempted, ["http://127.0.0.1:8086/api/v2/write"]);
        assert.deepEqual(outcome, {ok: true, status: 200});
    });

    it("still sends to an address it may reach", async () => {
        const outcome = await postJson("http://192.168.1.50:8086/api/v2/write", {a: 1});

        assert.deepEqual(attempted, ["http://192.168.1.50:8086/api/v2/write"]);
        assert.deepEqual(outcome, {ok: true, status: 200});
    });
});
