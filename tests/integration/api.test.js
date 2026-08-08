import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { bootServer, api, seedTests, setConfig } from "./helpers/boot.js";

let server;

before(async () => {
    server = await bootServer();
});

after(async () => {
    await server?.close();
});

beforeEach(async () => {
    await seedTests(server.tests, []);
    await setConfig(server.config, "password", "none");
    await setConfig(server.config, "passwordLevel", "none");
});

describe("GET /api/speedtests/export", () => {
    const exportUrl = (query) => api(server.baseUrl, `/speedtests/export?${query}`);

    it("validates the range like the statistics route", async () => {
        assert.equal((await exportUrl("from=2026-02-30&to=2026-03-01")).status, 400);
    });

    it("returns JSON with a download filename", async () => {
        await seedTests(server.tests, [{created: "2026-08-05T10:00:00.000Z"}]);

        const {status, body, headers} = await exportUrl("from=2026-08-01&to=2026-08-07&tzOffset=0&format=json");
        assert.equal(status, 200);
        assert.match(headers.get("content-disposition"), /filename="myspeed-export-2026-08-01-to-2026-08-07\.json"/);
        assert.equal(body.length, 1);
        assert.equal(body[0].download, 100);
    });

    it("returns CSV with a header row", async () => {
        await seedTests(server.tests, [{created: "2026-08-05T10:00:00.000Z"}]);

        const {status, text, headers} = await exportUrl("from=2026-08-01&to=2026-08-07&tzOffset=0&format=csv");
        assert.equal(status, 200);
        assert.match(headers.get("content-type"), /text\/csv/);
        assert.equal(text.split("\n")[0],
            "id,ping,jitter,download,upload,time,type,created,packetLoss,downloadLatency,uploadLatency,error");
    });

    // Regression: the old exporter only swapped commas out of `error`, so a
    // quote or a comma shifted every column after it.
    it("keeps a comma and a quote inside a single CSV field", async () => {
        await seedTests(server.tests, [{
            created: "2026-08-05T10:00:00.000Z",
            download: -1, upload: -1, ping: -1,
            error: 'lost connection, said "retry"'
        }]);

        const {text} = await exportUrl("from=2026-08-01&to=2026-08-07&tzOffset=0&format=csv");
        const rows = text.split("\n");

        assert.equal(rows.length, 2, "one header plus exactly one data row");
        assert.ok(rows[1].endsWith('"lost connection, said ""retry"""'), rows[1]);
    });

    it("excludes tests outside the range", async () => {
        await seedTests(server.tests, [
            {created: "2026-08-05T10:00:00.000Z"},
            {created: "2026-10-01T10:00:00.000Z"}
        ]);

        const {body} = await exportUrl("from=2026-08-01&to=2026-08-07&tzOffset=0&format=json");
        assert.equal(body.length, 1);
    });
});

describe("GET /api/speedtests", () => {
    it("rejects a non-numeric limit", async () => {
        const {status} = await api(server.baseUrl, "/speedtests?limit=abc");
        assert.equal(status, 400);
    });

    it("rejects a non-numeric afterId", async () => {
        assert.equal((await api(server.baseUrl, "/speedtests?afterId=xyz")).status, 400);
    });

    it("honours the limit", async () => {
        await seedTests(server.tests, Array.from({length: 5}, (_, index) => ({
            created: `2026-08-0${index + 1}T10:00:00.000Z`
        })));

        const {body} = await api(server.baseUrl, "/speedtests?limit=2");
        assert.equal(body.length, 2);
    });

    it("returns the newest test first", async () => {
        await seedTests(server.tests, [
            {created: "2026-08-01T10:00:00.000Z", download: 1},
            {created: "2026-08-05T10:00:00.000Z", download: 2}
        ]);

        const {body} = await api(server.baseUrl, "/speedtests?limit=10");
        assert.equal(body[0].download, 2);
    });

    it("404s an unknown test id", async () => {
        assert.equal((await api(server.baseUrl, "/speedtests/999999")).status, 404);
    });
});

describe("POST /api/speedtests/run", () => {
    // provider defaults to "none", so this never starts a real speedtest.
    it("refuses to start without a provider", async () => {
        const {status, body} = await api(server.baseUrl, "/speedtests/run", {method: "POST"});
        assert.equal(status, 410);
        assert.match(body.message, /provider/i);
    });

    /*
     * There was a test here asserting the route "answers promptly rather than
     * holding the connection", guarding the change that stopped it awaiting the
     * whole 30-60s speedtest.
     *
     * It could not fail. provider defaults to "none", so the route answered 410
     * before reaching the speedtest at all, and the sub-2000ms bound was met
     * whether or not the call was awaited. Configuring a provider does not
     * rescue it either: no CLI is installed here, so the run fails in about
     * twenty milliseconds - faster than a second request can observe it, and far
     * inside any timing bound that would catch a real await.
     *
     * What is actually observable lives in speedtestRun.test.js: the route
     * answers 200 and the resulting row appears afterwards, which is the
     * behaviour that matters. Rather than leave a green assertion standing
     * guard over nothing, it is recorded here.
     */
});

