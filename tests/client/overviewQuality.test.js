import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import * as sass from "sass";
import { fileURLToPath, pathToFileURL } from "node:url";

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
    // built above the JSX, which renders it through one loop.
    const figures = row.slice(row.indexOf("const quality = ["), row.indexOf("const fadeOut"));
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
        assert.match(figures, /isMeasured\(props\.packetLoss\)/);
        assert.match(figures, /isMeasured\(props\.jitter\)/);
        assert.doesNotMatch(figures, /props\.packetLoss &&/,
            "a packet loss of 0% is falsy, and hiding it hides a clean line");
    });

    /**
     * The jitter is a latency, and a card prints a latency to one decimal -
     * the test rows, the detail pane, the latest-test card and the stability
     * card all trim through the same formatter. The boundary runs at the
     * overview pane's latency row and the chart tooltips, which still print
     * the stored two decimals, and at the bufferbloat increase, which keeps
     * two deliberately, pinned to the server's arithmetic. This one went out
     * at the two decimals it is stored with, on
     * the same line as a ping trimmed to one - the same measurement in the
     * same unit, printed two ways a centimetre apart. The packet loss beside
     * it is a percentage and keeps the shape it has.
     */
    it("prints the jitter to the precision the ping beside it uses", () => {
        assert.match(figures, /text:\s*formatLatency\(props\.jitter\)/,
            "the jitter goes out raw, at two decimals next to a ping at one");
        assert.match(row, /formatLatency\(props\.ping\)/, "the ping it is printed beside is no longer formatted");
        assert.doesNotMatch(figures, /formatLatency\(props\.packetLoss\)/,
            "packet loss is a percentage, not a latency");
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
        assert.match(figures, /level:\s*jitterColour\(formatLatency\(props\.jitter\)\)/);
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
