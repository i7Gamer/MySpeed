import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { bootServer, api, setConfig } from "./helpers/boot.js";

let server;
let tokensModel;
let MAX_TOKENS;
let TOKEN_NAME_LIMIT;

const PASSWORD = "Hunter2!";

before(async () => {
    server = await bootServer();
    tokensModel = (await import("../../server/models/ApiTokens.js")).default;
    ({MAX_TOKENS, TOKEN_NAME_LIMIT} = await import("../../server/controller/tokens.js"));
});

after(async () => {
    await server?.close();
});

beforeEach(async () => {
    await setConfig(server.config, "password", PASSWORD);
    await setConfig(server.config, "passwordLevel", "none");
    await tokensModel.destroy({where: {}});
    server.resetRateLimits();
});

afterEach(() => {
    delete process.env.PREVIEW_MODE;
});

const json = {"content-type": "application/json"};

const asAdmin = (pathname, options = {}) =>
    api(server.baseUrl, pathname, {...options, headers: {"x-password": PASSWORD, ...options.headers}});

const withToken = (token, pathname, options = {}) =>
    api(server.baseUrl, pathname, {...options, headers: {authorization: `Bearer ${token}`, ...options.headers}});

const createToken = async (name = "Home Assistant") =>
    asAdmin("/tokens", {method: "POST", headers: json, body: JSON.stringify({name})});

describe("issuing a token", () => {
    it("hands the secret back once, and the list never repeats it", async () => {
        const created = await createToken();

        assert.equal(created.status, 201, JSON.stringify(created.body));
        assert.match(created.body.token, /^msp_[A-Za-z0-9_-]{43}$/);
        assert.equal(created.body.name, "Home Assistant");
        assert.equal(created.body.scope, "run");
        assert.equal(created.body.digest, undefined);

        const {status, body} = await asAdmin("/tokens");

        assert.equal(status, 200);
        assert.equal(body.length, 1);
        assert.equal(body[0].id, created.body.id);
        assert.equal(body[0].lastUsed, null);
        assert.equal(body[0].token, undefined);
        assert.equal(body[0].digest, undefined);
    });

    it("refuses a missing, blank or overlong name", async () => {
        for (const name of ["", "   ", "x".repeat(TOKEN_NAME_LIMIT + 1)])
            assert.equal((await createToken(name)).status, 400, JSON.stringify(name));

        assert.equal((await asAdmin("/tokens", {method: "POST", headers: json, body: "{}"})).status, 400);
    });

    it("trims the name", async () => {
        const created = await createToken("  Router hook  ");

        assert.equal(created.body.name, "Router hook");
    });

    it("stops at the cap", async () => {
        for (let i = 0; i < MAX_TOKENS; i++)
            assert.equal((await createToken(`token ${i}`)).status, 201);

        const refused = await createToken("one too many");

        assert.equal(refused.status, 400);
        assert.match(refused.body.message, new RegExp(String(MAX_TOKENS)));
    });

    it("needs the operator, not a viewer", async () => {
        await setConfig(server.config, "passwordLevel", "read");

        assert.equal((await api(server.baseUrl, "/tokens")).status, 401);
        assert.equal((await api(server.baseUrl, "/tokens",
            {method: "POST", headers: json, body: JSON.stringify({name: "x"})})).status, 401);
    });

    // A demo's password gate admits everyone, so the list would name every
    // token the operator holds. Blocked outright rather than read-only.
    it("is sealed on a demo, list included", async () => {
        await createToken();
        process.env.PREVIEW_MODE = "true";

        assert.equal((await asAdmin("/tokens")).status, 403);
        assert.equal((await createToken("demo")).status, 403);
    });
});