describe("GET /api/speedtests/status", () => {
    it("reports the paused and running flags", async () => {
        const {status, body} = await api(server.baseUrl, "/speedtests/status");
        assert.equal(status, 200);
        assert.equal(typeof body.paused, "boolean");
        assert.equal(typeof body.running, "boolean");
    });
});

describe("password middleware", () => {
    const withPassword = (value) => ({headers: {"x-password": value}});

    it("allows read access when no password is configured", async () => {
        assert.equal((await api(server.baseUrl, "/speedtests?limit=1")).status, 200);
    });

    it("rejects a read without the password once one is set", async () => {
        await setConfig(server.config, "password", "hunter2");

        const {status, body} = await api(server.baseUrl, "/speedtests?limit=1");
        assert.equal(status, 401);
        assert.match(body.message, /password/i);
    });

    it("accepts the correct password", async () => {
        await setConfig(server.config, "password", "hunter2");
        assert.equal((await api(server.baseUrl, "/speedtests?limit=1", withPassword("hunter2"))).status, 200);
    });

    it("rejects a wrong password", async () => {
        await setConfig(server.config, "password", "hunter2");
        assert.equal((await api(server.baseUrl, "/speedtests?limit=1", withPassword("wrong"))).status, 401);
    });

    it("accepts a url-encoded password header", async () => {
        await setConfig(server.config, "password", "pa ss wörd");
        const encoded = encodeURIComponent("pa ss wörd");
        assert.equal((await api(server.baseUrl, "/speedtests?limit=1", withPassword(encoded))).status, 200);
    });

    it("allows read-only access at passwordLevel read", async () => {
        await setConfig(server.config, "password", "hunter2");
        await setConfig(server.config, "passwordLevel", "read");

        assert.equal((await api(server.baseUrl, "/speedtests?limit=1")).status, 200);
    });

    it("still guards writes at passwordLevel read", async () => {
        await setConfig(server.config, "password", "hunter2");
        await setConfig(server.config, "passwordLevel", "read");

        assert.equal((await api(server.baseUrl, "/speedtests/1", {method: "DELETE"})).status, 401);
    });

    it("guards the export route", async () => {
        await setConfig(server.config, "password", "hunter2");

        const {status} = await api(server.baseUrl, "/speedtests/export?from=2026-08-01&to=2026-08-07&format=json");
        assert.equal(status, 401);
    });
});

describe("GET /api/health", () => {
    it("reports healthy while the database is reachable", async () => {
        const {status, body} = await api(server.baseUrl, "/health");
        assert.equal(status, 200);
        assert.equal(body.status, "ok");
        assert.equal(body.database, "up");
    });

    it("reports the process uptime as a number", async () => {
        const {body} = await api(server.baseUrl, "/health");
        assert.equal(typeof body.uptime, "number");
        assert.ok(body.uptime >= 0);
    });

    // A container healthcheck cannot authenticate, so this endpoint has to stay
    // reachable no matter how the instance is locked down.
    it("stays reachable when a password is configured", async () => {
        await setConfig(server.config, "password", "hunter2");

        const {status, body} = await api(server.baseUrl, "/health");
        assert.equal(status, 200);
        assert.equal(body.status, "ok");
    });

    it("stays reachable at passwordLevel read", async () => {
        await setConfig(server.config, "password", "hunter2");
        await setConfig(server.config, "passwordLevel", "read");

        assert.equal((await api(server.baseUrl, "/health")).status, 200);
    });

    // Health is unauthenticated, so it must not become an information leak.
    it("discloses nothing beyond liveness", async () => {
        const {body} = await api(server.baseUrl, "/health");
        assert.deepEqual(Object.keys(body).sort(), ["database", "status", "uptime"]);
    });

    it("does not depend on any outbound network call", async () => {
        // /info/version reaches GitHub and is therefore unusable as a health
        // probe; /health must answer promptly and offline.
        const startedAt = process.hrtime.bigint();
        await api(server.baseUrl, "/health");
        const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;

        assert.ok(elapsedMs < 1000, `health took ${Math.round(elapsedMs)}ms`);
    });
});

describe("routing", () => {
    it("404s an unknown api route as JSON", async () => {
        const {status, body} = await api(server.baseUrl, "/does-not-exist");
        assert.equal(status, 404);
        assert.equal(body.message, "Route not found");
    });

    it("does not leak the express banner", async () => {
        const response = await fetch(`${server.baseUrl}/api/speedtests/status`);
        assert.equal(response.headers.get("x-powered-by"), null);
    });

    it("serves the version endpoint", async () => {
        const {status, body} = await api(server.baseUrl, "/info/version");
        assert.equal(status, 200);
        assert.equal(typeof body.local, "string");
    });
});
