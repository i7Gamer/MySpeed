import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
    mapFixed, mapRounded, toErrorMessage, stripTrailingSlashes, truncate, writeAtomically
} from "../../server/util/helpers.js";

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

/**
 * A measurement that is absent is not a measurement of nought.
 *
 * `time` is nullable in the model and is the one column handed here unfiltered,
 * so a row without it reaches this loop - and a null used to take the range
 * apart in two directions at once. It latched into `min`, because `null <
 * Infinity` is true and no later value ever displaces it: every comparison
 * against null coerces it to 0, so nothing is smaller. And it added nothing to
 * the total while still counting toward the divisor, dragging the average down
 * by however many were missing.
 *
 * Such a row needs a hand-edited or third-party history file to import - a
 * MySpeed export cannot produce one - which is what keeps this from being
 * urgent, not what keeps it from happening.
 */
describe("a value that was never measured", () => {
    const withNulls = [{time: null}, {time: 12}, {time: 14}];

    it("does not become the minimum", () => {
        assert.equal(mapRounded(withNulls, "time").min, 12,
            "an absent measurement is reported as the fastest one on record");
    });

    it("does not count as a zero in the average", () => {
        assert.equal(mapRounded(withNulls, "time").avg, 13,
            "the average is divided by rows that contributed nothing to it");
    });

    it("leaves the maximum alone", () => {
        assert.equal(mapRounded(withNulls, "time").max, 14);
    });

    it("is skipped the same way when it is undefined", () => {
        assert.deepEqual(mapRounded([{}, {time: 20}], "time"), {min: 20, max: 20, avg: 20});
    });

    // Nothing measured at all is the empty case, not a range of nulls.
    it("gives the empty answer when nothing was measured", () => {
        assert.deepEqual(mapRounded([{time: null}, {time: null}], "time"),
            {min: null, max: null, avg: null});
    });

    // A real zero is a real reading: a test that completed instantly is not a
    // test that did not happen.
    it("still counts a measured zero", () => {
        assert.deepEqual(mapRounded([{time: 0}, {time: 10}], "time"), {min: 0, max: 10, avg: 5});
    });
});

/**
 * The server lists are downloaded during boot and written straight over the
 * previous copy, so a container restarted mid-write left a truncated file - and
 * controller/servers.js answered the metrics scrape, the provider dialog and
 * librespeed's server selection out of whatever was there.
 */
describe("writeAtomically", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "myspeed-atomic-"));
    const target = path.join(dir, "servers.json");

    it("writes the contents", () => {
        writeAtomically(target, '{"1":"Frankfurt"}');

        assert.equal(fs.readFileSync(target, "utf8"), '{"1":"Frankfurt"}');
    });

    it("replaces what was there", () => {
        writeAtomically(target, '{"1":"Frankfurt"}');
        writeAtomically(target, '{"2":"Zurich"}');

        assert.equal(fs.readFileSync(target, "utf8"), '{"2":"Zurich"}');
    });

    // The rename is the whole point: nothing may be readable at the target
    // until the contents are complete.
    it("leaves no working file beside the target", () => {
        writeAtomically(target, '{"1":"Frankfurt"}');

        assert.deepEqual(fs.readdirSync(dir).filter((name) => name.endsWith(".tmp")), [],
            "a temporary file is left behind for every write");
    });

    it("clears up after a write it could not finish", () => {
        assert.throws(() => writeAtomically(path.join(dir, "missing", "servers.json"), "{}"));

        assert.deepEqual(fs.readdirSync(dir).filter((name) => name.endsWith(".tmp")), []);
    });

    // The previous list survives a failed replacement, which is the property
    // that makes this worth doing at all.
    it("leaves the old file intact when the write fails", () => {
        writeAtomically(target, '{"1":"Frankfurt"}');

        assert.throws(() => writeAtomically(target, {toString: () => { throw new Error("boom"); }}));

        assert.equal(fs.readFileSync(target, "utf8"), '{"1":"Frankfurt"}');
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

/**
 * Two things bound this text and neither trusts the other: what the database
 * column will hold, and what a provider will accept - cliOutput caps a failure
 * reason at 2000 characters, pushover refuses a message over 1024. Different
 * limits at different points, one rule for the cut.
 */
describe("truncate", () => {
    it("leaves text that already fits", () => {
        assert.equal(truncate("short", 20), "short");
    });

    it("leaves text of exactly the limit", () => {
        assert.equal(truncate("12345", 5), "12345");
    });

    it("cuts what is over, and says so", () => {
        const cut = truncate("abcdefghij", 5);

        assert.equal(cut.length, 5);
        assert.match(cut, /…$/);
        assert.equal(cut, "abcd…");
    });

    it("keeps the beginning, which is where the reason is", () => {
        assert.match(truncate("Cannot open socket to host".repeat(50), 30), /^Cannot open socket/);
    });

    /**
     * `limit - mark.length` underflows below the mark's own width, and a
     * negative end index slices from the end of the string - so this returned
     * six characters for a limit of nought, which is the one thing a bound must
     * never do. Unreachable through today's callers, which pass thousands.
     */
    it("never returns more than the limit, however small", () => {
        for (const limit of [0, 1, 2, 3]) {
            const cut = truncate("abcdefghij", limit);

            assert.ok(cut.length <= Math.max(limit, 1),
                `limit ${limit} produced ${cut.length} characters: ${JSON.stringify(cut)}`);
        }
    });

    it("stringifies whatever it is handed", () => {
        assert.equal(truncate(12345, 20), "12345");
        assert.equal(truncate(null, 20), "null");
    });
});