describe("using a token", () => {
    it("starts a test", async () => {
        const {body: {token}} = await createToken();

        const run = await withToken(token, "/speedtests/run", {method: "POST"});

        // No target is configured on this instance, and 410 is the honest
        // answer to that - it is what the operator's own click would get, and
        // it proves the gate let the token through.
        assert.equal(run.status, 410, JSON.stringify(run.body));
    });

    it("reads the live status, and nothing else", async () => {
        const {body: {token}} = await createToken();

        const live = await withToken(token, "/speedtests/status/live");
        assert.equal(live.status, 200);
        assert.equal(live.body.running, false);

        for (const pathname of ["/speedtests?limit=1", "/speedtests/status", "/config", "/tokens", "/targets"])
            assert.equal((await withToken(token, pathname)).status, 401, pathname);

        assert.equal((await withToken(token, "/speedtests/pause", {method: "POST"})).status, 401);
    });

    it("records when it was last used", async () => {
        const {body: {id, token}} = await createToken();

        await withToken(token, "/speedtests/status/live");

        const {body: [row]} = await asAdmin("/tokens");
        assert.equal(row.id, id);
        assert.match(row.lastUsed, /^\d{4}-\d{2}-\d{2}T/);
    });

    it("refuses a token nobody issued, and a revoked one", async () => {
        const {body: {id, token}} = await createToken();

        assert.equal((await withToken("msp_" + "A".repeat(43), "/speedtests/run", {method: "POST"})).status, 401);

        assert.equal((await asAdmin(`/tokens/${id}`, {method: "DELETE"})).status, 200);
        assert.equal((await withToken(token, "/speedtests/run", {method: "POST"})).status, 401);
        assert.equal((await asAdmin(`/tokens/${id}`, {method: "DELETE"})).status, 404);
    });

    // oauth2-proxy, Authelia and Authentik put a Bearer JWT on every request
    // they forward; the browser behind them still signs in by password.
    it("leaves a Bearer that is not a MySpeed token to the password", async () => {
        const jwt = "Bearer eyJhbGciOiJIUzI1NiJ9.e30.abc";

        assert.equal((await api(server.baseUrl, "/speedtests/run",
            {method: "POST", headers: {authorization: jwt}})).status, 401);
        assert.equal((await api(server.baseUrl, "/speedtests/run",
            {method: "POST", headers: {authorization: jwt, "x-password": PASSWORD}})).status, 410);
    });

    it("works on an instance that has no password yet", async () => {
        const {body: {token}} = await createToken();
        await setConfig(server.config, "password", "none");

        assert.equal((await withToken(token, "/speedtests/status/live")).status, 200);
    });
});

describe("tokens in the backup", () => {
    const exportConfig = (query = "") => asAdmin(`/storage/config${query}`);
    const importConfig = (body) =>
        asAdmin("/storage/config", {method: "PUT", headers: json, body: JSON.stringify(body)});

    it("stay out of a redacted export", async () => {
        await createToken();

        const {body} = await exportConfig();

        assert.equal(body.secretsRedacted, true);
        assert.equal(body.tokens, undefined);
    });

    it("travel with the secrets, and keep working after a restore", async () => {
        const {body: {token}} = await createToken();

        const {body: full} = await exportConfig("?includeSecrets=true");
        assert.equal(full.tokens.length, 1);
        assert.equal(full.tokens[0].token, undefined, "the export carries the secret itself");
        assert.match(full.tokens[0].digest, /^[0-9a-f]{64}$/);

        await tokensModel.destroy({where: {}});
        assert.equal((await withToken(token, "/speedtests/status/live")).status, 401);

        assert.equal((await importConfig(full)).status, 200);
        assert.equal((await withToken(token, "/speedtests/status/live")).status, 200);
    });

    it("survive restoring a backup that names none", async () => {
        const {body: {token}} = await createToken();
        const {body: redacted} = await exportConfig();

        assert.equal((await importConfig(redacted)).status, 200);
        assert.equal((await withToken(token, "/speedtests/status/live")).status, 200);
    });

    it("refuse a row the table could not have written", async () => {
        const {body: full} = await exportConfig("?includeSecrets=true");

        const refused = await importConfig({...full, tokens: [{name: "x", digest: "not-a-digest", scope: "run"}]});

        assert.equal(refused.status, 500);
        assert.equal(refused.body.key, "tokens");
    });
});
