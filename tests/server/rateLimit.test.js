import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createRateLimit, MAX_TRACKED_CLIENTS } from "../../server/middlewares/rateLimit.js";

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

    /**
     * Which client is dropped when the table is full.
     *
     * Memory is bounded by evicting a single entry, and the entry chosen is the
     * one at the front of the Map's iteration order - which is insertion order.
     * A client whose window resets was written back with hits.set on a key that
     * was already there, and set() on an existing key keeps its original
     * position: so the longer a client had been using the instance, the nearer
     * the front it stayed, permanently. The table filling up therefore evicted
     * the most established caller rather than an idle one, handing them a fresh
     * counter and twice the limit, while clients that had gone away hours ago
     * sat behind them untouched.
     *
     * Deleting the key first moves it to the back, which turns "has been here
     * longest" into "has not been seen for longest".
     */
    describe("evicting a client when the table is full", () => {
        const CAP = 3;

        // A limiter whose clock the test drives, so a window can be expired for
        // one client without waiting and without expiring it for the others.
        const limiterAt = (clock) => createRateLimit({
            limit: 1, windowMs: 100, maxClients: CAP, now: () => clock.value
        });

        it("keeps the client it has just seen, and drops one that has gone quiet", () => {
            const clock = {value: 0};
            const limited = limiterAt(clock);

            // Two clients arrive together. The table is not yet full, which
            // matters: an eviction here would delete the front entry and the
            // write that follows would put it straight back, hiding the
            // ordering entirely.
            call(limited, requestFrom("1.1.1.1"));
            call(limited, requestFrom("2.2.2.2"));

            // The first comes back once its window has run out - the write that
            // used to leave it exactly where it was, at the front of the queue,
            // while the client behind it had not been seen since.
            clock.value = 200;
            assert.equal(call(limited, requestFrom("1.1.1.1")).passed, true, "a fresh window must let it through");

            // Now fill the table, so the arrival after it has to displace
            // something.
            call(limited, requestFrom("3.3.3.3"));
            call(limited, requestFrom("4.4.4.4"));

            // Still inside the window it opened at 200, so a second request is
            // over the limit - unless it was the one evicted, in which case it
            // is holding a brand new counter and gets another go.
            clock.value = 250;
            assert.equal(call(limited, requestFrom("1.1.1.1")).passed, false,
                "the client seen most recently was evicted, and was handed a fresh counter for it");
        });

        it("drops the one that went quiet instead", () => {
            const clock = {value: 0};
            const limited = limiterAt(clock);

            call(limited, requestFrom("1.1.1.1"));
            call(limited, requestFrom("2.2.2.2"));

            clock.value = 200;
            call(limited, requestFrom("1.1.1.1"));
            call(limited, requestFrom("3.3.3.3"));
            call(limited, requestFrom("4.4.4.4"));

            // The client that has not been seen since 0 is the one that should
            // have gone, so it comes back to a counter that starts again.
            clock.value = 250;
            assert.equal(call(limited, requestFrom("2.2.2.2")).passed, true);
            assert.equal(call(limited, requestFrom("2.2.2.2")).passed, false,
                "the evicted client was not re-tracked on its way back in");
        });

        it("still evicts, so the table stays bounded", () => {
            const clock = {value: 0};
            const limited = createRateLimit({limit: 1, windowMs: 10000, maxClients: CAP, now: () => clock.value});

            for (const ip of ["1.1.1.1", "2.2.2.2", "3.3.3.3"]) call(limited, requestFrom(ip));
            call(limited, requestFrom("4.4.4.4"));

            // The oldest, none of the three having been seen since.
            assert.equal(call(limited, requestFrom("1.1.1.1")).passed, true,
                "nothing was evicted, so the table grows without bound");
        });

        it("leaves the clients it did not evict counting", () => {
            const clock = {value: 0};
            const limited = createRateLimit({limit: 1, windowMs: 10000, maxClients: CAP, now: () => clock.value});

            for (const ip of ["1.1.1.1", "2.2.2.2", "3.3.3.3"]) call(limited, requestFrom(ip));
            call(limited, requestFrom("4.4.4.4"));

            assert.equal(call(limited, requestFrom("3.3.3.3")).passed, false,
                "an entry that should have survived lost its count");
        });

        it("defaults to a cap rather than tracking clients without limit", () => {
            assert.ok(MAX_TRACKED_CLIENTS > 0 && Number.isFinite(MAX_TRACKED_CLIENTS));
        });
    });

    it("uses the supplied message", () => {
        const custom = createRateLimit({limit: 0, message: "slow down"});
        const {res} = call(custom, requestFrom("1.1.1.1"));
        assert.equal(res.sent.body, null, "the first request opens the window and is never refused");

        const second = call(custom, requestFrom("1.1.1.1"));
        assert.equal(second.res.sent.body.message, "slow down");
    });
});
