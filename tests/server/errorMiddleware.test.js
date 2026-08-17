import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import errorMiddleware from "../../server/middlewares/error.js";

/**
 * Regression: the handler used to call bare next() for anything that was not a
 * SyntaxError. Inside an Express error handler that resumes the *normal*
 * middleware chain rather than ending the request, so body-parser failures
 * reached the route with req.body undefined and surfaced as a 500 with a stack
 * trace instead of the status body-parser had already chosen.
 */
const fakeRes = () => {
    const res = {headersSent: false, statusCode: null, body: null};
    res.status = (code) => {
        res.statusCode = code;
        return res;
    };
    res.json = (body) => {
        res.body = body;
        return res;
    };
    return res;
};

const run = (err, res = fakeRes()) => {
    let nextArgs = "not called";
    errorMiddleware(err, {}, res, (...args) => {
        nextArgs = args;
    });
    return {res, nextArgs};
};

describe("error middleware", () => {
    it("answers malformed JSON with 400", () => {
        const {res, nextArgs} = run(new SyntaxError("Unexpected token"));

        assert.equal(res.statusCode, 400);
        assert.equal(res.body.message, "You need to provide a valid JSON body");
        assert.equal(nextArgs, "not called");
    });

    it("preserves the status body-parser chose for an oversized body", () => {
        const err = Object.assign(new Error("request entity too large"), {status: 413});
        const {res, nextArgs} = run(err);

        assert.equal(res.statusCode, 413);
        assert.equal(res.body.message, "request entity too large");
        assert.equal(nextArgs, "not called");
    });

    it("honours statusCode when the error carries that instead", () => {
        assert.equal(run(Object.assign(new Error("nope"), {statusCode: 415})).res.statusCode, 415);
    });

    it("falls back to 500 for an error with no status", () => {
        const {res} = run(new Error("boom"));
        assert.equal(res.statusCode, 500);
    });

    // A 5xx message can carry internals, so only body-parser's own 4xx wording
    // is echoed back.
    it("does not echo the message of a server error", () => {
        const {res} = run(new Error("ENOENT: /srv/myspeed/data/storage.db"));

        assert.equal(res.body.message, "The request could not be processed");
        assert.doesNotMatch(res.body.message, /storage\.db/);
    });

    it("never resumes the normal chain", () => {
        for (const err of [new SyntaxError("x"), new Error("y"), Object.assign(new Error("z"), {status: 413})])
            assert.equal(run(err).nextArgs, "not called", `next() was called for ${err.message}`);
    });

    // Once the response has started there is nothing left to say; handing the
    // error on lets Express abort the connection instead of throwing
    // ERR_HTTP_HEADERS_SENT.
    it("forwards the error when the response already started", () => {
        const res = fakeRes();
        res.headersSent = true;
        const err = new Error("late");

        const {nextArgs} = run(err, res);
        assert.deepEqual(nextArgs, [err]);
        assert.equal(res.statusCode, null);
    });
});

/**
 * The other half of not echoing a server error: somebody has to be told.
 *
 * This is mounted last in app.js, after every route - the comment above it
 * saying otherwise had not kept up - so it is the catch-all for anything a
 * route throws, not only for what body-parser rejects. Those all became "The
 * request could not be processed" with the cause dropped on the floor: the
 * caller is told nothing, deliberately, and the operator was told nothing
 * either. An unhandled throw was invisible in the log of a running server.
 *
 * Client errors stay quiet. A malformed body is the caller's mistake, arrives
 * as often as anyone cares to send one, and logging it hands a stranger the
 * ability to fill the operator's disk.
 */
describe("what the error middleware tells the operator", () => {
    const realError = console.error;
    let logged;

    beforeEach(() => {
        logged = [];
        console.error = (...args) => logged.push(args);
    });

    afterEach(() => {
        console.error = realError;
    });

    it("logs a server error", () => {
        const err = new Error("ENOENT: /srv/myspeed/data/storage.db");

        run(err);

        assert.equal(logged.length, 1, "an unhandled route error was swallowed");
        assert.ok(logged[0].includes(err), "the error itself is what carries the stack");
    });

    it("logs one with no status at all", () => {
        run(Object.assign(new Error("boom"), {status: undefined}));

        assert.equal(logged.length, 1);
    });

    it("says nothing about a malformed body", () => {
        run(new SyntaxError("Unexpected token"));

        assert.deepEqual(logged, [], "a caller can fill the log by sending bad JSON");
    });

    it("says nothing about any client error", () => {
        for (const status of [400, 413, 415, 429, 499])
            run(Object.assign(new Error("client"), {status}));

        assert.deepEqual(logged, [], "a 4xx is the caller's mistake, not the server's");
    });

    // Still the server's fault, and still worth a line - the response is being
    // abandoned rather than answered, so this is the only record of it.
    it("logs a server error that arrived too late to answer", () => {
        const res = fakeRes();
        res.headersSent = true;

        run(new Error("late"), res);

        assert.equal(logged.length, 1);
    });
});
