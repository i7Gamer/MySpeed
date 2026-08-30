import { describe, it } from "node:test";
import assert from "node:assert/strict";
import passwordWrapper from "../../server/middlewares/passwordWrapper.js";

/**
 * The wrapper that lets one route answer a failed password check with something
 * other than JSON - the opengraph banner, which has to send an image whatever
 * the session is.
 *
 * It does that by replacing res.send for the duration of the password check.
 * Nothing put it back: the replacement is an own property on the response, so
 * it outlived the check and stayed in place for the whole request. Any later
 * 401 on that response - one raised by a route, or by the error handler at the
 * end of the chain - then went to the banner handler instead of being sent,
 * because the patch cannot tell which 401 it is looking at.
 *
 * The check itself is unaffected: every 401 the password middleware issues is
 * returned from its own body, and every path that calls next() returns
 * immediately after, so by the time the chain moves on the patch has nothing
 * left to do.
 */
const fakeRes = (statusCode = 200) => {
    const res = {statusCode, sent: [], headersSent: false};
    res.send = function (body) {
        res.sent.push(body);
        return res;
    };
    return res;
};

// A request with no password header at all, which is the shape that reaches a
// decision without touching the database.
const bareReq = () => ({headers: {}, path: "/opengraph", ip: "127.0.0.1", socket: {}});

describe("the response the password wrapper borrows", () => {
    it("gives res.send back before the chain moves on", async () => {
        const res = fakeRes();
        const original = res.send;

        let seen = null;
        await passwordWrapper(true, () => "banner")(bareReq(), res, () => {
            seen = res.send;
        });

        assert.equal(seen, original,
            "the next middleware runs with the wrapper's res.send still in place");
    });

    it("gives it back after the chain has finished too", async () => {
        const res = fakeRes();
        const original = res.send;

        await passwordWrapper(true, () => "banner")(bareReq(), res, () => {});

        assert.equal(res.send, original, "the patch outlives the check it was made for");
    });

    /**
     * The reason it matters. A 401 raised later - by a route, or by the error
     * handler that ends the chain - is not the one the wrapper was watching
     * for, and must be sent rather than handed to the banner handler.
     */
    it("does not answer a later 401 with the custom handler", async () => {
        const res = fakeRes();
        let handled = 0;

        await passwordWrapper(true, () => { handled++; })(bareReq(), res, () => {});

        res.statusCode = 401;
        res.send("some other refusal");

        assert.equal(handled, 0, "an unrelated 401 was answered by the banner handler");
        assert.deepEqual(res.sent, ["some other refusal"]);
    });
});
