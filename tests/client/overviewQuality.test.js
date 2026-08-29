import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import * as sass from "sass";
import { fileURLToPath, pathToFileURL } from "node:url";
import { formatLatency, NOT_MEASURED, printableFigure } from "@/common/utils/FormatUtil.js";
import { isMeasured, jitterColour, packetLossColour, readableFigure } from "@/common/utils/TestUtil.js";

const CLIENT_SRC = path.resolve(fileURLToPath(import.meta.url), "..", "..", "..", "client", "src");

const read = (file) => fs.readFileSync(path.join(CLIENT_SRC, file), "utf8");

const row = read("pages/Home/components/Speedtest/SpeedtestComponent.jsx");
const area = read("pages/Home/components/TestArea/TestAreaComponent.jsx");

const aliasImporter = {
    findFileUrl(url) {
        if (!url.startsWith("@/")) return null;
        return pathToFileURL(path.join(CLIENT_SRC, url.slice(2)));
    }
};

const css = sass.compile(path.join(CLIENT_SRC, "pages/Home/components/Speedtest/styles.sass"),
    {importers: [aliasImporter]}).css;

const escape = (selector) => selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// The lookahead matters: without it ".quality-suffix" also matches the rule for
// ".quality-suffix-value", and every question about the container is answered
// by whichever of its children happens to declare the property.
const bodiesFor = (selector) => [...css.matchAll(
    new RegExp(`${escape(selector)}(?![-\\w])[^{},]*\\{([^}]*)}`, "g"))].map(([, body]) => body);

const declares = (selector, property) => bodiesFor(selector).some((body) => property.test(body));

/**
 * The overview row showed the jitter beside its ping and stopped there, so the
 * other half of what the line does under no load only existed inside a row that
 * had been opened. The pane pairs them for a reason - a latency that holds
 * steady while a fiftieth of the traffic never arrives is not a good line - and
 * a list is where a reader would notice the pattern across tests.
 */
