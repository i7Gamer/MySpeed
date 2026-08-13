import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import * as sass from "sass";
import { fileURLToPath, pathToFileURL } from "node:url";

const CLIENT_SRC = path.resolve(fileURLToPath(import.meta.url), "..", "..", "..", "client", "src");

const read = (file) => fs.readFileSync(path.join(CLIENT_SRC, file), "utf8");

const pane = read("common/components/TestDetails/TestDetails.jsx");
const row = read("pages/Home/components/Speedtest/SpeedtestComponent.jsx");
const english = JSON.parse(fs.readFileSync(
    path.join(CLIENT_SRC, "..", "public", "assets", "locales", "en.json"), "utf8"));

const aliasImporter = {
    findFileUrl(url) {
        if (!url.startsWith("@/")) return null;
        return pathToFileURL(path.join(CLIENT_SRC, url.slice(2)));
    }
};

const compile = (file) =>
    sass.compile(path.join(CLIENT_SRC, file), {importers: [aliasImporter]}).css;

const details = compile("common/components/TestDetails/styles.sass");
const globals = compile("common/styles/default.sass");

const escape = (selector) => selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Every rule whose selector mentions this one: a property can legitimately be
// declared in any of them, and reading only the first starts reading the wrong
// rule the moment another is added beside it.
const bodiesFor = (css, selector) => [...css.matchAll(
    new RegExp(`${escape(selector)}[^{},]*\\{([^}]*)}`, "g"))].map(([, body]) => body);

const declares = (css, selector, property) =>
    bodiesFor(css, selector).some((body) => property.test(body));

/**
 * Four numbers about the same thing on four lines of their own.
 *
 * A metric card stacked the value, the secondary figures, the target label and
 * the change vertically, so the ping card ran four lines deep while its widest
 * line used half the track. The two pairs read as pairs: the latency and what
 * it does beside it, and how far off the target this is against how far it
 * moved since the last test.
 */
describe("the metric card reads in pairs", () => {
    const metric = pane.slice(pane.indexOf("const DetailMetric"), pane.indexOf("const ResultLink"));

    it("finds the card to check", () => {
        assert.ok(metric.includes("detail-metric-value"), "the metric card no longer renders a value");
    });

    it("puts the secondary figures on the value's own line", () => {
        assert.match(metric, /className="detail-metric-value-row"/);

        const valueRow = metric.slice(metric.indexOf('className="detail-metric-value-row"'));
        const closed = valueRow.slice(0, valueRow.indexOf("</div>\n\n"));

        assert.ok(closed.includes("detail-metric-value"), "the value is not in the row");
        assert.ok(closed.includes("{sub}"), "the secondary figures are still outside the value's row");
    });

    // The old comment was right about the narrow case: the cards sit on an
    // auto-fit grid whose tracks go down to 13rem, and two figures on one line
    // do not fit there. Wrapping is what buys the wide case without losing it.
    it("lets that line break again where the track is too narrow", () => {
        assert.ok(declares(details, ".detail-metric-value-row", /display:\s*flex/));
        assert.ok(declares(details, ".detail-metric-value-row", /flex-wrap:\s*wrap/),
            "a narrow card pushes the unit onto a line of its own instead of stacking");
    });

    it("keeps the value and its unit together", () => {
        assert.ok(declares(details, ".detail-metric-value", /white-space:\s*nowrap/),
            "the unit can still break away from the number it belongs to");
    });

    it("puts the change and the target label on one line", () => {
        assert.match(metric, /className="detail-metric-foot"/);

        const foot = metric.slice(metric.indexOf('className="detail-metric-foot"'));

        assert.ok(foot.indexOf("detail-change") < foot.indexOf("detail-target-label"),
            "the change has to lead, or it is the target that leans left");
    });

    // Right by its own margin rather than by space-between: the change is
    // absent on the first test ever recorded, and space-between then leaves the
    // one remaining child on the left.
    it("keeps the target label right even with nothing beside it", () => {
        assert.ok(declares(details, ".detail-metric-foot", /display:\s*flex/));
        assert.ok(declares(details, ".detail-target-label", /margin-left:\s*auto/));
    });

    it("no longer breaks the target label onto a line of its own", () => {
        assert.ok(!declares(details, ".detail-target-label", /display:\s*block/),
            "a block label fills the line and pushes the change off it");
    });

    // The bar stays where it was: it is the target's own picture, and reading
    // it against a label on the same line as an unrelated delta is worse than
    // reading it against the line below.
    it("leaves the bar above them", () => {
        assert.ok(metric.indexOf("detail-target-track") < metric.indexOf("detail-metric-foot"));
    });
});

/**
 * The icons explain themselves on the row and explained nothing once the row
 * was opened.
 *
 * Every measurement on the collapsed row hangs its definition off its icon -
 * that is what the help cursor promises. The detail pane drew the same glyphs
 * as decoration, so opening a row for more information took the explanations
 * away, and the two figures that only exist in the pane - packet loss above
 * all - had never had one anywhere.
 */
describe("the detail pane explains its measurements too", () => {
    it("uses the shared help button rather than a second copy of it", () => {
        assert.match(pane, /import\s+HelpButton\s+from\s+"@\/common\/components\/HelpButton"/);
        assert.match(row, /import\s+HelpButton\s+from\s+"@\/common\/components\/HelpButton"/);
        assert.doesNotMatch(row, /const HelpButton = /,
            "the row still defines its own, so the two can drift apart");
    });

    it("opens the explanations through the shared hook", () => {
        assert.match(pane, /useMetricInfo/);
        assert.match(row, /useMetricInfo/);
    });

    for (const [metric, info] of [["ping", "pingInfo"], ["download", "downloadInfo"],
        ["upload", "uploadInfo"], ["jitter", "jitterInfo"], ["packetLoss", "packetLossInfo"]]) {
        it(`hangs an explanation off the ${metric} icon`, () => {
            assert.match(pane, new RegExp(`info:\\s*${info}`),
                `the ${metric} icon in the pane is decoration`);
        });
    }

    it("draws every metric icon as the help button", () => {
        const metric = pane.slice(pane.indexOf("const DetailMetric"), pane.indexOf("const ResultLink"));

        assert.match(metric, /<HelpButton/);
    });

    // A button inside role="img" is not reachable by a screen reader at all:
    // the role replaces everything below it with its own label. The row learnt
    // this already - only the icon is the button, and the value beside it stays
    // ordinary text.
    it("does not bury the buttons inside an image", () => {
        // "const quality =", not "const quality": the figures it is built from
        // are declared as `qualityFigures` right above it.
        const quality = pane.slice(pane.indexOf("const quality ="), pane.indexOf("const metrics"));

        assert.doesNotMatch(quality, /role="img"/,
            "the quality figures are announced as one image, so the buttons in them are announced not at all");
    });

    it("gives packet loss something to explain", () => {
        assert.equal(typeof english.info.packet_loss?.title, "string");
        assert.equal(typeof english.info.packet_loss?.description, "string");
    });

    // The help cursor is the affordance that says the icon does something, and
    // it lives on the shared class rather than on the page that first used it.
    it("keeps the help cursor on the shared button", () => {
        assert.ok(declares(globals, ".help-button", /cursor:\s*help/));
        assert.ok(declares(globals, ".help-button", /outline/),
            "a control you can tab to but cannot see is no better than one you cannot reach");
    });
});
