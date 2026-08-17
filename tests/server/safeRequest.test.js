import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import dns from "node:dns";
import { safeRequest, MAX_RESPONSE_BYTES } from "../../server/util/safeRequest.js";
import { safeLookup } from "../../server/util/safeUrl.js";

const FLOOD_CHUNK_BYTES = 1024;
const FLOOD_CHUNKS = 100;
const FLOOD_TOTAL_BYTES = FLOOD_CHUNK_BYTES * FLOOD_CHUNKS;

let server;
let port;
let received = [];

before(async () => {
    server = http.createServer((req, res) => {
        let body = "";
        req.on("data", (chunk) => { body += chunk; });
        req.on("end", () => {
            received.push({url: req.url, method: req.method, headers: req.headers, body});

            if (req.url === "/redirect") {
                res.writeHead(302, {location: "http://169.254.169.254/latest/meta-data"});
                return res.end();
            }

            if (req.url === "/slow") return;    // never answers

            // Far more than the cap the flood test sets, sent in pieces so the
            // ceiling is crossed part way through the body rather than on the
            // first chunk. Finite on purpose: an endless stream would hang the
            // run rather than fail it if the ceiling were ever removed.
            if (req.url === "/flood") {
                res.writeHead(200, {"content-type": "application/octet-stream"});
                for (let i = 0; i < FLOOD_CHUNKS; i++) res.write("x".repeat(FLOOD_CHUNK_BYTES));
                return res.end();
            }

            res.writeHead(200, {"content-type": "text/plain"});
            res.end("hello");
        });
    });

    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = server.address().port;
});

after(() => new Promise((resolve) => server.close(resolve)));

beforeEach(() => {
    received = [];
    process.env.ALLOW_LOCAL_NODES = "true";
});

afterEach(() => {
    delete process.env.ALLOW_LOCAL_NODES;
});

const url = (path = "/") => `http://127.0.0.1:${port}${path}`;

describe("safeRequest", () => {
    it("performs a GET and returns status, headers and body", async () => {
        const response = await safeRequest(url("/thing"));

        assert.equal(response.status, 200);
        assert.match(response.headers["content-type"], /text\/plain/);
        assert.equal(response.body.toString(), "hello");
    });

    it("sends the method, headers and body it was given", async () => {
        await safeRequest(url("/write"), {
            method: "PUT",
            headers: {"x-password": "secret", "content-type": "application/json"},
            body: JSON.stringify({a: 1})
        });

        const sent = received.at(-1);
        assert.equal(sent.method, "PUT");
        assert.equal(sent.headers["x-password"], "secret");
        assert.equal(sent.body, '{"a":1}');
    });

    // A redirect is the far end choosing a destination after the check passed.
    it("never follows a redirect", async () => {
        const response = await safeRequest(url("/redirect"));

        assert.equal(response.status, 302);
        assert.equal(received.length, 1, "the redirect was followed");
    });

    it("gives up on a server that never answers", async () => {
        await assert.rejects(() => safeRequest(url("/slow"), {timeout: 300}), /Timed out/);
    });

    it("can be aborted", async () => {
        const controller = new AbortController();
        const pending = safeRequest(url("/slow"), {signal: controller.signal});

        controller.abort();
        await assert.rejects(() => pending, /aborted/i);
    });

    it("rejects a malformed url", async () => {
        await assert.rejects(() => safeRequest("not a url"));
    });
});

/**
 * A node that answers with more than the caller can hold.
 *
 * Every chunk went into an array that nothing bounded, so the size of the
 * response was the far end's choice and the only limit was the heap. A node is
 * a machine an admin pointed at, not a trusted one - it can be compromised, or
 * simply be something else at that address by now - and the whole server is a
 * single process: one hostile answer takes down the scheduler, the API and the
 * database handle with it. The other half is the proxy at controller/node.js,
 * which passes a caller's own request through, so a page load is enough to ask
 * for it.
 */
describe("a response larger than the ceiling", () => {
    it("rejects rather than buffering the whole of it", async () => {
        await assert.rejects(
            () => safeRequest(url("/flood"), {maxBytes: FLOOD_TOTAL_BYTES / 4}),
            /too large/i,
            "the whole flood was buffered into memory"
        );
    });

    it("stops reading part way through rather than at the end", async () => {
        // Proves the ceiling is enforced as the body arrives. A check on the
        // assembled buffer would reject the same request having already paid
        // the memory that the rejection is meant to avoid.
        let peak = 0;
        const original = Buffer.concat;
        Buffer.concat = (chunks) => {
            peak = Math.max(peak, chunks.reduce((sum, chunk) => sum + chunk.length, 0));
            return original(chunks);
        };

        try {
            await assert.rejects(() => safeRequest(url("/flood"), {maxBytes: FLOOD_TOTAL_BYTES / 4}));
        } finally {
            Buffer.concat = original;
        }

        assert.ok(peak <= FLOOD_TOTAL_BYTES / 2,
            `the body was assembled anyway: ${peak} bytes reached Buffer.concat`);
    });

    it("lets a body under the ceiling through untouched", async () => {
        const response = await safeRequest(url("/flood"), {maxBytes: FLOOD_TOTAL_BYTES * 2});

        assert.equal(response.status, 200);
        assert.equal(response.body.length, FLOOD_TOTAL_BYTES);
    });

    it("applies a ceiling by default, without the caller asking for one", async () => {
        assert.equal(typeof MAX_RESPONSE_BYTES, "number");
        assert.ok(MAX_RESPONSE_BYTES > 0 && Number.isFinite(MAX_RESPONSE_BYTES),
            "the default ceiling is not a usable size");

        // Large enough that no answer a real node gives is refused by it.
        assert.ok(MAX_RESPONSE_BYTES >= 1024 * 1024, "the default ceiling would refuse ordinary responses");
    });
});