describe("the overview row carries both quality figures", () => {
    // What each figure is made of, and the markup that draws them - the list is
    // built above the JSX, which renders it through one loop. The slice opens
    // at the trimmed jitter the list reads, so the executed lift below sees
    // the same declarations the component does.
    const figures = row.slice(row.indexOf("const jitterText = formatLatency"), row.indexOf("const fadeOut"));
    // To the *next* heading close, not the first in the file: the date and the
    // failure line above are headings too.
    const suffixAt = row.indexOf('className="quality-suffix"');
    const quality = row.slice(suffixAt, row.indexOf("</h2>", suffixAt));

    it("finds the suffix to check", () => {
        assert.notEqual(row.indexOf('className="quality-suffix"'), -1,
            "the row draws no quality figures at all");
        assert.notEqual(figures, "", "the figures are no longer declared as a list");
    });

    it("is handed the packet loss to draw", () => {
        assert.match(area, /packetLoss=\{test\.packetLoss}/,
            "the row is only passed jitter, so it has nothing to draw");
    });

    it("draws packet loss with the same glyph as everywhere else", () => {
        assert.match(figures, /faLinkSlash/);
        assert.match(figures, /faWaveSquare/, "the jitter figure lost its glyph");
        assert.match(quality, /icon=\{icon}/, "the figures carry a glyph the markup never draws");
    });

    // Zero loss is the best reading there is and the most common one, so a
    // truthiness check would hide exactly the result worth showing - while a
    // provider that never measured one has to stay blank rather than claim a
    // clean line.
    it("tells a measured zero from a figure nobody measured", () => {
        // readableFigure for the loss chip, because its label prints the
        // stored column raw and junk must not print as a reading; isMeasured
        // for the jitter, whose label says N/A for what it cannot read. The
        // same split the detail pane and the latest-test card carry.
        assert.match(figures, /readableFigure\(props\.packetLoss\) !== null/);
        assert.match(figures, /isMeasured\(props\.jitter\)/);
        assert.doesNotMatch(figures, /props\.packetLoss &&/,
            "a packet loss of 0% is falsy, and hiding it hides a clean line");
    });

    /**
     * The jitter is a latency, and a card prints a latency to one decimal - the
     * detail pane, the latest-test card and the stability card all trim through
     * the same formatter. The boundary runs at the overview pane's latency row
     * and the chart tooltips, which still print the stored two decimals, and at
     * the bufferbloat increase, which keeps two deliberately, pinned to the
     * server's arithmetic. This one went out at the two decimals it is stored
     * with, beside a ping trimmed to one - the same measurement in the same
     * unit, printed two ways a centimetre apart.
     *
     * The ping beside it is a whole number now and this one is not, which is not
     * that fault coming back. Rounding the ping is a decision about the column
     * it sits in - a list is read down its columns, and those only line up when
     * the figures are one width - and this figure is in no column: it is a 12pt
     * footnote hung off the ping behind a divider. Rounded to match, most of the
     * jitters a good line produces would print "0", and "0 ms" of jitter is the
     * strongest claim the figure can make - see roundsToZeroLatency, which
     * exists for exactly that reading.
     *
     * The packet loss beside it is a percentage and keeps the shape it has.
     */
    it("prints the jitter at the one decimal every latency is trimmed to", () => {
        assert.match(figures, /const jitterText = formatLatency\(props\.jitter\);/,
            "the jitter goes out raw, at the two decimals the column stores");
        assert.match(figures, /text:\s*printableFigure\(jitterText\) \? jitterText : NOT_MEASURED/,
            "the chip's refusal no longer reads through the unitless half of formatWithUnit's judgement");
        assert.doesNotMatch(figures, /formatLatency\(props\.packetLoss\)/,
            "packet loss is a percentage, not a latency");
    });

    // The row's list, executed off its own declarations rather than spelled -
    // the entries are plain JavaScript above the JSX. Both chips' columns are
    // parameters, so both gates run against real spellings.
    const built = (jitter, packetLoss = null) => new Function(
        "props", "t", "isMeasured", "jitterColour", "formatLatency", "printableFigure", "readableFigure",
        "NOT_MEASURED", "packetLossColour", "faWaveSquare", "jitterInfo", "faLinkSlash", "packetLossInfo",
        `${figures}\nreturn quality;`)(
        {jitter, packetLoss}, (key) => key, isMeasured, jitterColour, formatLatency,
        printableFigure, readableFigure, NOT_MEASURED, packetLossColour, null, null, null, null);

    /**
     * What the row prints for a figure nothing can read is the word, not the
     * placeholder. The chip stays visible for everything isMeasured admits,
     * and the pane this row opens says N/A for the same jitter through
     * formatLatencyWithUnit: a "-1" here beside that pane's "N/A" was the row
     * and its pane answering one question two ways. This chip prints no unit,
     * so it spells the same refusal from the same readers.
     */
    it("says N/A rather than printing a jitter nobody measured", () => {
        const jitterChip = (jitter) => built(jitter).find((figure) => figure.key === "jitter");

        for (const unreadable of [-1, "-1", "auto"])
            assert.equal(jitterChip(unreadable).text, NOT_MEASURED,
                `a jitter of ${JSON.stringify(unreadable)} printed as a reading`);

        assert.equal(jitterChip(19.96).text, 20, "a real jitter no longer prints its trimmed figure");

        for (const absent of [null, undefined])
            assert.equal(jitterChip(absent), undefined, `a jitter of ${String(absent)} still draws a chip`);
    });

    /**
     * And each chip dressed in ITS OWN grader's colour, executed with a
     * pair the two graders disagree on. The source pins at the bottom hold
     * each level's spelling; this is the second net, the one that survives
     * a respelling - a swap of the two grader calls leaves both pins
     * matching somewhere in the region while both chips wear the other
     * figure's colour.
     */
    it("dresses each chip in its own grader's colour", () => {
        const chips = built(10, 0.5);
        const jitterChip = chips.find((figure) => figure.key === "jitter");
        const lossChip = chips.find((figure) => figure.key === "packetLoss");

        assert.equal(jitterChip.level, jitterColour(formatLatency(10)));
        assert.equal(lossChip.level, packetLossColour(0.5));
        assert.notEqual(jitterChip.level, lossChip.level,
            "a fixture both graders agree on proves nothing here");
    });

    /**
     * And the loss chip's gate, executed the same way - this is the gate the
     * scan suite's exemption vouches for when it lets the chip print its
     * stored column raw. A chip that appears is one the reader admitted; what
     * it then prints is the column as stored, "0.5" and "0" alike, which is
     * the row-and-pane-identical policy the chip's comment states.
     */
    it("draws the loss chip only for what the reader admits", () => {
        const lossChip = (packetLoss) => built(null, packetLoss).find((figure) => figure.key === "packetLoss");

        assert.equal(lossChip("0.5").text, "0.5%", "a text loss an older node sends is readable, and the chip hid it");
        assert.equal(lossChip(0).text, "0%", "a measured clean line is the best reading there is, and it vanished");

        for (const unreadable of [-1, "-1", "auto"])
            assert.equal(lossChip(unreadable), undefined,
                `a loss of ${JSON.stringify(unreadable)} drew a chip, which prints the raw column as a reading`);

        for (const absent of [null, undefined])
            assert.equal(lossChip(absent), undefined, `a loss of ${String(absent)} drew a chip nobody measured`);
    });

    /**
     * Different formatters, but neither figure reaches the reader raw. The ping
     * is rounded whole for its column and the jitter trimmed to one decimal for
     * its footnote; what must not come back is either of them printed at the two
     * decimals the columns store.
     */
    it("lets no raw latency reach the row", () => {
        assert.doesNotMatch(row, /\{props\.(ping|jitter)}/,
            "a latency is printed at the two decimals the column stores");
        assert.match(row, /const pingValue = formatWhole\(props\.ping\)/,
            "the ping is no longer put through a formatter at all");
    });

    it("explains both figures the way the detail pane does", () => {
        assert.match(figures, /info:\s*jitterInfo/);
        assert.match(figures, /info:\s*packetLossInfo/);
        assert.match(quality, /<HelpButton/, "the icons are decoration again");
    });

    // The row is the control that expands the panel, so the icons sit inside
    // something clickable - the shared hook is what stops the click.
    it("opens them through the shared hook", () => {
        assert.match(row, /useMetricInfo/);
    });

    it("keeps them beside the ping rather than under it", () => {
        assert.ok(declares(".quality-suffix", /display:\s*flex/));
        assert.ok(declares(".quality-suffix", /border-left/),
            "the divider that separates the pair from the ping is gone");
    });

    it("keeps each figure's icon with its own number", () => {
        assert.ok(declares(".quality-suffix-part", /display:\s*flex/));
        assert.ok(declares(".quality-suffix-part", /gap/));
    });

    // They are footnotes to the latency, not a fourth and fifth column: the
    // three main figures are what the eye lands on when scrolling a list.
    it("stays quieter than the numbers it hangs off", () => {
        assert.ok(declares(".quality-suffix-value", /opacity/));
        assert.ok(declares(".quality-suffix", /font-size/));
    });

    /**
     * Graded the way every other icon in the row is: the colour is on the
     * glyph, the number stays plain. A row is read by icon colour first - that
     * is what makes a bad test findable while scrolling a hundred of them - and
     * a jitter of 40 ms sat in exactly the same grey as one of 2.
     */
    it("grades both figures with the same functions the pane uses", () => {
        // The grade reads the same hoisted 1-dp figure the text prints -
        // detailLatencyPrecision's belt resolves the name back to
        // formatLatency(props.jitter) and holds it against the pane's.
        assert.match(figures, /level:\s*jitterColour\(jitterText\)/);
        assert.match(figures, /level:\s*packetLossColour\(props\.packetLoss\)/);
    });

    it("colours the icon and nothing else", () => {
        assert.match(quality, /quality-suffix-icon icon-/,
            "the grade never reaches the glyph");
        assert.doesNotMatch(quality, /quality-suffix-part[^"]*icon-/,
            "the whole figure is coloured, so the number is graded too");
        assert.doesNotMatch(quality, /quality-suffix-value[^"]*icon-/,
            "the number carries the grade, and the row colours icons rather than values");
    });

    // opacity is a group operation: dimming the row of figures dims the graded
    // glyph inside it, and no child can opt back out of its parent's alpha.
    it("does not wash the grade out with the group's dimming", () => {
        assert.ok(!declares(".quality-suffix", /opacity/),
            "the container dims everything below it, the coloured icons included");
    });

    it("still shrinks with the row on a narrow screen", () => {
        const queries = [...css.matchAll(/@media[^{]*\{([\s\S]*?)\n}/g)].map(([, body]) => body);

        assert.ok(queries.some((body) => body.includes(".quality-suffix")),
            "the suffix keeps its desktop size on a phone, where the ping beside it doubles");
    });

    // The old name described half its contents.
    it("leaves no rule named after jitter alone", () => {
        assert.doesNotMatch(css, /\.jitter-suffix/);
        assert.doesNotMatch(row, /jitter-suffix/);
    });
});
