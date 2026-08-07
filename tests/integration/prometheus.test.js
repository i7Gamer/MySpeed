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
    await setConfig(server.config, "password", "none");
    await seedTests(server.tests, [{created: new Date().toISOString()}]);
});

const metrics = (headers = {}) => api(server.baseUrl, "/prometheus/metrics", {headers});
const basic = (value) => ({authorization: `Basic ${Buffer.from(value).toString("base64")}`});

describe("GET /api/prometheus/metrics", () => {
    it("is open while no password is configured", async () => {
        assert.equal((await metrics()).status, 200);
    });

    it("challenges once a password is configured", async () => {
        await setConfig(server.config, "password", "hunter2");

        const {status, headers} = await metrics();
        assert.equal(status, 401);
        assert.match(headers.get("www-authenticate"), /^Basic /);
    });

    it("accepts the prometheus user with the configured password", async () => {
        await setConfig(server.config, "password", "hunter2");
        assert.equal((await metrics(basic("prometheus:hunter2"))).status, 200);
    });

    it("rejects a wrong password", async () => {
        await setConfig(server.config, "password", "hunter2");
        assert.equal((await metrics(basic("prometheus:nope"))).status, 401);
    });

    it("rejects a different username", async () => {
        await setConfig(server.config, "password", "hunter2");
        assert.equal((await metrics(basic("grafana:hunter2"))).status, 401);
    });

    /**
     * Regression: credentials.split(':') on a value with no colon left the
     * password undefined, which bcrypt throws on - so a malformed header came
     * back as a 500 carrying a stack trace instead of a 401.
     */
    it("answers a colonless Basic value with 401, not 500", async () => {
        await setConfig(server.config, "password", "hunter2");

        const {status, text} = await metrics(basic("prometheus"));
        assert.equal(status, 401);
        assert.doesNotMatch(text, /at .*\.js:\d+/);
    });

    it("answers an empty Basic value with 401", async () => {
        await setConfig(server.config, "password", "hunter2");
        assert.equal((await metrics(basic(""))).status, 401);
    });

    it("answers a Basic header with no credentials at all with 401", async () => {
        await setConfig(server.config, "password", "hunter2");
        assert.equal((await metrics({authorization: "Basic "})).status, 401);
    });

    it("keeps a password with colons in it working", async () => {
        await setConfig(server.config, "password", "a:b:c");
        assert.equal((await metrics(basic("prometheus:a:b:c"))).status, 200);
    });
});