describe("safeLookup", () => {
    const lookup = (hostname, options = {}) => new Promise((resolve, reject) => {
        safeLookup(hostname, options, (error, address, family) =>
            error ? reject(error) : resolve(options.all ? address : {address, family}));
    });

    const originalLookup = dns.lookup;

    // Stubbed so the suite makes no DNS query of its own; a real public name
    // would make this test depend on the network.
    const resolvingTo = (address, family = 4) => {
        dns.lookup = (hostname, options, callback) => {
            if (hostname !== "stub.test") return originalLookup(hostname, options, callback);

            const entries = [{address, family}];
            if (typeof options === "function") return options(null, address, family);
            if (options?.all) return callback(null, entries);
            return callback(null, address, family);
        };
    };

    beforeEach(() => {
        delete process.env.ALLOW_LOCAL_NODES;
    });

    afterEach(() => {
        dns.lookup = originalLookup;
    });

    it("resolves an ordinary name", async () => {
        resolvingTo("203.0.113.5");
        const {address} = await lookup("stub.test");

        assert.equal(address, "203.0.113.5");
    });

    it("returns the first address that is not blocked", async () => {
        dns.lookup = (hostname, options, callback) => {
            const entries = [{address: "127.0.0.1", family: 4}, {address: "203.0.113.5", family: 4}];
            if (options?.all) return callback(null, entries);
            return callback(null, entries[0].address, 4);
        };

        assert.equal((await lookup("stub.test")).address, "203.0.113.5");
    });

    /**
     * The whole point: a name that resolves to a blocked address is refused at
     * connect time, not merely checked beforehand. Anything that only inspected
     * the name would have to resolve it a second time to connect, and a record
     * that changed in between - DNS rebinding - would slip past.
     */
    it("refuses a name that resolves to loopback", async () => {
        await assert.rejects(() => lookup("localhost"), (error) => error.code === "EBLOCKEDADDRESS");
    });

    it("honours the opt-out", async () => {
        process.env.ALLOW_LOCAL_NODES = "true";
        const {address} = await lookup("localhost");

        assert.ok(address.startsWith("127.") || address === "::1");
    });

    it("passes a dns failure through rather than masking it", async () => {
        await assert.rejects(() => lookup("no-such-host.invalid"),
            (error) => error.code !== "EBLOCKEDADDRESS");
    });

    it("honours the all option", async () => {
        resolvingTo("203.0.113.5");
        const addresses = await lookup("stub.test", {all: true});

        assert.ok(Array.isArray(addresses));
        assert.deepEqual(addresses.map((entry) => entry.address), ["203.0.113.5"]);
    });
});

/**
 * The end-to-end proof. A hostname is made to resolve to a harmless address
 * first and to loopback afterwards - exactly what a rebinding attack does
 * between the check and the connection. The request has to fail at connect
 * time, on the address, not on the name.
 */
describe("DNS rebinding", () => {
    const originalLookup = dns.lookup;
    const REBINDING_HOST = "rebind.test";

    afterEach(() => {
        dns.lookup = originalLookup;
    });

    it("refuses the connection when the record flips to loopback", async () => {
        delete process.env.ALLOW_LOCAL_NODES;

        // Answers with loopback, which is what the second resolution would
        // return after the guard had approved something else.
        dns.lookup = (hostname, options, callback) => {
            if (hostname !== REBINDING_HOST) return originalLookup(hostname, options, callback);

            const entries = [{address: "127.0.0.1", family: 4}];
            if (typeof options === "function") return options(null, entries[0].address, 4);
            if (options?.all) return callback(null, entries);
            return callback(null, entries[0].address, 4);
        };

        await assert.rejects(
            () => safeRequest(`http://${REBINDING_HOST}:${port}/`),
            (error) => error.code === "EBLOCKEDADDRESS",
            "the connection was made to a rebound loopback address"
        );

        assert.equal(received.length, 0, "the request reached the loopback server anyway");
    });
});
