import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { formatLatency, formatLatencyWithUnit } from "@/common/utils/FormatUtil.js";

const CLIENT_SRC = path.resolve(fileURLToPath(import.meta.url), "..", "..", "..", "client", "src");

const card = fs.readFileSync(path.join(CLIENT_SRC,
    "pages/Statistics/charts/ConsistencyChart/ConsistencyChart.jsx"), "utf8");

/**
 * The stability card, and the precision it prints its latencies at.
 *
 * The server averages the jitter over the range and sends it at the two
 * decimals the column stores, and the card printed it raw: "5.23 ms" on the
 * stability card, one panel away from a latest-test card reading "5.2 ms" for
 * the same measurement in the same unit. The expanded min-max spreads and the
 * ping deviation printed stored values the same way.
 *
 * A source scan, like the other rendering rules: node cannot parse JSX, and
 * every one of these renders perfectly - it renders a figure at a precision
 * the card beside it contradicts. The formatter itself is exercised on the
 * fixture from the report, so the scan and the behaviour cannot drift apart.
 */
describe("the stability card prints its latencies to one decimal", () => {
    it("finds the card to check", () => {
        assert.match(card, /data\.ping\.jitter/, "the card no longer draws a jitter at all");
        assert.match(card, /import \{[^}]*formatLatencyWithUnit[^}]*} from "@\/common\/utils\/FormatUtil"/,
            "the card cannot trim anything - it never imports the latency formatter");
    });

    it("prints the jitter average the way the latest-test card prints its jitter", () => {
        assert.match(card, /formatLatencyWithUnit\(data\.ping\.jitter, t\("latest\.jitter_unit"\)\)/,
            "the jitter average still goes out at the two decimals the server sends");
        assert.doesNotMatch(card, /formatWithUnit\(data\.ping\.jitter/,
            "the jitter average reaches the markup through the unit formatter alone");
    });

    // The fixture from the report: a stored average of 5.23 must read 5.2 on
    // screen - and a range in which nothing measured jitter is an explicit
    // null, which has to keep rendering as N/A rather than a bare unit.
    it("renders the stored two decimals as one", () => {
        assert.equal(formatLatencyWithUnit(5.23, "ms"), "5.2 ms");
        assert.equal(formatLatencyWithUnit(null, "ms"), "N/A");
    });

    // The enlarged view's "between 4.16 and 9.87" is made of raw stored
    // values, and both ends are latencies like the averages above them.
    it("trims both ends of the expanded spreads", () => {
        assert.match(card, /const latency = \(value\) => formatLatencyWithUnit\(value, t\("latest\.ping_unit"\)\)/,
            "the spread's ends still go out at the two decimals they are stored with");
        assert.equal(formatLatencyWithUnit(4.16, "ms"), "4.2 ms");
        assert.equal(formatLatencyWithUnit(9.87, "ms"), "9.9 ms");
    });

    // The ping deviation is milliseconds like the jitter beneath it. The null
    // a range without successes returns passes through the formatter
    // untouched, so the deviation helper still says N/A for it.
    it("trims the ping deviation it prints in the same unit", () => {
        assert.match(card, /deviation\(formatLatency\(data\.ping\.deviation\), t\("latest\.ping_unit"\)\)/,
            "the ping deviation still prints the stored two decimals");
        assert.equal(formatLatency(2.94), 2.9);
        assert.equal(formatLatency(null), null);
    });

    // The speeds have their own conversion and their own precision: a
    // deviation of ±34.16 Mbps trimmed to one decimal of milliseconds'
    // convention would be a different figure, and the consistency scores are
    // percentages.
    it("leaves the speeds and percentages alone", () => {
        assert.doesNotMatch(card, /formatLatency\w*\(data\.(download|upload)/,
            "a speed figure went through the latency formatter");
        assert.match(card, /const speed = \(value\) => formatWithUnit\(convertSpeed\(value, preferences\), speedUnit\)/,
            "the speed spread lost its own formatter");
    });

    // The bufferbloat increase keeps its two decimals by design: the figure is
    // pinned to the server's arithmetic by the loaded-latency agreement tests,
    // and the tooltips quote it verbatim.
    it("leaves the bufferbloat increase at the server's two decimals", () => {
        assert.doesNotMatch(card, /formatLatency\w*\(loaded\.increase/,
            "the average increase was trimmed away from the pinned figure");
        assert.doesNotMatch(card, /formatLatency\w*\(entry\.increase/,
            "a trend dot's increase was trimmed away from the pinned figure");
    });
});
