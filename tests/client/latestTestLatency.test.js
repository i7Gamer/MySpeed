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
     * One helper for the three rows that can carry one, lifted out and run: it
     * was written out at each of them, which is three chances for the next row
     * to be added without it. A failed run stores -1 in every numeric column, so
     * every one of the three would print "-1 Mbps" as though it were a reading.
     */
    it("still names a failed test rather than printing its placeholder", () => {
        const source = card.match(/const measured = [^;]*;/);
        assert.notEqual(source, null, "the card no longer guards the failure placeholder at all");

        const measured = new Function("NOT_MEASURED", `${source[0]}\nreturn measured;`)("N/A");

        assert.equal(measured(-1, "-1 ms"), "N/A");
        assert.equal(measured(12.6, "12.6 ms"), "12.6 ms");
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
