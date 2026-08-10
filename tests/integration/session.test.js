import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { bootServer, api, setConfig } from "./helpers/boot.js";

let server;
let resetFailedAttempts;

const PASSWORD = "Hunter2!";
const GUARDED = "/speedtests?limit=1";

before(async () => {
    server = await bootServer();
    ({resetFailedAttempts} = await import("../../server/middlewares/password.js"));
});

after(async () => {
    await server?.close();
});

beforeEach(async () => {
    resetFailedAttempts();
    await setConfig(server.config, "password", PASSWORD);
    await setConfig(server.config, "passwordLevel", "none");
});

const signIn = (password) => api(server.baseUrl, "/session", {
    method: "POST",
    headers: {"content-type": "application/json"},
    body: JSON.stringify({password})
});

/** The cookie value a browser would send back, taken from Set-Cookie. */
const cookieFrom = (response) => (response.headers.get("set-cookie") ?? "").split(";")[0];

const withCookie = (cookie) => ({headers: {cookie}});

describe("POST /api/session", () => {
    it("exchanges the password for a cookie", async () => {
        const response = await signIn(PASSWORD);

        assert.equal(response.status, 200);
        assert.match(response.headers.get("set-cookie"), /^myspeed_session=/);
    });

    /**
     * The whole reason the session exists. The client used to keep the password
     * in localStorage and replay it forever: readable by any script on the page,
     * and impossible to revoke. HttpOnly is what puts the replacement out of
     * reach; SameSite stops the cookie turning every endpoint into a CSRF target
     * now that the browser attaches it on its own.
     */
    it("sets a cookie no script can read and no other site can send", async () => {
        const cookie = (await signIn(PASSWORD)).headers.get("set-cookie");

        assert.match(cookie, /HttpOnly/i);
        assert.match(cookie, /SameSite=Strict/i);
        assert.match(cookie, /Path=\//i);
    });

    it("never puts the password in the cookie", async () => {
        const cookie = (await signIn(PASSWORD)).headers.get("set-cookie");
        assert.doesNotMatch(cookie, new RegExp(PASSWORD));
    });

    it("refuses the wrong password", async () => {
        const response = await signIn("nope");

        assert.equal(response.status, 401);
        assert.equal(response.headers.get("set-cookie"), null);
    });

    it("rejects a request with no password at all", async () => {
        assert.equal((await signIn(undefined)).status, 400);
    });

    // Shares one counter with the password middleware, so an attacker cannot
    // win a fresh budget by switching between the two ways in.
    it("is throttled with the same counter as the header path", async () => {
        for (let i = 0; i < 20; i++) await signIn("nope");

        assert.equal((await signIn("nope")).status, 429);
        assert.equal((await api(server.baseUrl, GUARDED, {headers: {"x-password": "nope"}})).status, 429);
    });

    it("clears the counter on a successful sign-in", async () => {
        for (let i = 0; i < 19; i++) await signIn("nope");
        assert.equal((await signIn(PASSWORD)).status, 200);

        assert.equal((await signIn("nope")).status, 401, "the counter was not reset");
    });
});

describe("authenticating with the session", () => {
    it("opens a guarded route", async () => {
        const cookie = cookieFrom(await signIn(PASSWORD));
        assert.equal((await api(server.baseUrl, GUARDED, withCookie(cookie))).status, 200);
    });

    it("still refuses a request with no cookie", async () => {
        assert.equal((await api(server.baseUrl, GUARDED)).status, 401);
    });

    it("refuses a forged cookie", async () => {
        assert.equal((await api(server.baseUrl, GUARDED, withCookie("myspeed_session=deadbeef"))).status, 401);
    });

    // Scripts and integrations authenticate this way, so it has to keep working.
    it("leaves the password header working", async () => {
        assert.equal((await api(server.baseUrl, GUARDED, {headers: {"x-password": PASSWORD}})).status, 200);
    });

    it("grants full access, not read-only", async () => {
        await setConfig(server.config, "passwordLevel", "read");
        const cookie = cookieFrom(await signIn(PASSWORD));

        const {body} = await api(server.baseUrl, "/config", withCookie(cookie));
        assert.equal(body.viewMode, false);
    });
});

describe("DELETE /api/session", () => {
    it("signs out and stops working", async () => {
        const cookie = cookieFrom(await signIn(PASSWORD));

        const response = await api(server.baseUrl, "/session", {method: "DELETE", headers: {cookie}});
        assert.equal(response.status, 200);
        assert.match(response.headers.get("set-cookie"), /Max-Age=0/);

        assert.equal((await api(server.baseUrl, GUARDED, withCookie(cookie))).status, 401);
    });
});

describe("revocation", () => {
    /**
     * The point of not storing the password is that access can be taken back.
     * A session that outlived the password it was issued against would undo
     * exactly that.
     */
    it("drops every session when the password changes", async () => {
        const cookie = cookieFrom(await signIn(PASSWORD));
        assert.equal((await api(server.baseUrl, GUARDED, withCookie(cookie))).status, 200);

        await setConfig(server.config, "password", "A-different-1");

        assert.equal((await api(server.baseUrl, GUARDED, withCookie(cookie))).status, 401,
            "an old session survived the password change");
    });

    it("drops every session when the password is cleared", async () => {
        const cookie = cookieFrom(await signIn(PASSWORD));
        await server.config.clearPassword();

        // Sent as if forwarded, so the caller is not treated as local: an
        // unconfigured instance lets a local caller straight through, which
        // would mask whether the session itself was still being honoured.
        const {status} = await api(server.baseUrl, GUARDED, {
            headers: {cookie, "x-forwarded-for": "203.0.113.5"}
        });

        assert.equal(status, 401, "a session issued against the old password still worked");
    });

    it("still lets a valid session through while the password stands", async () => {
        const cookie = cookieFrom(await signIn(PASSWORD));

        const {status} = await api(server.baseUrl, GUARDED, {
            headers: {cookie, "x-forwarded-for": "203.0.113.5"}
        });

        assert.equal(status, 200, "the session was refused for the wrong reason");
    });
});

describe("GET /api/config", () => {
    it("says whether a password exists, without disclosing it", async () => {
        const cookie = cookieFrom(await signIn(PASSWORD));
        const {body, text} = await api(server.baseUrl, "/config", withCookie(cookie));

        assert.equal(body.passwordSet, true);
        assert.equal(body.password, undefined);
        assert.doesNotMatch(text, new RegExp(PASSWORD));
        assert.doesNotMatch(text, /\$2[aby]\$/);
    });

    it("reports an unprotected instance as such", async () => {
        await server.config.clearPassword();

        const {body} = await api(server.baseUrl, "/config");
        assert.equal(body.passwordSet, false);
    });
});
