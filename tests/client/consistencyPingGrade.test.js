import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pingDeviationColour } from "@/common/utils/TestUtil.js";
import { formatLatency } from "@/common/utils/FormatUtil.js";

const CLIENT_SRC = path.resolve(fileURLToPath(import.meta.url), "..", "..", "..", "client", "src");

const card = fs.readFileSync(path.join(CLIENT_SRC,
    "pages/Statistics/charts/ConsistencyChart/ConsistencyChart.jsx"), "utf8");

/**
 * The ping row of the stability card, and the colour it wears.
 *
 * Reported as "orange but it says ±0 ms". Both halves were right: the spread
 * really was zero - two thirds of that instance's tests sat exactly on the
 * median - and the colour was a constant. The row read
 * `deviation === null ? "icon-blue" : "icon-orange"`, so every measured value
 * from the best to the worst came out the same warning colour, and the icon
 * beside it was orange unconditionally. Among four rows whose colours are
 * verdicts - the speeds through consistencyColour, the jitter through
 * jitterColour, the bufferbloat through bufferbloatColour - a decorative
 * orange is read as a verdict too.
 *
 * A source scan for the wiring, because node cannot parse JSX and this renders
 * perfectly either way; the grader itself is exercised beside it, so the two
 * cannot drift apart.
 */
describe("the stability card grades the ping deviation it shows", () => {
    it("finds the row to check", () => {
        assert.match(card, /data\.ping\.deviation/, "the card no longer draws a ping deviation at all");
    });

    it("takes the colour from the value rather than from whether there is one", () => {
        assert.match(card, /pingDeviationColour\(formatLatency\(data\.ping\.deviation\)\)/,
            "the ping deviation is still coloured without consulting the value");
        assert.doesNotMatch(card, /deviation === null \? "icon-blue" : "icon-orange"/,
            "the hardcoded blue-or-orange is still there");
    });

    /**
     * The icon carried the same fixed orange, one line below the value it
     * belongs to - so the row said "warning" twice over a reading that had not
     * earned it once.
     *
     * Matched on the icon element rather than on the file. Swept file-wide this
     * read as a stronger check and was a vaguer one: it stood guard over four
     * other rows it says nothing about, so a legitimately orange element added
     * anywhere on this card would fail a test named for the ping deviation, and
     * whoever hit it would have no way to tell a real regression from the
     * assertion simply being too wide.
     */
    it("leaves no fixed orange on the ping icon", () => {
        const icon = card.match(/<FontAwesomeIcon[^>]*faPingPongPaddleBall[^>]*>/);

        assert.notEqual(icon, null, "the ping row no longer draws its icon at all");
        assert.doesNotMatch(icon[0], /icon-orange/,
            "the ping icon is still painted orange regardless of the value beside it");
        assert.match(icon[0], /className=\{pingGrade}/,
            "the icon no longer takes the grade the value it sits beside is given");
    });

    /**
     * Graded from the trimmed figure, as the jitter beside it is.
     *
     * The card prints one decimal and the thresholds are exact, so grading the
     * stored two decimals would put an orange next to a value reading "±2 ms"
     * for one instance and a green next to the same "±2 ms" for another.
     */
    it("grades the same figure it prints", () => {
        assert.doesNotMatch(card, /pingDeviationColour\(data\.ping\.deviation\)/,
            "the grade is taken from the stored value, not the printed one");

        assert.equal(formatLatency(1.96), 2);
        assert.equal(pingDeviationColour(formatLatency(1.96)), "orange",
            "a value that prints as ±2 ms must grade as ±2 ms does");
    });

    // The symptom from the report, pinned: the best reading there is must not
    // come out in the warning colour.
    it("calls a line that never wavered green", () => {
        assert.equal(pingDeviationColour(formatLatency(0)), "green");
    });

    // Fewer than two successful tests in the range is no measurement, and the
    // server now says so with a null rather than with a flawless ±0.
    it("has no colour and no figure when the range held too few tests", () => {
        assert.equal(pingDeviationColour(formatLatency(null)), "blue");
        assert.equal(formatLatency(null), null);
    });
});
