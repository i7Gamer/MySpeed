import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mapFixed, mapRounded, toErrorMessage, stripTrailingSlashes } from "../../server/util/helpers.js";

const entries = [
    {download: 100.123, ping: 10},
    {download: 200.456, ping: 21},
    {download: 300.789, ping: 32}
];

describe("mapFixed", () => {
    it("returns min, max and a 2-decimal average", () => {
        assert.deepEqual(mapFixed(entries, "download"), {min: 100.123, max: 300.789, avg: 200.46});
    });

    it("handles a single entry", () => {
        assert.deepEqual(mapFixed([{download: 50}], "download"), {min: 50, max: 50, avg: 50});
    });

    // Regression: Math.min(...[]) is Infinity and 0/0 is NaN, so an empty set
    // used to yield {min: Infinity, max: -Infinity, avg: NaN}. That reaches the
    // API whenever every test in a range failed, or when the provider reports
    // no jitter at all.
    it("returns nulls for an empty set instead of Infinity/NaN", () => {
        assert.deepEqual(mapFixed([], "download"), {min: null, max: null, avg: null});
    });

    it("never returns a non-finite number for an empty set", () => {
        const result = mapFixed([], "download");
        for (const value of Object.values(result)) assert.notEqual(Number.isNaN(value), true);
    });

    /**
     * Regression: Math.min(...values) puts every value onto the call stack, so
     * a range holding ~125k tests - a year of five-minute testing - threw
     * RangeError and the statistics endpoint answered 500 with no way back
     * short of narrowing the range.
     */
    it("stays within the call stack on six-figure ranges", () => {
        const entries = Array.from({length: 200000}, (_, i) => ({download: i % 100}));

        assert.deepEqual(mapFixed(entries, "download"), {min: 0, max: 99, avg: 49.5});
    });
});

describe("mapRounded", () => {
    it("returns min, max and a rounded average", () => {
        assert.deepEqual(mapRounded(entries, "ping"), {min: 10, max: 32, avg: 21});
    });

    it("returns nulls for an empty set instead of Infinity/NaN", () => {
        assert.deepEqual(mapRounded([], "ping"), {min: null, max: null, avg: null});
    });
});

describe("stripTrailingSlashes", () => {
    it("leaves a url without a trailing slash alone", () => {
        assert.equal(stripTrailingSlashes("http://10.0.0.2:5216"), "http://10.0.0.2:5216");
    });

    it("removes a single trailing slash", () => {
        assert.equal(stripTrailingSlashes("http://10.0.0.2:5216/"), "http://10.0.0.2:5216");
    });

    it("removes a run of trailing slashes", () => {
        assert.equal(stripTrailingSlashes("http://10.0.0.2:5216////"), "http://10.0.0.2:5216");
    });

    it("keeps slashes that are not at the end", () => {
        assert.equal(stripTrailingSlashes("http://host/a//b/"), "http://host/a//b");
    });

    it("handles an all-slash and an empty value", () => {
        assert.equal(stripTrailingSlashes("////"), "");
        assert.equal(stripTrailingSlashes(""), "");
        assert.equal(stripTrailingSlashes(null), "");
    });

    /**
     * Regression: /\/+$/ is polynomial. On 100k slashes followed by a
     * non-slash the engine retries the run from every position, which took
     * long enough to be a usable denial of service against an admin endpoint.
     */
    it("stays fast on a pathological run of slashes", () => {
        const hostile = "http://host" + "/".repeat(100000) + "x";

        const startedAt = process.hrtime.bigint();
        const result = stripTrailingSlashes(hostile);
        const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;

        assert.equal(result, hostile);
        assert.ok(elapsedMs < 100, `took ${Math.round(elapsedMs)}ms`);
    });
});

describe("toErrorMessage", () => {
    it("passes a plain string through", () => {
        assert.equal(toErrorMessage("Too many requests"), "Too many requests");
    });

    it("unwraps the message of an Error", () => {
        assert.equal(toErrorMessage(new Error("spawn ENOENT")), "spawn ENOENT");
    });

    it("unwraps the message of a thrown plain object", () => {
        assert.equal(toErrorMessage({message: "No provider selected"}), "No provider selected");
    });

    /**
     * Regression: the speedtest CLI's 'error' event was rejected as
     * {message: errorInstance}, so the wrapper had a `message` key and the
     * `?? String(e)` fallback never ran. The Error object then reached
     * tests.create(), where Sequelize's _.isObject() check on the TEXT column
     * threw - the failed test was never recorded at all.
     */
    it("stringifies an Error nested inside a message wrapper", () => {
        const message = toErrorMessage({message: new Error("spawn ./bin/speedtest ENOENT")});

        assert.equal(typeof message, "string");
        assert.match(message, /spawn \.\/bin\/speedtest ENOENT/);
    });

    it("never returns a non-string, whatever it is handed", () => {
        for (const thrown of [null, undefined, 0, "", {}, [], new Error(), {message: null}, Symbol("x")])
            assert.equal(typeof toErrorMessage(thrown), "string", `failed for ${String(thrown)}`);
    });

    it("names the failure rather than storing an empty string", () => {
        assert.equal(toErrorMessage(undefined), "Unknown error");
        assert.equal(toErrorMessage(new Error()), "Unknown error");
    });
});
