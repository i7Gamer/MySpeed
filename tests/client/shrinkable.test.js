import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { compile, read, rules } from "../helpers/sass.mjs";
import { readSource } from "../helpers/source.js";

/**
 * The flex items that have to be told they may shrink, and the two places a
 * width has to be stated rather than derived.
 *
 * One fault runs through most of this file: a flex item's `min-width` defaults
 * to `auto`, which is its content's minimum - so an item holding a long word, a
 * `nowrap` label or a nested flex row refuses to give way and pushes its
 * container open instead. It is invisible in English and shows up as a cut
 * border, a crushed word or a row hanging off a dialog in the translations,
 * which is why each of these is guarded here rather than left to be found again.
 *
 * Read off the compiled css: nesting in the indented syntax is what decides
 * whether a rule is a child of the one above it, and a test that greps the
 * .sass reads a swatch inside a dialog as the dialog.
 */

const bodyOf = (css, selector) => {
    const matched = rules(css).filter((rule) => rule.selector === selector);

    assert.notEqual(matched.length, 0, `${selector} has no rule at all`);
    return matched.map(({body}) => body).join(";");
};

const declares = (body, property, value = "[^;]+") =>
    new RegExp(`(?:^|[;{])\\s*${property}\\s*:\\s*${value}`).test(body);

describe("the wizard's speed fields", () => {
    const css = compile("common/components/WelcomeDialog/steps/DataHelper/styles.sass");

    /**
     * The same three-fields-in-a-row shape as the optimal-values dialog, and it
     * had the same fault: the fields were sized from their own content, so a
     * long label made the row wider than the banner holding it. Turkish spilled
     * 22px, clipped away by .welcome-banner - the wizard cannot be closed, so
     * the field a reader was being asked to fill in was the part cut off.
     */
    it("shares the row out rather than adding up to it", () => {
        const speed = bodyOf(css, ".data-helper .speeds .speed");

        assert.ok(declares(speed, "flex", "1 1 0"),
            "each field takes an equal share, or the row is as wide as its longest label");
        assert.ok(declares(speed, "min-width", "0"),
            "without this the share is a floor, not a width, and the row still overflows");
    });

    /**
     * Letting the labels wrap is what stopped the row overflowing, and it costs
     * the fields their common baseline unless they are told otherwise: the
     * field whose label took one line put its input 45px above the two whose
     * labels took two.
     */
    it("keeps the three inputs on one line", () => {
        assert.ok(declares(bodyOf(css, ".data-helper .speeds .speed"), "justify-content", "space-between"),
            "the inputs follow their labels down, so a wrapped label drops one of them");
    });

    it("lets a long label wrap instead of widening the row", () => {
        const header = bodyOf(css, ".data-helper .speeds .speed .speed-header");

        assert.ok(!declares(header, "white-space", "nowrap"),
            "a label that cannot wrap sets the width of the field it names");
        assert.ok(declares(header, "min-width", "0"),
            "the header is a flex row itself, so it needs its own permission to shrink");
        // The field centres what it stacks rather than stretching it, and a
        // centred item is as wide as its own content however narrow the column
        // is. Without the ceiling the label simply hung out either side of the
        // input - which is what French and Ukrainian were still doing after
        // everything inside it had been told it could shrink.
        assert.ok(declares(header, "max-width", "100%"),
            "a centred label takes its content's width, not its column's");
    });
});

