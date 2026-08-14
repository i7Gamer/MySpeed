import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { formatLatency } from "@/common/utils/FormatUtil.js";
import { getIconBySpeed } from "@/common/utils/TestUtil.js";

const CLIENT_SRC = path.resolve(fileURLToPath(import.meta.url), "..", "..", "..", "client", "src");

const read = (file) => fs.readFileSync(path.join(CLIENT_SRC, file), "utf8");

const row = read("pages/Home/components/TestArea/TestAreaComponent.jsx");
const card = read("pages/Statistics/charts/LatestTestChart/LatestTestChart.jsx");
const node = read("pages/Nodes/components/NodeContainer/NodeContainer.jsx");

/**
 * The colour a ping wears, and the figure it is graded from.
 *
 * Every latency is printed at one decimal, and the detail pane grades its
 * colour from that printed figure - tests/client/detailLatencyPrecision.test.js
 * pins it there. The views that lead into the pane still graded the raw
 * two-decimal column, and getIconBySpeed floors a percentage, so a ping that
 * rounds across a bucket boundary wore one colour on a row and another on the
 * very pane that opens from clicking it: green in the list, orange once open,
 * for the same test.
 *
 * The rule is the pane's, applied to the rest: the colour is read off the
 * figure the reader sees.
 */
describe("rounding to the printed decimal can move a ping across a colour boundary", () => {
    // The pair from the report: floor(32.46 / 25 * 100) is 129 and green,
    // floor(32.5 / 25 * 100) is 130 and orange. If these two ever stop
    // disagreeing, the source pins below are pinning nothing.
    it("flips green to orange at the fair boundary", () => {
        assert.equal(getIconBySpeed(32.46, 25, false), "green");
        assert.equal(getIconBySpeed(formatLatency(32.46), 25, false), "orange");
    });

    it("flips orange to red at the bad boundary", () => {
        assert.equal(getIconBySpeed(17.96, 10, false), "orange");
        assert.equal(getIconBySpeed(formatLatency(17.96), 10, false), "red");
    });

    /**
     * The views hand the target over as config.ping - the string typed into
     * the settings dialog - while the pane trims its copy through
     * formatLatency first. formatLatency hands a string back untouched, so the
     * two sides grade against the same target and the colours cannot part
     * ways over it.
     */
    it("grades the same against the target as typed and as the pane trims it", () => {
        for (const [ping, target, colour] of [[32.46, "25", "orange"], [17.96, "10", "red"]]) {
            assert.equal(getIconBySpeed(formatLatency(ping), target, false), colour);
            assert.equal(getIconBySpeed(formatLatency(ping), formatLatency(target), false), colour);
        }
    });

    // formatLatency hands anything that is not a positive number back
    // untouched, so wrapping the ping leaves the guards their placeholders:
    // the -1 a failed test stores still reads as a failure, and an absent
    // value still earns the not-measured blue.
    it("leaves the failure and not-measured placeholders to the guards", () => {
        assert.equal(getIconBySpeed(formatLatency(-1), 25, false), "error");
        for (const absent of [null, undefined])
            assert.equal(getIconBySpeed(formatLatency(absent), 25, false), "blue",
                `an absent ping (${String(absent)}) lost its blue`);
    });
});

/**
 * A source scan, as with the other rendering rules: node cannot parse JSX, and
 * every one of these views renders perfectly on its own - the bug only exists
 * between two of them.
 */
describe("every view grades the ping from the figure it prints", () => {
    // The overview row - the row that expands into the pane the rule comes
    // from.
    it("the overview row", () => {
        assert.match(row, /import \{[^}]*formatLatency[^}]*} from "@\/common\/utils\/FormatUtil"/,
            "the row cannot trim anything - it never imports the formatter");
        assert.match(row, /pingLevel=\{getIconBySpeed\(formatLatency\(test\.ping\), config\.ping, false\)}/,
            "the row's colour is still graded from the raw two-decimal column");
        assert.doesNotMatch(row, /getIconBySpeed\(test\.ping/,
            "a raw ping still reaches the grader somewhere in the row");
    });

    /**
     * The statistics card used to grade the same ping twice - once for the
     * value, once for the icon beside it - and both had to trim, or the number
     * and its own icon could disagree.
     *
     * There is one grading now, and the shared row dresses the glyph and the
     * figure from it, so the two cannot disagree by construction. What is left
     * to check here is that the one grading trims: panelRow.test.js holds the
     * row to putting it on both.
     */
    it("the latest-test card, which grades the ping it prints", () => {
        assert.match(card, /const ping = formatLatency\(props\.test\.ping\)/,
            "the ping is not trimmed where the card's figures are built");
        assert.match(card, /level=\{getIconBySpeed\(ping, config\.ping, false\)}/,
            "the row's colour is not graded from that trimmed figure");
        assert.doesNotMatch(card, /getIconBySpeed\(props\.test\.ping/,
            "a raw ping still reaches the grader somewhere on the card");
    });

    // The node card trims once, where the data is stored: the printed figure
    // and the colour are both read off that one value, the way the pane reads
    // everything off the one ping it prints.
    it("the node card, which prints the same figure it grades", () => {
        assert.match(node, /import \{[^}]*formatLatency[^}]*} from "@\/common\/utils\/FormatUtil"/,
            "the card cannot trim anything - it never imports the formatter");
        assert.match(node, /const ping = formatLatency\(tests\[0\]\?\.ping\)/,
            "the ping is not trimmed where the card's data is built");
        assert.match(node, /pingIcon: getIconBySpeed\(ping, config\.ping, false\)/,
            "the colour is not graded from that trimmed figure");
        assert.doesNotMatch(node, /ping: tests\[0\]\?\.ping/,
            "the card still stores - and so prints - the raw two-decimal column");
        assert.doesNotMatch(node, /getIconBySpeed\(tests\[0\]\?\.ping/,
            "a raw ping still reaches the grader somewhere on the card");
    });

    // The speeds have their own conversion and their own precision - a
    // download trimmed to one decimal would be a different figure - and
    // downloadLatency/uploadLatency are latencies, not speeds, so the pattern
    // is anchored on the closing parenthesis.
    it("leaves the speed grades alone", () => {
        for (const [name, source] of [["row", row], ["card", card], ["node card", node]])
            for (const speed of ["download", "upload"])
                assert.doesNotMatch(source,
                    new RegExp(`getIconBySpeed\\(formatLatency\\([\\w?.\\[\\]]*\\.${speed}\\)`),
                    `the ${name} trims its ${speed} as if it were a latency`);
    });
});
