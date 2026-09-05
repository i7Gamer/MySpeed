import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { getJson, MAX_GET_JSON_BYTES } from "../../server/util/http.js";

/**
 * Every case here talks to a loopback server rather than to the real GitHub and
 * speedtest.net endpoints getJson is pointed at in production - a deadline test
 * that depends on the network would fail for whoever happens to be offline.
 */
let server;
let baseUrl;

// Shorter than any loopback round trip needs, so the cases that are supposed to
// expire do so almost immediately and the whole file stays under a second.
const SHORT_TIMEOUT = 150;
// Long enough that the deliberately slow route is not what expires - these two
// prove the deadline is a deadline and not a blanket refusal to wait.
const LONG_TIMEOUT = 5000;
const SLOW_RESPONSE = 500;
/**
 * A case that reaches this has hung, which is precisely the failure under test.
 * node:test waits forever by default, so without it a regression would stall
 * the whole run instead of reporting a red test.
 */
const CASE_TIMEOUT = 10000;

const PAYLOAD = {tag_name: "v1.2.0"};
const JSON_HEADERS = {"content-type": "application/json"};
const TEAPOT = 418;

// A ceiling small enough that the oversized routes below can stay a few
// hundred bytes rather than actually allocating megabytes per test.
const TEST_MAX_BYTES = 1024;
// Never actually written to the socket - the declared-length check has to
// refuse the reply before a single byte of the body is read, so the route
// closes the connection right after the header.
const OVERSIZED_CONTENT_LENGTH = TEST_MAX_BYTES + 1000;
const CHUNK_BYTES = 200;
// More chunks than fit under TEST_MAX_BYTES, so the ceiling is crossed while
// streaming rather than on the first chunk.
const CHUNK_COUNT = 10;

before(async () => {
    server = http.createServer((req, res) => {
        // A client that walked away mid-reply tears the socket down under us,
        // and an unhandled 'error' on the response would take the run with it.
        res.on("error", () => {});

        // Accepts the connection and then says nothing, which is the shape of
        // hang the deadline exists for: no ECONNREFUSED, no headers, no end.
        if (req.url === "/hang") return;

        if (req.url === "/slow") {
            // Unref'd so a reply still in flight can never be the reason the
            // test process stays alive after the last case has finished.
            setTimeout(() => {
                if (!res.destroyed) res.writeHead(200, JSON_HEADERS).end(JSON.stringify(PAYLOAD));
            }, SLOW_RESPONSE).unref();
            return;
        }

        if (req.url === "/teapot") return void res.writeHead(TEAPOT).end("no");

        if (req.url === "/redirect") {
            return void res.writeHead(302, {location: `${baseUrl}/json`}).end();
        }

        // The declared length alone is over the cap; nothing after the header
        // is ever sent, which only matters if the fix reads the body anyway.
        if (req.url === "/big-cl") {
            return void res.writeHead(200, {...JSON_HEADERS, "content-length": String(OVERSIZED_CONTENT_LENGTH)})
                .end();
        }

        // No content-length set before the first write, so node answers this
        // one chunked - the shape a declared length can never catch.
        if (req.url === "/big-chunked") {
            res.writeHead(200, JSON_HEADERS);
            for (let i = 0; i < CHUNK_COUNT; i++) res.write("x".repeat(CHUNK_BYTES));
            return void res.end();
        }

        res.writeHead(200, JSON_HEADERS).end(JSON.stringify(PAYLOAD));
    });

    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
    // The hanging route leaves its socket open on purpose and close() waits for
    // open connections, so closing politely alone would never resolve.
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
});

const isTimeout = (e) => e.name === "TimeoutError";
const isAbort = (e) => e.name === "AbortError";

describe("getJson deadlines", () => {
    it("gives up on a server that accepts the connection and never answers", {timeout: CASE_TIMEOUT}, async () => {
        await assert.rejects(getJson(`${baseUrl}/hang`, {timeout: SHORT_TIMEOUT}), isTimeout);
    });

    it("honours the timeout it was handed rather than the integration default", {timeout: CASE_TIMEOUT}, async () => {
        await assert.rejects(getJson(`${baseUrl}/slow`, {timeout: SHORT_TIMEOUT}), isTimeout);
    });

    // The other half of the same claim: a longer deadline really does buy the
    // slower call more time, which is what the server-list download is after.
    it("waits out a reply that still fits inside a longer timeout", {timeout: CASE_TIMEOUT}, async () => {
        assert.deepEqual(await getJson(`${baseUrl}/slow`, {timeout: LONG_TIMEOUT}), PAYLOAD);
    });

    /**
     * The regression: `signal` used to default to the deadline, so passing one
     * replaced it. A caller adding cancellation removed the timeout in the same
     * stroke and was left with a request that could hang forever.
     */
    it("keeps the deadline when the caller supplies a signal of its own", {timeout: CASE_TIMEOUT}, async () => {
        const never = new AbortController();

        await assert.rejects(getJson(`${baseUrl}/hang`, {signal: never.signal, timeout: SHORT_TIMEOUT}), isTimeout);
    });

    // Composing the two must not cost the caller the cancellation it asked for.
    it("still aborts when the caller's own signal fires before the deadline", {timeout: CASE_TIMEOUT}, async () => {
        const controller = new AbortController();
        const pending = getJson(`${baseUrl}/hang`, {signal: controller.signal, timeout: LONG_TIMEOUT});

        controller.abort();

        await assert.rejects(pending, isAbort);
    });

    it("returns the parsed body when the server answers in time", async () => {
        assert.deepEqual(await getJson(`${baseUrl}/json`), PAYLOAD);
    });

    it("throws the status when the response is not ok", async () => {
        await assert.rejects(getJson(`${baseUrl}/teapot`), /HTTP 418/);
    });
});

/**
 * getJson's two callers - loadServers.js and routes/system.js - hand it
 * project-owned URLs rather than an operator's, but "project-owned" is not
 * "trustworthy at every instant": GitHub's release API and the provider
 * server lists could be redirected or answer something unbounded without
 * either caller noticing, since both already catch a throw from here.
 */
describe("getJson safety", () => {
    it("refuses a redirect rather than following it", async () => {
        await assert.rejects(getJson(`${baseUrl}/redirect`),
            (e) => e.name === "TypeError" && /redirect/i.test(e.cause?.message ?? e.message));
    });

    it("refuses a body over the ceiling before reading it, by content-length alone", async () => {
        await assert.rejects(getJson(`${baseUrl}/big-cl`, {maxBytes: TEST_MAX_BYTES}), /exceeds/);
    });

    it("refuses a chunked body over the ceiling with no content-length to warn it", async () => {
        await assert.rejects(getJson(`${baseUrl}/big-chunked`, {maxBytes: TEST_MAX_BYTES}), /exceeds/);
    });

    it("still parses a small JSON answer under the ceiling", async () => {
        assert.deepEqual(await getJson(`${baseUrl}/json`, {maxBytes: TEST_MAX_BYTES}), PAYLOAD);
    });

    it("exports a default ceiling generous enough for a real answer, tight enough to be a ceiling", () => {
        assert.ok(Number.isFinite(MAX_GET_JSON_BYTES) && MAX_GET_JSON_BYTES > 0);
        // speedtest.net's server list, the largest of getJson's real answers,
        // is well under 1 MB - the ceiling has to clear that with room.
        assert.ok(MAX_GET_JSON_BYTES >= 1024 * 1024, "the default ceiling would refuse an ordinary answer");
    });
});
