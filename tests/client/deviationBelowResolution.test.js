import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { formatLatency, LATENCY_STEP, roundsToZeroLatency } from "@/common/utils/FormatUtil.js";

const CLIENT_SRC = path.resolve(fileURLToPath(import.meta.url), "..", "..", "..", "client", "src");

const card = fs.readFileSync(path.join(CLIENT_SRC,
    "pages/Statistics/charts/ConsistencyChart/ConsistencyChart.jsx"), "utf8");

/**
 * A spread too small to print, told apart from no spread at all.
 *
 * The server sends the ping deviation at two decimals and the card shows one,
 * so anything under 0.05 rounded away to "0" - and parseFloat drops the
 * trailing zero, so it did not even read as a rounded figure. "±0 ms" is the
 * strongest claim this row makes, a line whose latency never moved between two
 * tests, and it was being borrowed by any spread merely below the display's
 * resolution.
 *
 * Not a hypothetical: a history whose pings are whole numbers really does have
 * a median absolute deviation of exactly zero - more than half the tests land
 * on the median - while the same instance's newer rows, measured to two
 * decimals, sit a few hundredths apart. Both would have printed "±0 ms".
 */
describe("roundsToZeroLatency", () => {
    it("is true for a value that has a spread too small to show", () => {
        for (const ms of [0.001, 0.01, 0.04, 0.049])
            assert.equal(roundsToZeroLatency(ms), true, `${ms} prints as 0 and must say so`);
    });

    // Genuinely zero: every test within the range sat on the median. That is a
    // real reading and keeps the plain "±0".
    it("is false for a real zero", () => {
        assert.equal(roundsToZeroLatency(0), false);
    });

    // From 0.05 up the one decimal carries it, so there is nothing to explain.
    it("is false once one decimal can show it", () => {
        for (const ms of [0.05, 0.1, 0.8, 4.2])
            assert.equal(roundsToZeroLatency(ms), false, `${ms} is printable at one decimal`);
    });

    // The same non-numbers formatLatency passes through: null is "not measured"
    // and -1 is the placeholder a failed test stores.
    it("is false for anything that is not a measurement", () => {
        for (const value of [null, undefined, NaN, Infinity, -1, "0.02", {}])
            assert.equal(roundsToZeroLatency(value), false, `${String(value)} is not a spread`);
    });

    // The bound the card prints has to be the smallest thing the card can
    // print, or it states a limit that is not the real one.
    it("names the smallest latency one decimal can express", () => {
        assert.equal(LATENCY_STEP, 0.1);
        assert.equal(formatLatency(LATENCY_STEP), LATENCY_STEP,
            "the step itself does not survive the formatter it describes");
    });
});

describe("the stability card distinguishes a small spread from none", () => {
    it("consults the check before printing the deviation", () => {
        assert.match(card, /roundsToZeroLatency\(data\.ping\.deviation\)/,
            "the card still prints ±0 for a spread that merely rounds away");
    });

    it("prints the bound rather than a figure it cannot show", () => {
        assert.match(card, /±<\$\{LATENCY_STEP}/,
            "the card states no bound for a spread below its own resolution");
    });

    // The real zero keeps the plain reading it has always had.
    it("still prints a measured deviation through the shared helper", () => {
        assert.match(card, /deviation\(formatLatency\(data\.ping\.deviation\), t\("latest\.ping_unit"\)\)/,
            "the ordinary path lost the formatter every other latency here uses");
    });

    // A few hundredths of a millisecond is an excellent line, so the colour
    // must not change with the wording.
    it("grades a sub-resolution spread as the steady line it is", () => {
        assert.match(card, /pingDeviationColour\(formatLatency\(data\.ping\.deviation\)\)/,
            "the grade is no longer taken from the trimmed figure");
    });
});