describe("the storage rows' labels", () => {
    const css = compile("common/components/StorageDialog/styles.sass");

    /**
     * A basis is room reserved before the line is composed, and reserving it on
     * every row cost the one row that had room to spare. The retention row
     * carries two controls where the others carry one, so 12rem of reserved
     * label plus a select plus a button came to more than the panel holds and
     * the row wrapped - in English, where the label wants 129px of the 515 and
     * the controls 321, with 49px still going spare. It wrapped in every
     * language, and only English had any room to lose.
     *
     * So the label asks for its own words. Where they and the controls fit, the
     * row is one line; where they do not - German, Dutch, French, Russian,
     * Portuguese and Catalan on that row, all of them 35px to 108px over - it
     * wraps as before and the label takes the full width for a word that cannot
     * be broken.
     */
    it("asks for its own words rather than a reserved basis", () => {
        assert.ok(declares(bodyOf(css, ".storage-row .storage-row-label"), "flex", "1 1 auto"),
            "every row reserves room again, so the one that fits wraps with room to spare");
    });

    /**
     * Except the row whose label carries a sentence. At `auto` that hint is the
     * label's content, so the label asks for the width of a whole sentence and
     * the row wraps in every language - which is the fault the basis was
     * measured against in the first place.
     */
    it("keeps the basis where a hint would ask for a sentence", () => {
        assert.ok(declares(bodyOf(css, ".storage-row .storage-row-label.storage-row-label-hinted"),
            "flex-basis", "12rem"),
            "the hinted row has nothing holding its label back to a heading's width");
    });

    /**
     * Every row stands in the same band, whether or not it carries a control
     * tall enough to make one.
     *
     * The gap between rows was already even - 16px the whole way down - but the
     * eye reads the distance between one heading and the next, and that is the
     * gap plus the row. "Stored tests" states a figure and nothing else, so it
     * is a 20px row among 36 and 38px ones, and the first step in the list came
     * out 36px where every other is 52.
     *
     * The floor is the tallest control the list carries rather than the button,
     * so the select does not push its own row past it and reintroduce a step of
     * a different size two rows down.
     */
    it("gives every row the same band to stand in", () => {
        const band = /\$storage-row-band:\s*([\d.]+rem)/
            .exec(read("common/components/StorageDialog/styles.sass"))?.[1];

        assert.ok(band, "the band has no name, so each rule would spell the number out");
        assert.ok(declares(bodyOf(css, ".storage-row"), "min-height", band),
            "a row with nothing tall in it collapses to its text and shortens the step above it");
    });

    /**
     * Marked on the row in the JSX rather than found with :has() - the same
     * call the targets dialog records making, so that somebody adding a row
     * sees which kind it is where they are writing it.
     */
    it("is marked on the row that carries the hint", () => {
        const jsx = readSource("client/src/common/components/StorageDialog/tabs/Configuration.jsx");
        const hinted = jsx.slice(0, jsx.indexOf("storage-row-hint"));

        assert.ok(hinted.lastIndexOf("storage-row-label-hinted") > hinted.lastIndexOf("storage-row-label\""),
            "the row carrying the hint is not the row marked as carrying one");
    });
});

describe("the pause dialog's quiet hours", () => {
    const css = compile("common/components/PauseDialog/styles.sass");

    /**
     * Not a reported fault - a guard. Two labelled time inputs share a row at
     * `flex: 1`, and the label above each is a whole phrase in several of the
     * twenty-three locales. English and German fit today; the next translation
     * to arrive is the one that would not, and the section is behind a collapsed
     * toggle where nobody would look for it.
     */
    it("lets the labels shrink with the row", () => {
        assert.ok(declares(bodyOf(css, ".pause-quiet-range label"), "min-width", "0"),
            "a from/until label that will not shrink pushes the pair past the dialog");
    });
});

