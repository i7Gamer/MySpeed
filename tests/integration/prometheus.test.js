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

/**
 * Every assertion above is about who may read the endpoint; none was about what
 * it says. The exporter could have emitted the wrong number, or stopped emitting
 * a series entirely, without failing anything - which is how the quality columns
 * came to be stored and stored only.
 */
describe("what the metrics endpoint reports", () => {
    const valueOf = (text, metric) => {
        const line = text.split("\n").find((row) => row.startsWith(`${metric}{`) || row === metric);
        return line === undefined ? null : parseFloat(line.slice(line.lastIndexOf(" ") + 1));
    };

    const seedLatest = async (overrides) => await seedTests(server.tests,
        [{created: new Date().toISOString(), ...overrides}]);

    it("reports the latest measurement", async () => {
        await seedLatest({ping: 4, jitter: 0.27, download: 2366.32, upload: 2202.56});

        const {text} = await metrics();

        assert.equal(valueOf(text, "myspeed_ping"), 4);
        assert.equal(valueOf(text, "myspeed_jitter"), 0.27);
        assert.equal(valueOf(text, "myspeed_download"), 2366.32);
        assert.equal(valueOf(text, "myspeed_upload"), 2202.56);
    });

    it("reports the quality figures the latest test recorded", async () => {
        await seedLatest({packetLoss: 0, downloadLatency: 7.51, uploadLatency: 43.77});

        const {text} = await metrics();

        // Zero is a measurement of a clean line, not a missing series.
        assert.equal(valueOf(text, "myspeed_packet_loss"), 0);
        assert.equal(valueOf(text, "myspeed_download_latency"), 7.51);
        assert.equal(valueOf(text, "myspeed_upload_latency"), 43.77);
    });

    // An absent series is a gap in a graph; a zero is a claim the line was
    // flawless. Librespeed and cloudflare measure none of these.
    it("omits a quality figure the provider never measured", async () => {
        await seedLatest({packetLoss: null, downloadLatency: null, uploadLatency: null});

        const {text} = await metrics();

        assert.equal(valueOf(text, "myspeed_packet_loss"), null);
        assert.equal(valueOf(text, "myspeed_download_latency"), null);
        assert.equal(valueOf(text, "myspeed_upload_latency"), null);
    });

    it("carries the server it measured as labels", async () => {
        await seedLatest({serverId: 49631, serverName: "Arcade Solutions AG", serverHost: "speedtest.arcade.ch"});

        const {text} = await metrics();

        assert.match(text, /myspeed_ping\{[^}]*server_name="Arcade Solutions AG"/);
        assert.match(text, /myspeed_ping\{[^}]*server_host="speedtest\.arcade\.ch"/);
        assert.equal(valueOf(text, "myspeed_server_info"), 1);
    });

    // A failed test carries -1 in every column, and exporting that would put a
    // measurement of minus one metre per second into someone's dashboard.
    it("refuses to export a failed test as a measurement", async () => {
        await seedLatest({ping: -1, download: -1, upload: -1, error: "Cannot open socket"});

        const {status, text} = await metrics();

        assert.equal(status, 500);
        assert.doesNotMatch(text, /myspeed_download/);
    });
});
