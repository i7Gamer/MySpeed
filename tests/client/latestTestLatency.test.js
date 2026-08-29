import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const CLIENT_SRC = path.resolve(fileURLToPath(import.meta.url), "..", "..", "..", "client", "src");

const card = fs.readFileSync(path.join(CLIENT_SRC,
    "pages/Statistics/charts/LatestTestChart/LatestTestChart.jsx"), "utf8");

/**
 * The statistics "Latest test" card, and the precision it prints a latency at.
 *
 * The latency columns used to be integers, so a card could render one straight
 * out of the record. They keep two decimals now, and formatLatency was
 * introduced to trim the ones on screen back to one - applied to the overview
 * row and to the detail pane, but not here. So the same measurement read
 * "12.64 ms" on this card and "12.6 ms" in the pane that opens from clicking
 * it, one on top of the other.
 *
 * A source scan, as with the other rendering rules: node cannot parse JSX, and
 * every one of these renders perfectly - it renders a figure at a precision the
 * card beside it contradicts.
 */
describe("the latest-test card prints its latencies to one decimal", () => {
    it("finds the card to check", () => {
        assert.match(card, /latest\.ping/, "the card no longer draws a ping at all");
        assert.match(card, /import \{[^}]*formatLatency[^}]*} from "@\/common\/utils\/FormatUtil"/,
            "the card cannot trim anything - it never imports the formatter");
    });

    it("prints the ping the pane behind it prints", () => {
        assert.match(card, /const ping = formatLatency\(props\.test\.ping\)/,
            "the ping still goes out at the two decimals it is stored with");
    });

    /**
     * The failure placeholder is not a measurement, and the card says so in
     * words rather than printing the -1 the row stores.
     *
     * The stop is formatWithUnit now - the one refusal every unit-print in
     * the interface goes through - rather than a card-local helper wrapped
     * around each row. Pinned here: the ping row's wiring, and what the
     * formatter answers for the placeholder in either spelling at every
     * row's destination; the speeds' wiring pin lives with panelPrecision's
     * rounding contract.
     */
    it("still names a failed test rather than printing its placeholder", async () => {
        const {formatWithUnit, formatWhole, wholeSpeed} =
            await import("../../client/src/common/utils/FormatUtil.js");

        assert.match(card, /value=\{formatWithUnit\(formatWhole\(props\.test\.ping\), /,
            "the ping's row no longer prints through the refusing formatter");
        // The speeds' wiring pin lives in panelPrecision, which owns the
        // card-vs-pane rounding contract - a verbatim copy here red three
        // suites for one reformat.

        for (const spelt of [-1, "-1"]) {
            assert.equal(formatWithUnit(formatWhole(spelt), "ms"), "N/A",
                `a ping of ${JSON.stringify(spelt)} prints as a reading of minus one`);
            assert.equal(formatWithUnit(wholeSpeed(spelt, {}), "Mbps"), "N/A",
                `a speed of ${JSON.stringify(spelt)} prints as a reading of minus one`);
        }
        assert.equal(formatWithUnit(formatWhole(12.6), "ms"), "13 ms");
    });

    it("prints the jitter beside it at the same precision", () => {
        assert.match(card, /formatLatencyWithUnit\(props\.test\.jitter, /,
            "the jitter goes out raw, two decimals beside a ping at one");
        assert.doesNotMatch(card, /\{props\.test\.jitter}/,
            "the jitter still reaches the markup unformatted");
    });

    // Both directions of the latency under load, which is a latency like any
    // other - the sentence it is interpolated into carries the unit itself.
    it("prints the latency under load the same way", () => {
        assert.match(card, /down: formatLatency\(props\.test\.downloadLatency\)/);
        assert.match(card, /up: formatLatency\(props\.test\.uploadLatency\)/);
    });

    // A share of lost packets is a percentage, not a latency, and one decimal is
    // not the precision it is reported at.
    it("leaves the packet loss alone", () => {
        assert.doesNotMatch(card, /formatLatency\w*\(props\.test\.packetLoss/);
    });

    // The speeds have their own conversion, and a download trimmed to one
    // decimal would be a different figure in a different unit.
    it("leaves the speeds alone", () => {
        for (const speed of ["download", "upload"])
            assert.doesNotMatch(card, new RegExp(`formatLatency\\(props\\.test\\.${speed}\\)`),
                `the ${speed} lost its own conversion`);
    });
});
