import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { bootServer, api, seedTests } from "./helpers/boot.js";
import { getSetupToken } from "../../server/util/setupToken.js";

let server;
let nodeModel;
let integrationModel;

before(async () => {
    server = await bootServer();
    nodeModel = (await import("../../server/models/Node.js")).default;
    integrationModel = (await import("../../server/models/IntegrationData.js")).default;
});

after(async () => {
    await server?.close();
});

/**
 * The tests reach the server over loopback, which the passwordless gate treats
 * as local and lets through. A forwarding header is what tells the gate a proxy
 * is involved, so with TRUST_PROXY unset the request stops counting as local -
 * which is exactly the "someone on the network" case being exercised here.
 */
const REMOTE = {"x-forwarded-for": "203.0.113.5"};

const asRemote = (path, headers = {}) => api(server.baseUrl, path, {headers: {...REMOTE, ...headers}});

describe("passwordless instances", () => {
    it("serves a local caller unchallenged", async () => {
        assert.equal((await api(server.baseUrl, "/config")).status, 200);
    });

    // The whole point: a fresh install on a routable address used to be an
    // unauthenticated admin API.
    it("refuses a caller from the network", async () => {
        const {status, body} = await asRemote("/config");
        assert.equal(status, 401);
        assert.match(body.message, /setup token/i);
    });

    it("refuses to hand out the config backup to the network", async () => {
        assert.equal((await asRemote("/storage/config")).status, 401);
    });

    it("accepts the setup token in place of a password", async () => {
        const {status} = await asRemote("/config", {"x-password": getSetupToken()});
        assert.equal(status, 200);
    });

    it("rejects a wrong token", async () => {
        assert.equal((await asRemote("/config", {"x-password": "not-the-token"})).status, 401);
    });

    // A container healthcheck and an uptime monitor cannot present a token, and
    // the endpoint discloses nothing but liveness.
    it("still answers the health probe", async () => {
        assert.equal((await asRemote("/health")).status, 200);
    });
});

describe("metrics", () => {
    it("no longer serves anyone at all when no password is set", async () => {
        const {status} = await asRemote("/prometheus/metrics");
        assert.equal(status, 401);
    });

    it("accepts the setup token as the basic-auth password", async () => {
        const credentials = Buffer.from(`prometheus:${getSetupToken()}`).toString("base64");
        const {status} = await asRemote("/prometheus/metrics", {authorization: `Basic ${credentials}`});

        // 500 is the "no test recorded yet" answer, which still proves the
        // request got past authentication.
        assert.notEqual(status, 401);
    });

    it("rejects a malformed credential without a stack trace", async () => {
        const credentials = Buffer.from("no-colon-here").toString("base64");
        const {status, text} = await asRemote("/prometheus/metrics", {authorization: `Basic ${credentials}`});

        assert.equal(status, 401);
        assert.doesNotMatch(text, /at .*\.js:\d+/);
    });

    it("rejects the wrong username", async () => {
        const credentials = Buffer.from(`admin:${getSetupToken()}`).toString("base64");
        assert.equal((await asRemote("/prometheus/metrics", {authorization: `Basic ${credentials}`})).status, 401);
    });
});

describe("security headers", () => {
    it("refuses framing and sniffing", async () => {
        const {headers} = await api(server.baseUrl, "/health");

        assert.match(headers.get("content-security-policy"), /frame-ancestors 'none'/);
        assert.equal(headers.get("x-frame-options"), "DENY");
        assert.equal(headers.get("x-content-type-options"), "nosniff");
        assert.equal(headers.get("referrer-policy"), "no-referrer");
    });

    it("does not claim transport security over plain http", async () => {
        const {headers} = await api(server.baseUrl, "/health");
        assert.equal(headers.get("strict-transport-security"), null);
    });

    it("still hides the framework", async () => {
        const {headers} = await api(server.baseUrl, "/health");
        assert.equal(headers.get("x-powered-by"), null);
    });
});

describe("request body limits", () => {
    const oversized = JSON.stringify({value: "x".repeat(200000)});

    // 50mb used to apply to every route, and was parsed before any password
    // check ran.
    it("refuses an oversized body on an ordinary route", async () => {
        const {status} = await api(server.baseUrl, "/config/ping", {
            method: "PATCH",
            headers: {"content-type": "application/json"},
            body: oversized
        });

        assert.equal(status, 413);
    });

    // A restore legitimately carries years of history, so these two keep the
    // large limit - behind their own password check.
    it("still accepts a large import", async () => {
        const {status} = await api(server.baseUrl, "/storage/tests/history", {
            method: "PUT",
            headers: {"content-type": "application/json"},
            body: JSON.stringify(Array.from({length: 2000}, (unused, index) => ({
                ping: 10, jitter: 2, download: 100, upload: 50, time: 30, type: "auto",
                created: new Date(Date.UTC(2026, 0, 1, 0, index % 60)).toISOString(), error: null
            })))
        });

        assert.equal(status, 200);
    });
});

