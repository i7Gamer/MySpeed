import {afterEach, describe, it} from "node:test";
import assert from "node:assert/strict";
import {cleanup} from "../helpers/renderHarness.js";
import {onSessionExpired} from "@/common/utils/SessionExpiry";
import {
    baseRequest, jsonRequest, localPostRequest, login, postRequest, request
} from "@/common/utils/RequestUtil";
import {NODE_REFUSAL_HEADER} from "@/common/utils/AuthOutcome";

const HTTP_OK = 200;
const HTTP_UNAUTHORIZED = 401;
const HTTP_FORBIDDEN = 403;
const HTTP_SERVER_ERROR = 500;

const originalFetch = globalThis.fetch;
const unsubscribers = [];

afterEach(() => {
    for (const unsubscribe of unsubscribers.splice(0)) unsubscribe();
    globalThis.fetch = originalFetch;
    cleanup();
});

const respond = (status, headers = {}) => {
    globalThis.fetch = async () => ({
        ok: status >= HTTP_OK && status < 300,
        status,
        json: async () => ({}),
        text: async () => "{}",
        headers: {get: (name) => headers[name.toLowerCase()] ?? null}
    });
};

const listen = () => {
    const heard = {count: 0};
    unsubscribers.push(onSessionExpired(() => heard.count++));
    return heard;
};

/**
 * Sessions live in server memory, so a restart signs every open tab out - and
 * the background polls that then answer 401 used to swallow it. This is the one
 * place every API request passes through, so it is the one place that notices.
 */
describe("a 401 from an API request is reported once per response", () => {
    for (const [name, call] of [
        ["request", () => request("/status")],
        ["baseRequest", () => baseRequest("/nodes")],
        ["postRequest", () => postRequest("/speedtests/run")],
        ["localPostRequest", () => localPostRequest("/tokens")],
        ["jsonRequest", () => jsonRequest("/speedtests").catch(() => null)]
    ]) {
        it(`through ${name}`, async () => {
            const heard = listen();
            respond(HTTP_UNAUTHORIZED);
            await call();
            assert.equal(heard.count, 1);
        });
    }

    it("reaches every subscriber, and none after it unsubscribes", async () => {
        const first = listen();
        const second = {count: 0};
        const unsubscribe = onSessionExpired(() => second.count++);
        respond(HTTP_UNAUTHORIZED);

        await request("/status");
        unsubscribe();
        await request("/status");

        assert.equal(first.count, 2);
        assert.equal(second.count, 1);
    });
});

describe("what is not a lost session", () => {
    for (const status of [HTTP_OK, HTTP_FORBIDDEN, HTTP_SERVER_ERROR]) {
        it(`a ${status} is not reported`, async () => {
            const heard = listen();
            respond(status);
            await request("/status");
            assert.equal(heard.count, 0);
        });
    }

    it("a dropped connection is not reported", async () => {
        const heard = listen();
        globalThis.fetch = async () => { throw new TypeError("Failed to fetch"); };
        await request("/status").catch(() => null);
        assert.equal(heard.count, 0);
    });

    // The proxy relays a node rejecting its stored password as a 401 too, and
    // the password box in front of the visitor cannot answer that one.
    it("a remote node refusing its stored password is not reported", async () => {
        const heard = listen();
        respond(HTTP_UNAUTHORIZED, {[NODE_REFUSAL_HEADER]: "1"});
        await baseRequest("/nodes/2/speedtests?limit=1");
        assert.equal(heard.count, 0);
    });

    // A wrong password is the prompt's own business, and reporting it would
    // ask the prompt to open itself again.
    it("a refused login is not reported", async () => {
        const heard = listen();
        respond(HTTP_UNAUTHORIZED);
        const outcome = await login("wrong");
        assert.equal(outcome.ok, false);
        assert.equal(heard.count, 0);
    });

    // The config load reads its own 401 into the prompt; reporting it as well
    // would ask the provider to load the config that just failed again.
    it("a request that handles its own 401 can opt out", async () => {
        const heard = listen();
        respond(HTTP_UNAUTHORIZED);
        await request("/config", "GET", {}, {}, {reportsExpiry: false});
        assert.equal(heard.count, 0);
    });
});
