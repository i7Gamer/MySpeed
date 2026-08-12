import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { PAUSE_INDEFINITE, pauseIntent } from "../../server/controller/pause.js";
import { serverListFrom } from "../../server/util/serverList.js";

/**
 * Three places that were strict about a type nobody had promised them.
 */

/**
 * What a POST /speedtests/pause body means.
 *
 * The route held `[0, -1]` and tested it with Array.includes, which compares
 * strictly - so a client sending the string "0" (a form-encoded body, an older
 * client, anything hand-rolled) missed the indefinite branch and fell through
 * to resumeIn("0"), which reads 0 as "no duration" and answers 400. The two
 * spellings of "until I say otherwise" are the dialog's own default and the
 * value older clients send, so neither is exotic.
 */
describe("pauseIntent", () => {
    it("reads the dialog's own indefinite value", () => {
        assert.equal(pauseIntent(0), PAUSE_INDEFINITE);
    });

    it("reads the value older clients send for indefinite", () => {
        assert.equal(pauseIntent(-1), PAUSE_INDEFINITE);
    });

    it("reads both of those as strings too", () => {
        assert.equal(pauseIntent("0"), PAUSE_INDEFINITE);
        assert.equal(pauseIntent("-1"), PAUSE_INDEFINITE);
    });

    it("reads a duration in hours", () => {
        assert.equal(pauseIntent(3), 3);
        assert.equal(pauseIntent("3"), 3);
    });

    // The dialog's own input offers half-hour steps.
    it("reads a fractional duration", () => {
        assert.equal(pauseIntent(0.5), 0.5);
        assert.equal(pauseIntent("0.5"), 0.5);
    });

    it("rejects an absent value", () => {
        assert.equal(pauseIntent(undefined), null);
        assert.equal(pauseIntent(null), null);
        assert.equal(pauseIntent(""), null);
    });

    it("rejects something that is not a number at all", () => {
        assert.equal(pauseIntent("soon"), null);
        assert.equal(pauseIntent({}), null);
        assert.equal(pauseIntent([]), null);
        assert.equal(pauseIntent(NaN), null);
        assert.equal(pauseIntent(Infinity), null);
    });

    /**
     * Any other negative is a mistake rather than a spelling of "indefinitely".
     * -1 is grandfathered; -5 is not.
     */
    it("rejects a negative that is not the grandfathered one", () => {
        assert.equal(pauseIntent(-5), null);
        assert.equal(pauseIntent("-5"), null);
    });
});

/**
 * The provider server lists, fetched once at startup.
 *
 * `(data ?? []).map(...)` guards against null and nothing else, and an API that
 * answers 200 with `{"error": "Rate limit exceeded"}` is not null - so .map ran
 * on an object and threw. The rejection was caught, but the only thing it said
 * was "Could not load servers", which is what a network failure says too, and
 * the provider dialog was left with an empty list until the next restart.
 */
describe("serverListFrom", () => {
    const format = (row) => row.name;

    it("indexes the rows by id", () => {
        const list = serverListFrom([{id: 1, name: "Frankfurt"}, {id: 2, name: "Berlin"}], format);

        assert.deepEqual(list, {1: "Frankfurt", 2: "Berlin"});
    });

    it("answers null for a payload that is not a list", () => {
        assert.equal(serverListFrom({error: "Rate limit exceeded"}, format), null,
            "an error object was mapped over, which throws inside the fetch handler");
        assert.equal(serverListFrom(null, format), null);
        assert.equal(serverListFrom(undefined, format), null);
        assert.equal(serverListFrom("nope", format), null);
    });

    /**
     * An empty list is a real answer and has to stay distinguishable from a
     * broken one - writing {} is correct, writing nothing is not.
     */
    it("answers an empty index for an empty list", () => {
        assert.deepEqual(serverListFrom([], format), {});
    });
});