describe("query bounds", () => {
    it("refuses a range no retention policy could produce", async () => {
        const {status, body} = await api(server.baseUrl, "/speedtests/statistics?from=1900-01-01&to=2100-01-01");
        assert.equal(status, 400);
        assert.match(body.message, /more than \d+ days/);
    });

    it("still accepts an ordinary range", async () => {
        assert.equal((await api(server.baseUrl, "/speedtests/statistics?from=2026-08-01&to=2026-08-07")).status, 200);
    });

    it("clamps a limit that would pull the whole table", async () => {
        await seedTests(server.tests, Array.from({length: 1005}, (unused, index) => ({
            created: new Date(Date.UTC(2026, 7, 7, 0, 0, 0, index)).toISOString()
        })));

        const {body} = await api(server.baseUrl, "/speedtests?limit=99999999");
        assert.equal(body.length, 1000);
    });
});

describe("config export", () => {
    before(async () => {
        await nodeModel.destroy({where: {}});
        await integrationModel.destroy({where: {}});

        await nodeModel.create({name: "child", url: "http://192.168.1.50:5216", password: "childsecret"});
        await integrationModel.create({
            id: "abc", name: "telegram", displayName: "Telegram",
            data: {token: "123:supersecret", chat_id: "42", send_finished: true}
        });
    });

    it("redacts the node password by default", async () => {
        const {body} = await api(server.baseUrl, "/storage/config");

        assert.equal(body.nodes[0].name, "child", "the node itself still has to be restorable");
        assert.equal(body.nodes[0].password, null);
        assert.equal(body.secretsRedacted, true);
    });

    it("redacts integration credentials but keeps the rest", async () => {
        const {body, text} = await api(server.baseUrl, "/storage/config");
        const [integration] = body.integrations;
        const data = typeof integration.data === "string" ? JSON.parse(integration.data) : integration.data;

        assert.equal(data.token, null);
        assert.equal(data.chat_id, "42", "a non-secret field must survive");
        assert.doesNotMatch(text, /supersecret/);
    });

    it("hands over everything when explicitly asked", async () => {
        const {body} = await api(server.baseUrl, "/storage/config?includeSecrets=true");
        const [integration] = body.integrations;
        const data = typeof integration.data === "string" ? JSON.parse(integration.data) : integration.data;

        assert.equal(body.nodes[0].password, "childsecret");
        assert.equal(data.token, "123:supersecret");
        assert.equal(body.secretsRedacted, false);
    });
});

describe("node targets", () => {
    const createNode = (url) => api(server.baseUrl, "/nodes", {
        method: "PUT",
        headers: {"content-type": "application/json"},
        body: JSON.stringify({name: "probe", url, password: "x"})
    });

    it("refuses a loopback target", async () => {
        const {status, body} = await createNode("http://127.0.0.1:9");
        assert.equal(status, 400);
        assert.match(body.message, /loopback or link-local/);
    });

    // The pivot that makes SSRF worth having on a cloud host.
    it("refuses the cloud metadata address", async () => {
        assert.equal((await createNode("http://169.254.169.254")).status, 400);
    });

    it("refuses a non-http protocol", async () => {
        const {status, body} = await createNode("file:///etc/passwd");
        assert.equal(status, 400);
        assert.match(body.message, /http or https/);
    });

    // A hostname is only as safe as what it resolves to.
    it("refuses a name that resolves to loopback", async () => {
        assert.equal((await createNode("http://localhost:9")).status, 400);
    });
});

// Last: tripping a limiter leaves this client throttled for the rest of the
// window, which would fail anything that ran after it.
describe("rate limiting", () => {
    it("refuses a caller hammering an expensive endpoint", async () => {
        const range = "from=2026-08-01&to=2026-08-07";
        let refused = null;

        for (let attempt = 0; attempt < 25 && refused === null; attempt++) {
            const {status, body} = await api(server.baseUrl, `/speedtests/export?${range}`);
            if (status === 429) refused = body;
        }

        assert.notEqual(refused, null, "the export endpoint must be rate limited");
        assert.match(refused.message, /too many requests/i);
    });
});
