import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { figureMeets, meetsLimits, resolveLimits, targetMetOver } from "../../server/util/targetLimits.js";

/**
 * The server's copy of the grading rule, on its own.
 *
 * The parity with the client's colours is tests/client/targetMetParity.test.js;
 * this file pins what the aggregate does with the verdicts - which rows are
 * judged at all, and which of the judged ones count as met.
 */
const LIMITS = {ping: 25, download: 100, upload: 50};

// A test the rule counts as met, and the three single-figure misses beside it.
const MET = {ping: 20, download: 120, upload: 60};
const SLOW_DOWNLOAD = {...MET, download: 70};
const SLOW_UPLOAD = {...MET, upload: 30};
const HIGH_PING = {...MET, ping: 40};

describe("resolveLimits", () => {
    it("prefers the target's own optimal values", () => {
        assert.deepEqual(resolveLimits({optimalPing: 30, optimalDownload: 200, optimalUpload: 80}, LIMITS),
            {ping: 30, download: 200, upload: 80});
    });

    it("falls back to the settings figure by figure", () => {
        assert.deepEqual(resolveLimits({optimalPing: 30, optimalDownload: null, optimalUpload: null}, LIMITS),
            {ping: 30, download: 100, upload: 50});
    });

    it("falls back wholesale for a row with no target", () => {
        assert.deepEqual(resolveLimits(undefined, LIMITS), LIMITS);
        assert.deepEqual(resolveLimits(null, LIMITS), LIMITS);
    });

    it("reads the strings the config table stores as numbers", () => {
        assert.deepEqual(resolveLimits(undefined, {ping: "25", download: "100", upload: "50"}), LIMITS);
    });

    it("answers null for an optimum that is absent, empty, zero or junk", () => {
        for (const value of [null, undefined, "", 0, "0", -5, "fast", NaN])
            assert.equal(resolveLimits(undefined, {ping: value}).ping, null, `an optimum of ${JSON.stringify(value)}`);
    });
});

describe("figureMeets", () => {
    it("takes a speed at three quarters of its optimum as good, and a hair under as not", () => {
        assert.equal(figureMeets(75, 100, true), true);
        assert.equal(figureMeets(74.99, 100, true), false);
    });

    it("takes a latency up to, but not at, 130% of its optimum as good", () => {
        assert.equal(figureMeets(32.4, 25, false), true);
        assert.equal(figureMeets(32.5, 25, false), false);
    });

    it("refuses a ratio it cannot compute", () => {
        assert.equal(figureMeets(100, 0, true), false);
        assert.equal(figureMeets(NaN, 100, true), false);
    });
});

describe("meetsLimits", () => {
    it("is met only when every figure is", () => {
        assert.equal(meetsLimits(MET, LIMITS), true);
        assert.equal(meetsLimits(SLOW_DOWNLOAD, LIMITS), false);
        assert.equal(meetsLimits(SLOW_UPLOAD, LIMITS), false);
        assert.equal(meetsLimits(HIGH_PING, LIMITS), false);
    });

    it("does not judge a figure with no optimum", () => {
        assert.equal(meetsLimits(HIGH_PING, {...LIMITS, ping: null}), true);
    });

    it("does not judge a latency nobody measured", () => {
        assert.equal(meetsLimits({...MET, ping: 0}, LIMITS), true);
    });

    it("grades the latency the interface prints, trimmed to one decimal", () => {
        // 32.46 raw is 129.84% of 25, which floors to green; printed as 32.5 it
        // is exactly 130%, which the row paints orange. The screen wins.
        assert.equal(meetsLimits({...MET, ping: 32.46}, LIMITS), false);
        assert.equal(meetsLimits({...MET, ping: 32.44}, LIMITS), true);
    });

    it("reads a figure stored as text", () => {
        assert.equal(meetsLimits({ping: "20", download: "120", upload: "60"}, LIMITS), true);
    });

    it("answers null when nothing on the row can be judged", () => {
        assert.equal(meetsLimits(MET, {ping: null, download: null, upload: null}), null);
        assert.equal(meetsLimits({ping: 0, download: null, upload: "fast"}, LIMITS), null);
    });
});

describe("targetMetOver", () => {
    const always = () => LIMITS;

    it("counts the met tests out of the judged ones", () => {
        assert.deepEqual(targetMetOver([MET, SLOW_DOWNLOAD, MET, HIGH_PING], always), {met: 2, measured: 4});
    });

    it("keeps an unjudgeable row out of both counts", () => {
        assert.deepEqual(targetMetOver([MET, {ping: 0, download: null, upload: null}], always), {met: 1, measured: 1});
    });

    it("keeps a row whose target has no limits out of both counts", () => {
        assert.deepEqual(targetMetOver([MET, {...MET, targetId: 2}], (id) => id === 2 ? null : LIMITS),
            {met: 1, measured: 1});
    });

    it("resolves each row through its own target", () => {
        const strict = {ping: 5, download: 1000, upload: 1000};
        const counted = targetMetOver([{...MET, targetId: 1}, {...MET, targetId: 2}],
            (id) => id === 2 ? strict : LIMITS);

        assert.deepEqual(counted, {met: 1, measured: 2});
    });

    it("hands a row with no target to the resolver as null", () => {
        const asked = [];
        targetMetOver([MET, {...MET, targetId: 3}], (id) => { asked.push(id); return LIMITS; });

        assert.deepEqual(asked, [null, 3]);
    });

    it("answers zeros for an empty range", () => {
        assert.deepEqual(targetMetOver([], always), {met: 0, measured: 0});
    });

    it("answers null with no resolver, so an older caller renders no row", () => {
        assert.equal(targetMetOver([MET]), null);
    });
});
