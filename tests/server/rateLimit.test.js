import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createRateLimit } from "../../server/middlewares/rateLimit.js";

const requestFrom = (ip) => ({ip, socket: {remoteAddress: ip}, headers: {}});

const responseSpy = () => {
    const sent = {status: null, body: null, headers: {}};
    return {
        sent,
        setHeader: (name, value) => { sent.headers[name.toLowerCase()] = value; },
        status(code) { sent.status = code; return this; },
        json(body) { sent.body = body; return this; }
    };
};

/** Drives one request through the limiter and reports whether it passed. */
const call = (middleware, req) => {
    let passed = false;
    const res = responseSpy();
    middleware(req, res, () => { passed = true; });
    return {passed, res};
};

describe("createRateLimit", () => {
    let limiter;

    beforeEach(() => {
        limiter = createRateLimit({limit: 3, windowMs: 60000});
    });

    it("lets requests through up to the limit", () => {
        const req = requestFrom("1.1.1.1");
        for (let attempt = 0; attempt < 3; attempt++)
            assert.equal(call(limiter, req).passed, true, `attempt ${attempt + 1} should pass`);
    });

    it("refuses the request after the limit with a 429", () => {
        const req = requestFrom("1.1.1.1");
        for (let attempt = 0; attempt < 3; attempt++) call(limiter, req);

        const {passed, res} = call(limiter, req);
        assert.equal(passed, false);
        assert.equal(res.sent.status, 429);
        assert.match(res.sent.body.message, /too many requests/i);
    });

    it("tells the caller when to come back", () => {
        const req = requestFrom("1.1.1.1");
        for (let attempt = 0; attempt < 4; attempt++) call(limiter, req);

        const {res} = call(limiter, req);
        const retryAfter = Number(res.sent.headers["retry-after"]);
        assert.ok(retryAfter > 0 && retryAfter <= 60, `unexpected Retry-After: ${retryAfter}`);
    });

    // The whole point of keying per client: one noisy caller must not lock out
    // everyone else.
    it("counts each client separately", () => {
        const noisy = requestFrom("1.1.1.1");
        for (let attempt = 0; attempt < 4; attempt++) call(limiter, noisy);

        assert.equal(call(limiter, noisy).passed, false);
        assert.equal(call(limiter, requestFrom("2.2.2.2")).passed, true);
    });

    it("starts a fresh window once the old one has expired", () => {
        const shortLived = createRateLimit({limit: 1, windowMs: -1});
        const req = requestFrom("1.1.1.1");

        assert.equal(call(shortLived, req).passed, true);
        assert.equal(call(shortLived, req).passed, true, "an expired window must not carry its count over");
    });

    it("falls back to the socket address when req.ip is absent", () => {
        const withoutIp = {socket: {remoteAddress: "3.3.3.3"}, headers: {}};
        for (let attempt = 0; attempt < 3; attempt++) call(limiter, withoutIp);

        assert.equal(call(limiter, withoutIp).passed, false, "the socket address must still key the counter");
    });

    it("groups callers it cannot identify rather than exempting them", () => {
        const anonymous = {socket: {}, headers: {}};
        for (let attempt = 0; attempt < 3; attempt++) call(limiter, anonymous);

        assert.equal(call(limiter, anonymous).passed, false);
    });

    it("clears every counter on reset", () => {
        const req = requestFrom("1.1.1.1");
        for (let attempt = 0; attempt < 4; attempt++) call(limiter, req);

        limiter.reset();
        assert.equal(call(limiter, req).passed, true);
    });

    it("uses the supplied message", () => {
        const custom = createRateLimit({limit: 0, message: "slow down"});
        const {res} = call(custom, requestFrom("1.1.1.1"));
        assert.equal(res.sent.body, null, "the first request opens the window and is never refused");

        const second = call(custom, requestFrom("1.1.1.1"));
        assert.equal(second.res.sent.body.message, "slow down");
    });
});
