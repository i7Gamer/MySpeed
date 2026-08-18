import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describeDelta, hasPreviousData } from "../../client/src/common/components/Delta/deltas.js";

const ROOT = path.resolve(fileURLToPath(import.meta.url), "..", "..", "..");

/**
 * The comparison against the previous period, reduced to one honest sentence
 * per figure. The rules live in a pure function because the failure modes are
 * all judgement calls, not arithmetic: a fresh instance must not read "+100%"
 * against everything, a window nobody measured must not be treated as zero,
 * and "no change" is better said by silence than by "±0%".
 */
describe("describeDelta", () => {
    it("describes an improvement in a bigger-is-better figure", () => {
        const delta = describeDelta({current: 960, previous: 900, higherIsBetter: true});

        assert.equal(delta.direction, "up");
        assert.equal(delta.tone, "better");
        assert.equal(delta.label, "6.7%");
    });

    it("describes a worsening in a smaller-is-better figure", () => {
        const delta = describeDelta({current: 24, previous: 20, higherIsBetter: false});

        assert.equal(delta.direction, "up");
        assert.equal(delta.tone, "worse");
        assert.equal(delta.label, "20%");
    });

    it("describes an improvement in a smaller-is-better figure", () => {
        const delta = describeDelta({current: 18, previous: 20, higherIsBetter: false});

        assert.equal(delta.direction, "down");
        assert.equal(delta.tone, "better");
        assert.equal(delta.label, "10%");
    });

    // The number of tests carries no judgement either way; the change is still
    // worth a word, but not a colour.
    it("stays neutral for a figure that is neither better nor worse", () => {
        const delta = describeDelta({current: 42, previous: 40, higherIsBetter: null, mode: "absolute"});

        assert.equal(delta.tone, "neutral");
        assert.equal(delta.label, "2");
    });

    it("counts in absolute terms when asked to", () => {
        const delta = describeDelta({current: 5, previous: 2, higherIsBetter: false, mode: "absolute"});

        assert.equal(delta.direction, "up");
        assert.equal(delta.tone, "worse");
        assert.equal(delta.label, "3");
    });

    it("carries a unit through an absolute delta", () => {
        const delta = describeDelta({current: 1.2, previous: 0.8, higherIsBetter: false, mode: "absolute", unit: "%"});

        assert.equal(delta.label, "0.4%");
    });

    describe("saying nothing", () => {
        it("when there is no previous value", () => {
            for (const previous of [null, undefined])
                assert.equal(describeDelta({current: 960, previous, higherIsBetter: true}), null);
        });

        it("when there is no current value", () => {
            assert.equal(describeDelta({current: null, previous: 900, higherIsBetter: true}), null);
        });

        // "+100%" against a previous of zero is arithmetic, not information.
        it("when a percentage would divide by zero", () => {
            assert.equal(describeDelta({current: 5, previous: 0, higherIsBetter: true}), null);
        });

        // ...but an absolute count from zero is real: 0 failures to 3 is +3.
        it("never for an absolute change from zero", () => {
            const delta = describeDelta({current: 3, previous: 0, higherIsBetter: false, mode: "absolute"});

            assert.equal(delta.label, "3");
            assert.equal(delta.tone, "worse");
        });

        it("when nothing changed", () => {
            assert.equal(describeDelta({current: 900, previous: 900, higherIsBetter: true}), null);
            assert.equal(describeDelta({current: 2, previous: 2, higherIsBetter: false, mode: "absolute"}), null);
        });

        // A hair's difference reads as noise, not as a trend.
        it("when the change rounds to nothing", () => {
            assert.equal(describeDelta({current: 900.2, previous: 900, higherIsBetter: true}), null);
        });
    });

    it("rounds to one decimal and drops a trailing zero", () => {
        assert.equal(describeDelta({current: 110, previous: 100, higherIsBetter: true}).label, "10%");
        assert.equal(describeDelta({current: 106.7, previous: 100, higherIsBetter: true}).label, "6.7%");
    });
});

/**
 * The gate in front of every delta on the page: a previous window nobody
 * tested in has no figures to compare against, and comparing against its
 * zeros would call a working connection "infinitely worse".
 */
describe("hasPreviousData", () => {
    it("accepts a window with tests in it", () => {
        assert.equal(hasPreviousData({tests: {total: 12, failed: 2}}), true);
    });

    it("rejects a window nobody tested in", () => {
        assert.equal(hasPreviousData({tests: {total: 0, failed: 0}}), false);
    });

    it("rejects an answer with no previous window at all", () => {
        for (const previous of [null, undefined, {}])
            assert.equal(hasPreviousData(previous), false);
    });
});

/**
 * And the direction reaches a reader who cannot see the arrow.
 *
 * The whole of the direction was the glyph - "▲" or "▼" - inside a span marked
 * aria-hidden, which is right for the glyph and wrong for the annotation around
 * it: what was announced was a bare magnitude. "5%" is not a reading. On ping
 * and packet loss the two directions are opposite verdicts, so a screen-reader
 * user was handed the number that distinguishes an improvement from a
 * regression with the part that says which one removed.
 *
 * A source scan, like the other rendering rules here: node cannot parse JSX.
 */
describe("the delta states its direction in words", () => {
    const source = fs.readFileSync(
        path.join(ROOT, "client/src/common/components/Delta/Delta.jsx"), "utf8");
    const english = JSON.parse(fs.readFileSync(
        path.join(ROOT, "client/public/assets/locales/en.json"), "utf8"));

    it("labels the annotation with the direction and the figure", () => {
        assert.match(source, /aria-label=/,
            "the delta is announced as a bare magnitude, with nothing saying which way it went");
        assert.match(source, /statistics\.delta\./,
            "the direction is not named from a translated string");
    });

    // The glyph stays hidden: announced as well as labelled, a reader hears the
    // direction twice, once as an unpronounceable triangle.
    it("keeps the glyph itself out of the announcement", () => {
        assert.match(source, /stat-delta-arrow" aria-hidden="true"/,
            "the arrow glyph is announced as well as the label");
    });

    it("carries both directions in the source locale", () => {
        for (const direction of ["up", "down"])
            assert.equal(typeof english.statistics?.delta?.[direction], "string",
                `statistics.delta.${direction} is missing, so the label renders as its own key`);
    });
});
