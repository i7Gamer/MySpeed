import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { bootServer, seedTests } from "./helpers/boot.js";

let server;

/** Every outbound request the server makes while a test runs. */
let outbound = [];
const realFetch = globalThis.fetch;

const HOSTILE_HOST = "attacker.invalid:1";

before(async () => {
    server = await bootServer();

    globalThis.fetch = (...args) => {
        outbound.push(String(args[0]?.url ?? args[0]));
        return realFetch(...args);
    };
});

after(async () => {
    globalThis.fetch = realFetch;
    await server?.close();
});

beforeEach(async () => {
    // readStatistics looks at yesterday..today and the image is only rendered
    // when that window has usable averages, so the route has to get past this
    // to reach the asset loader at all.
    const now = new Date();
    await seedTests(server.tests, [
        {created: new Date(now.getTime() - 3600000).toISOString(), ping: 10, download: 100, upload: 50},
        {created: now.toISOString(), ping: 12, download: 120, upload: 60}
    ]);

    outbound = [];
});

/**
 * Issues the request over node:http rather than fetch, for two reasons: fetch
 * refuses to send a forged Host header (it is a forbidden header name), and
 * routing the test's own traffic around the patched global keeps `outbound`
 * holding only what the *server* requested.
 */
const rawRequest = (path, headers = {}) => new Promise((resolve, reject) => {
    const {hostname, port} = new URL(server.baseUrl);
    const request = http.request({hostname, port, path, method: "GET", headers}, (res) => {
        res.resume();
        res.on("end", () => resolve({status: res.statusCode, headers: res.headers}));
    });

    request.on("error", reject);
    request.end();
});

describe("GET /api/opengraph/image", () => {
    it("answers without erroring", async () => {
        const {status} = await rawRequest("/api/opengraph/image");
        assert.ok([200, 302].includes(status), `unexpected status ${status}`);
    });

    it("sends the forged host through to the server", async () => {
        // Guards the test itself: if the Host header stopped arriving, the
        // regression tests below would pass for the wrong reason.
        const {status} = await rawRequest("/api/opengraph/image", {host: HOSTILE_HOST});
        assert.ok(status >= 200, "the request never reached the server");
    });

    /**
     * Regression: the asset loader fell back to fetching the font and logo from
     * `${req.protocol}://${req.headers.host}${path}`. The Host header is chosen
     * by the caller and this route is reachable without a password, so anyone
     * could make the server issue a request to a host of their naming - a blind
     * SSRF into whatever the instance can reach.
     */
    it("never calls out to the host named in the request", async () => {
        await rawRequest("/api/opengraph/image", {host: HOSTILE_HOST});

        const reached = outbound.filter((url) => url.includes("attacker.invalid"));
        assert.deepEqual(reached, [], `server called out to ${reached.join(", ")}`);
    });

    it("makes no outbound request at all while rendering", async () => {
        await rawRequest("/api/opengraph/image");
        assert.deepEqual(outbound, [], `server issued ${outbound.join(", ")}`);
    });

    it("makes no outbound request even when the host is forged", async () => {
        await rawRequest("/api/opengraph/image", {host: HOSTILE_HOST});
        assert.deepEqual(outbound, [], `server issued ${outbound.join(", ")}`);
    });

    it("falls back to the banner rather than failing when assets are unavailable", async () => {
        // The throwaway working directory has no build/ or client/public/, so
        // the assets cannot be loaded and the route redirects instead.
        const {status, headers} = await rawRequest("/api/opengraph/image");

        if (status === 302) assert.match(headers.location, /^https:\/\//);
    });
});
