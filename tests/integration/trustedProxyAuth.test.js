import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { bootServer, api, setConfig } from "./helpers/boot.js";

/**
 * Header authentication end to end (upstream #767): the password middleware
 * admits a request that carries the configured header from a configured
 * proxy address, with a password set and no session anywhere in sight.
 *
 * The test process talks to the booted server over loopback, so loopback
 * plays the part of the trusted proxy; the untrusted-socket refusal is
 * exercised by pointing TRUSTED_AUTH_PROXIES somewhere else, which is also
 * what proves the setting is re-read rather than parsed once and kept.
 */

let server;
let resetTrustedProxyAuth;

const PASSWORD = "Hunter2!";
const GUARDED = "/speedtests?limit=1";

before(async () => {
    server = await bootServer();
    ({resetTrustedProxyAuth} = await import("../../server/util/trustedProxyAuth.js"));
});

after(async () => {
    delete process.env.TRUSTED_AUTH_HEADER;
    delete process.env.TRUSTED_AUTH_PROXIES;
    await server?.close();
});

beforeEach(async () => {
    process.env.TRUSTED_AUTH_HEADER = "Remote-User";
    process.env.TRUSTED_AUTH_PROXIES = "127.0.0.1,::1";
    resetTrustedProxyAuth();
    await setConfig(server.config, "password", PASSWORD);
    await setConfig(server.config, "passwordLevel", "none");
});

describe("a request the proxy signed in", () => {
    it("is admitted without a password or a session", async () => {
        const response = await api(server.baseUrl, GUARDED, {headers: {"Remote-User": "timo"}});

        assert.equal(response.status, 200);
    });

    it("is refused without the header", async () => {
        assert.equal((await api(server.baseUrl, GUARDED)).status, 401);
    });

    it("is refused with an empty assertion", async () => {
        const response = await api(server.baseUrl, GUARDED, {headers: {"Remote-User": "  "}});

        assert.equal(response.status, 401);
    });

    it("is refused once the socket is no longer a listed proxy", async () => {
        process.env.TRUSTED_AUTH_PROXIES = "203.0.113.7";

        const response = await api(server.baseUrl, GUARDED, {headers: {"Remote-User": "timo"}});

        assert.equal(response.status, 401);
    });
});
