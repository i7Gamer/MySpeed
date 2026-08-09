import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { bootServer, api, setConfig } from "./helpers/boot.js";
import {
    PASSWORD_REQUIRED, SETUP_TOKEN_REQUIRED, TOO_MANY_ATTEMPTS
} from "../../server/util/authOutcome.js";

let server;
let resetFailedAttempts;

const MAX_FAILED_ATTEMPTS = 20;

before(async () => {
    server = await bootServer();
    ({resetFailedAttempts} = await import("../../server/middlewares/password.js"));
});

after(async () => {
    await server?.close();
});

beforeEach(async () => {
    resetFailedAttempts();
    await setConfig(server.config, "password", "none");
    await setConfig(server.config, "passwordLevel", "none");
});

/**
 * The tests reach the server over loopback, which the passwordless gate treats
 * as local and lets through. A forwarding header is what makes the request stop
 * counting as local - the "someone on the network" case being exercised here.
 */
const REMOTE = {"x-forwarded-for": "203.0.113.5"};

const asRemote = (path, headers = {}) => api(server.baseUrl, path, {headers: {...REMOTE, ...headers}});

const signIn = (password) => api(server.baseUrl, "/session", {
    method: "POST",
    headers: {"content-type": "application/json", ...REMOTE},
    body: JSON.stringify({password})
});

/**
 * Three different refusals used to arrive as an indistinguishable 401, so the
 * interface asked for "your password" in all of them - including on an instance
 * that has no password, where the answer is a setup token the operator has
 * never heard of and cannot guess. The client needs to tell them apart without
 * parsing an English sentence that changes with every translation.
 */
describe("what a refusal says it is", () => {
    describe("an instance with no password", () => {
        it("names the setup token when it refuses a network caller", async () => {
            const {status, body} = await asRemote("/speedtests?limit=1");

            assert.equal(status, 401);
            assert.equal(body.type, SETUP_TOKEN_REQUIRED);
        });

        it("names it on the login route too, so a wrong token says the same thing", async () => {
            const {status, body} = await signIn("not-the-token");

            assert.equal(status, 401);
            assert.equal(body.type, SETUP_TOKEN_REQUIRED);
        });

        // The message is what a human reads; the type is what the client
        // switches on. Losing the sentence would be a regression of its own.
        it("still explains itself in words", async () => {
            const {body} = await asRemote("/speedtests?limit=1");

            assert.match(body.message, /setup token/i);
        });
    });

    describe("an instance with a password", () => {
        beforeEach(async () => {
            await setConfig(server.config, "password", "hunter2");
        });

        it("asks for the password when none is supplied", async () => {
            const {status, body} = await asRemote("/speedtests?limit=1");

            assert.equal(status, 401);
            assert.equal(body.type, PASSWORD_REQUIRED);
        });

        it("asks for the password when the wrong one is supplied", async () => {
            const {status, body} = await asRemote("/speedtests?limit=1", {"x-password": "wrong"});

            assert.equal(status, 401);
            assert.equal(body.type, PASSWORD_REQUIRED);
        });

        it("says the same on the login route", async () => {
            const {status, body} = await signIn("wrong");

            assert.equal(status, 401);
            assert.equal(body.type, PASSWORD_REQUIRED);
        });

        // Never the token: an instance with a password does not accept one, and
        // sending the operator to the log would be a wild goose chase.
        it("never names the setup token once a password exists", async () => {
            const {body} = await asRemote("/speedtests?limit=1");

            assert.notEqual(body.type, SETUP_TOKEN_REQUIRED);
        });
    });

    /**
     * The lockout is the case the interface got most wrong: it is not a wrong
     * password, and re-asking for one invites the operator to keep hammering a
     * throttle that answers nothing until it expires.
     */
    describe("a caller who has been locked out", () => {
        beforeEach(async () => {
            await setConfig(server.config, "password", "hunter2");

            for (let attempt = 0; attempt < MAX_FAILED_ATTEMPTS; attempt++)
                await asRemote("/speedtests?limit=1", {"x-password": "wrong"});
        });

        it("says it is a lockout rather than a wrong password", async () => {
            const {status, body} = await asRemote("/speedtests?limit=1", {"x-password": "wrong"});

            assert.equal(status, 429);
            assert.equal(body.type, TOO_MANY_ATTEMPTS);
        });

        it("says so on the login route, which shares the counter", async () => {
            const {status, body} = await signIn("wrong");

            assert.equal(status, 429);
            assert.equal(body.type, TOO_MANY_ATTEMPTS);
        });
    });
});