describe("the panel rows that hold a sentence", () => {
    const lines = /\$panel-description-lines:\s*(\d+)/
        .exec(read("pages/Statistics/components/PanelRow/_variables.sass"))?.[1];

    it("states how many lines a description may take", () => {
        assert.ok(lines, "the clamp's line count has no home, so each card would spell it out");
    });

    /**
     * The shared row ellipsises its descriptions so a card cannot grow taller
     * than its line-mates. English fits inside that; nothing else does. The
     * overview card lost 66px of Russian - "медленнее всего около 20:00,
     * быстрее всего около 05:00" keeps the slowest hour and drops the fastest,
     * which is the comparison the sentence exists to make - and 67 of
     * Portuguese, 57 of German and Ukrainian.
     *
     * Two lines rather than free wrapping: the card's height is grid-matched to
     * the two beside it, so the row may take one more line and no more. The
     * dialog and the enlarged value card already wrap freely, for the same
     * reason stated on their own rules - there is no shared height to protect
     * there.
     */
    for (const [card, sheet, selector] of [
        ["overview", "pages/Statistics/charts/OverviewChart/styles.sass",
            ".overview-items .panel-row .panel-row-description > *"],
        ["stability", "pages/Statistics/charts/ConsistencyChart/styles.sass",
            ".consistency-container:not(.chart-modal-body *) .panel-row-description > *:not(.bufferbloat-trend)"]
    ]) {
        it(`gives the ${card} card's sentences a second line`, () => {
            const body = bodyOf(compile(sheet), selector);

            assert.ok(declares(body, "white-space", "normal"),
                "still nowrap, so the sentence is cut at the card's edge");
            assert.ok(declares(body, "-webkit-line-clamp", lines),
                `the clamp is what bounds the growth to ${lines} lines`);
        });
    }

    /**
     * The clamp keeps one translation from setting the height of a row of cards
     * stretched to match each other, and the dialog has no such row - so the
     * stability card exempts it there, the same way it exempts its own sizing.
     *
     * The summary card does not, and must not: overviewModalStyles.test.js pins
     * that stylesheet to deciding by the card's own geometry with no
     * `.chart-modal-body` guard anywhere in it. A clamp measures nothing and so
     * cannot be exempted by geometry; it applies in the dialog and is inert
     * there, the enlarged card being far too wide to reach a third line.
     */
    it("leaves the enlarged stability card wrapping freely", () => {
        const sheet = "pages/Statistics/charts/ConsistencyChart/styles.sass";
        const clamping = rules(compile(sheet))
            .filter(({body}) => declares(body, "-webkit-line-clamp"))
            .map(({selector}) => selector);

        assert.notEqual(clamping.length, 0, `${sheet} clamps nothing`);
        for (const selector of clamping)
            assert.match(selector, /:not\(\.chart-modal-body \*\)/,
                `${selector} clamps the enlarged card too`);
    });

    /**
     * The dots are the one thing in a description that is not a sentence, and
     * the clamp would lay them out as a block box: the trend is a flex row, and
     * `-webkit-box` on it stacks the readings vertically. Excluded by name in
     * the selector above rather than undone afterwards, so it never applies.
     */
    it("leaves the bufferbloat trend a row of dots", () => {
        const css = compile("pages/Statistics/charts/ConsistencyChart/styles.sass");

        assert.ok(declares(bodyOf(css, ".consistency-container .bufferbloat-trend"), "display", "flex"),
            "the trend has stopped being a row, so its dots stack");
    });
});

describe("the export button when it is a square", () => {
    const css = compile("common/components/PageToolbar/styles.sass");

    const compact = rules(css)
        .filter(({selector}) => selector.includes("data-compact") && selector.includes(".export-button")
            && !selector.includes("-container") && !selector.includes("dropdown"))
        .map(({body}) => body).join(";");

    /**
     * Its wrapper shrink-wraps to the button, and an aspect ratio is not part of
     * what a wrapper measures: the button took its width from its height - 46px
     * - while the wrapper was sized from the icon and padding alone at 44, so
     * the button drew 2px past the box holding it and the toolbar reported 2px
     * it could not fit. The start button carries the same ratio and is fine,
     * because it sits in the row directly with no wrapper to disagree with.
     *
     * So the width is stated, and the wrapper has a number it can read. The
     * ratio stays declared behind it: a browser without `lh` drops the width as
     * invalid and still gets a square, rather than an icon in a rectangle.
     */
    it("states a width its wrapper can measure", () => {
        assert.notEqual(compact, "", "there is no compact rule for the export button");
        assert.ok(declares(compact, "width"),
            "without a stated width the wrapper measures the icon and the button measures its height");
        assert.ok(!declares(compact, "width", "(auto|100%)"),
            "auto and 100% are the two widths that put the wrapper back in charge");
    });

    it("keeps the aspect ratio underneath it", () => {
        // Whichever way it was spelled in the source: sass emits the ratio
        // with the spaces around the slash taken out.
        assert.ok(declares(compact, "aspect-ratio", "1\\s*/\\s*1"),
            "nothing squares the button where the stated width is not understood");
    });
});
