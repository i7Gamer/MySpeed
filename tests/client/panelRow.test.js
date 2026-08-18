import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import * as sass from "sass";
import { fileURLToPath, pathToFileURL } from "node:url";
import { containerBlocks } from "../helpers/sass.mjs";

const CLIENT_SRC = path.resolve(fileURLToPath(import.meta.url), "..", "..", "..", "client", "src");

const read = (file) => fs.readFileSync(path.join(CLIENT_SRC, file), "utf8");

const aliasImporter = {
    findFileUrl(url) {
        if (!url.startsWith("@/")) return null;
        return pathToFileURL(path.join(CLIENT_SRC, url.slice(2)));
    }
};

const compile = (file) => sass.compile(path.join(CLIENT_SRC, file), {importers: [aliasImporter]}).css;

const ROW_DIR = "pages/Statistics/components/PanelRow";
const row = read(`${ROW_DIR}/PanelRow.jsx`);
// The sizes live apart from the rules that use them, so a card can reach for
// one without compiling the whole layout into its own sheet - see the partial.
const rowSizes = read(`${ROW_DIR}/_variables.sass`);
const css = compile(`${ROW_DIR}/styles.sass`);

// The four panels that state readings as rows. The charts are excluded: a plot
// has no row to share.
/*
 * The name each panel's own row used to carry, without a leading dot.
 *
 * It was written as a CSS selector - ".consistency-item" - and checked against
 * both the stylesheet and the JSX with String.includes. JSX writes a class name
 * bare, `className="consistency-item"`, so the dotted spelling never appeared in
 * any of the four components: not after the refactor, and not before it either.
 * Half of this guard could not fail, and the OverviewChart entry carried a
 * trailing colon as well, which no stylesheet rule would have matched.
 *
 * The dot belongs to the selector and not to the name, so it is added where the
 * stylesheet is searched. The lookahead is what the colon was reaching for:
 * "overview-item" must not match the ".overview-items" container that is still
 * there and still doing its job.
 */
const PANELS = [
    {name: "OverviewChart", file: "pages/Statistics/charts/OverviewChart/OverviewChart.jsx",
        styles: "pages/Statistics/charts/OverviewChart/styles.sass", retired: "overview-item"},
    {name: "LatestTestChart", file: "pages/Statistics/charts/LatestTestChart/LatestTestChart.jsx",
        styles: "pages/Statistics/charts/LatestTestChart/styles.sass", retired: "test-container"},
    {name: "ConsistencyChart", file: "pages/Statistics/charts/ConsistencyChart/ConsistencyChart.jsx",
        styles: "pages/Statistics/charts/ConsistencyChart/styles.sass", retired: "consistency-item"},
    {name: "AverageChart", file: "pages/Statistics/charts/AverageChart/AverageChart.jsx",
        styles: "pages/Statistics/charts/AverageChart/styles.sass", retired: "value-item"}
];

// The name as the markup writes it, and as a stylesheet selects it. `(?![-\w])`
// keeps "overview-item" off "overview-items" in both.
const asClassName = (name) => new RegExp(`["'\\s]${name}(?![-\\w])`);
const asSelector = (name) => new RegExp(`\\.${name}(?![-\\w])`);

// Every stylesheet the client has, which is the question the guard above puts
// to four of them.
const STYLESHEETS = fs.readdirSync(CLIENT_SRC, {recursive: true})
    .filter((file) => file.endsWith(".sass"))
    .map((file) => file.split(path.sep).join("/"));

const bodyOf = (selector) => {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const match = css.match(new RegExp(`${escaped}(?![-\\w])\\s*\\{([^}]*)}`));

    assert.notEqual(match, null, `${selector} is not a rule in the shared stylesheet`);
    return match[1];
};

const sizeOf = (selector) => {
    const size = bodyOf(selector).match(/font-size:\s*([\d.]+)rem/);
    assert.notEqual(size, null, `${selector} states no size in rem`);

    return parseFloat(size[1]);
};

/**
 * The four statistics panels drew this row four times over.
 *
 * Two of them were mirror images: the overview card put the icon first and the
 * value last, and the other three put the text first and the icon last. The
 * value was 1.1rem on three and an unstated h2 default - 1.5rem - on the fourth,
 * so the same kind of figure came out a third larger on one card than on the
 * card beside it. Four copies of one layout is the split that keeps widening:
 * every figure added to any of them since has had to pick a side.
 */
describe("the shared panel row", () => {
    it("states the reading larger than what the reading is called", () => {
        const value = sizeOf(".panel-row-value");

        assert.ok(value > sizeOf(".panel-row-title"),
            `the value is ${value}rem, no larger than its own label`);
        assert.ok(sizeOf(".panel-row-title") > sizeOf(".panel-row-description"),
            "the description is as loud as the title it hangs under");
    });

    // The whole reason the row moved: the value is what the eye lands on.
    it("states it larger than the 1.1rem the panels used to", () => {
        assert.ok(sizeOf(".panel-row-value") > 1.1);
    });

    it("names the size once rather than repeating a literal", () => {
        assert.match(rowSizes, /\$panel-value-size:\s*[\d.]+rem/,
            "the value size is a literal, so the next change to it has several places to remember");
        assert.match(rowSizes, /\$panel-value-size-narrow:\s*[\d.]+rem/,
            "the step down the squeezed cards take is a literal of its own");
    });

    /**
     * The glyph wears the grade; the figure does not.
     *
     * That is how a verdict is stated in every other view - the overview rows,
     * the node cards, the detail pane - and a value that was itself coloured was
     * the one thing these four panels did differently.
     */
    it("dresses the glyph in the grade and leaves the figure alone", () => {
        assert.match(row, /"panel-row-icon" \+ \(level \? " icon-" \+ level : ""\)/,
            "the glyph does not wear the grade");
        assert.match(row, /className="panel-row-value"/,
            "the figure carries a grade class of its own again");
    });

    /**
     * And the row publishes it, so a part that does not show the grade today can
     * be opted in without the component being touched - which is the whole
     * point of putting it on the row rather than handing it to each part.
     */
    it("publishes the grade on the row for anything else to read", () => {
        assert.match(row, /data-grade=\{level \|\| undefined}/,
            "the row states its grade nowhere a stylesheet can reach it");
    });

    // An absent attribute rather than an empty one: [data-grade] with no value
    // still matches the selector that publishes --grade, which would leave an
    // ungraded row resolving the property to nothing at all.
    it("states no grade at all on a row that earned none", () => {
        const attribute = new Function("level", "return level || undefined;");

        assert.equal(attribute(undefined), undefined);
        assert.equal(attribute(null), undefined);
        assert.equal(attribute("orange"), "orange");
    });

    /**
     * The figure's own colour is not a verdict either.
     *
     * It was the accent green, which is the colour a good reading earns - so a
     * stability of 45%, which its own icon calls red, would have read as good
     * news the moment the grade came off the figure.
     */
    it("states the figure in a colour that is not a grade", () => {
        const value = bodyOf(".panel-row-value");

        assert.match(value, /color:\s*var\(--white\)/,
            "the figure is stated in a colour that says something about the reading");
    });

    // A description is what qualifies a reading, and plenty of rows have none.
    // Rendering the wrapper regardless leaves an empty second line under the
    // title, which reads as a measurement that went missing.
    it("draws no description when there is none", () => {
        assert.match(row, /\{description && /,
            "the description wrapper is drawn whether or not there is one");
    });

    /**
     * Whatever has to give, the label gives.
     *
     * A figure broken across two lines stops being one figure, so the value
     * neither wraps nor shrinks - which means a row too narrow for both has to
     * take the room out of the label. Without a truncation there the label
     * simply overflowed its box and was drawn underneath the number: the
     * download card is 293px wide inside its padding, and "957.97 Mbps" at the
     * shared size wants 180 of them.
     */
    it("truncates the label rather than letting it run under the value", () => {
        const title = bodyOf(".panel-row-title");

        assert.match(title, /overflow:\s*hidden/);
        assert.match(title, /text-overflow:\s*ellipsis/);
        assert.match(title, /white-space:\s*nowrap/);
    });

    it("neither wraps nor shrinks the value", () => {
        const value = bodyOf(".panel-row-value");

        assert.match(value, /flex-shrink:\s*0/);
        assert.match(value, /white-space:\s*nowrap/);
    });

    /**
     * And the sub-lines truncate whoever wrote them.
     *
     * The rule that cuts them is written `.panel-row-description > *`, which
     * matches element children only - so it reached the three panels that hand
     * this a node and missed the summary, the one panel that hands it a bare
     * string. That string is a text node with no box of its own: nothing in the
     * stylesheet can address it, and it wrapped the row taller instead. Whether
     * a description cuts or wraps was decided by whether its caller had happened
     * to write a <span>, which is not a decision the stylesheet can even see.
     *
     * The row gives a bare description a box of its own, so the rule that was
     * meant for all four reaches all four.
     */
    it("gives a description of its own a box the truncation can reach", () => {
        assert.match(row, /isValidElement\(description\)/,
            "a description handed over as a string is a text node the stylesheet cannot address,"
            + " so it wraps where every other panel's cuts");
        assert.match(row, /import \{[^}]*isValidElement[^}]*} from "react"/,
            "isValidElement is used without being imported");
    });

    // A fragment of several sub-lines is a valid element, and its children are
    // what the rule has to reach: boxed as one, the two lines a spread and its
    // range are drawn on would collapse into a single line.
    it("passes a description that is already elements straight through", () => {
        assert.match(row, /isValidElement\(description\)\s*\?\s*description\s*:/,
            "a description that is already elements is boxed again, which stacks its lines into one");
    });
});

/**
 * The value cards, which state three speeds each.
 *
 * A speed is the longest kind of figure the app prints, and these are the
 * narrowest cards on the page - `small`, which the grid gives 340px, 293 of them
 * inside the padding. Everything they ask of the shared row is a consequence of
 * that: the figures are rounded whole, the delta stacks under the value instead
 * of sitting beside anything, and the figure itself takes one step down from the
 * shared size.
 *
 * Their width is the page's to spend, not this card's: the row they sit in also
 * holds the hourly chart, and every pixel they take is one the chart loses.
 *
 * Opened, the same card has the width of the dialog and takes the full size back.
 */
describe("the value cards, which state the longest figures", () => {
    const css = compile("pages/Statistics/charts/AverageChart/styles.sass");
    const card = read("pages/Statistics/charts/AverageChart/AverageChart.jsx");

    it("leave the row's width to the chart beside them", () => {
        assert.match(card, /<StatisticContainer[^>]*size="small"/,
            "the value cards grew, and the hourly chart beside them paid for it");
    });

    const rules = [...css.matchAll(/([^{}]*\.panel-row-value[^{}]*)\{([^}]*)}/g)]
        .map(([, selector, body]) => ({selector: selector.trim(), body}));

    const stepped = rules.filter(({body}) => /font-size/.test(body));

    it("state their figures one step down from the shared size", () => {
        assert.equal(stepped.length, 1, `expected one size override, found ${stepped.length}`);
        assert.match(stepped[0].body, /font-size:\s*1\.4rem/);
    });

    it("take the full size back inside the dialog, which has the room", () => {
        assert.ok(stepped[0].selector.includes(":not(.chart-modal-body *)"),
            `"${stepped[0].selector}" shrinks the figure in the enlarged view too`);
    });

    /**
     * The delta stacks under the figure, in the figure's own column - which is
     * as wide as the longest figure whatever else goes in it, so the annotation
     * costs the card nothing. Beside the value it wanted 70px of the row; in the
     * label column beside the target percentage it wanted the same 70 from the
     * half of the row that has a sentence to fit.
     */
    it("stack the delta under the figure rather than beside anything", () => {
        const stacked = rules.find(({body}) => /flex-direction:\s*column/.test(body));

        assert.notEqual(stacked, undefined, "the value column is a row again, so the delta sits beside the figure");
        assert.match(stacked.body, /align-items:\s*flex-end/,
            "the delta is not aligned to the edge the figures line up on");
    });

    /**
     * "86% of your target" wants 130px of the 116 this card can spare beside a
     * gigabit line's figure, and it is translated into fifteen languages that
     * each want their own number. So it wraps: a label that ends in an ellipsis
     * names a measurement the reader is left to guess at, which is the fault the
     * overview card's own narrow rules exist to avoid.
     */
    it("wrap that sentence rather than cutting it short", () => {
        const description = css.match(/\.value-container \.panel-row-description > \*\s*\{([^}]*)}/)?.[1];

        assert.notEqual(description, undefined, "the sub-line takes the shared row's truncation again");
        assert.match(description, /white-space:\s*normal/);
    });

    /**
     * The two ends of the range are not graded, so their glyphs take the
     * neutral.
     *
     * A minimum is the slowest test in the range, not a bad one - which is
     * exactly why neither end carries a percentage or a delta. They were red and
     * green for one afternoon, and a red alarm beside a perfectly good 523 Mbps
     * was all it bought; graded through `level` they would also publish a grade
     * on the row, so a reader who turns `gradeValues` on would find the figure
     * itself in the colour of a bad reading. The average is the only graded
     * figure on the card, so it wears the only verdict.
     */
    it("grade neither end of the range", () => {
        const rows = [...card.matchAll(/<PanelRow[\s\S]*?\/>/g)].map(([row]) => row);
        const endOfRange = rows.filter((row) => /faMinusCircle|faPlusCircle/.test(row));

        assert.equal(endOfRange.length, 2, "the minimum and maximum rows are no longer recognisable");
        for (const row of endOfRange)
            assert.doesNotMatch(row, /level=/, "an end of the range is dressed as a verdict");
    });

    // The neutral, not the quiet grey the panels started with: these glyphs name
    // a measurement and should look chosen rather than left over.
    it("state that neutral as a colour of its own", () => {
        assert.match(bodyOf(".panel-row-icon"), /color:\s*var\(--grade,\s*var\(--icon-neutral\)\)/,
            "an ungraded glyph falls back to something other than the shared neutral");
    });
});

/**
 * The two cards whose labels run out of room before their figures do.
 *
 * The row cuts a label that will not fit, which keeps the figure whole and is
 * the right trade on a card - but a label cut to "Maximu..." names nothing, and
 * a reader is then looking at a number with no measurement attached. Measured
 * across ten languages at every stage of the page, the cut happens in exactly
 * two states, both of them a list of about 300px: the three-across grid, where
 * a card holds 324px of list, and a phone, where it holds 293. Between them -
 * the two-column stage and any display past 1600px - a list is 460px or wider
 * and nothing is cut in any language.
 *
 * What is in those 300px besides the label: the icon and the gap after it,
 * 52px, which is what the overview card already gives up at its own tightest
 * step for exactly this reason. It closes all five of the desktop cuts and
 * fifteen of the eighteen on a phone.
 */
describe("the cards that run out of room for a label", () => {
    const LISTS = [
        {name: "the latest test", list: ".info-container",
            styles: "pages/Statistics/charts/LatestTestChart/styles.sass"},
        {name: "the value cards", list: ".value-container",
            styles: "pages/Statistics/charts/AverageChart/styles.sass"}
    ];

    // The two states a card is cut in, as list widths: the three-across grid,
    // where the cards beside it have exactly the same room, and a phone, where
    // the whole page is down to one column.
    const THREE_ACROSS_LIST = 324;
    const PHONE_LIST = 293;

    const ruleFor = (sheet, selector) =>
        sheet.match(new RegExp(`${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![-\\w])\\s*\\{([^}]*)}`));

    for (const {name, list, styles} of LISTS) {
        const sheet = compile(styles);

        // The list and not the viewport: the same card is drawn at a third of a
        // wide row, at the whole width of a phone, and again inside a dialog,
        // and one viewport figure cannot tell those apart. The overview card
        // learned this the hard way - see overviewModalStyles.test.js.
        it(`lets ${name} measure the room it actually has`, () => {
            assert.notEqual(ruleFor(sheet, list), null, `${list} has no base rule`);

            // Any rule for this list, not the base one: the value card states
            // it on a guarded selector of its own, for the reason below.
            const declaring = [...sheet.matchAll(/([^{}]+)\{([^}]*)}/g)]
                .filter(([, selector, body]) => new RegExp(`\\${list}(?![-\\w])`).test(selector)
                    && /container-type:\s*inline-size/.test(body));

            assert.ok(declaring.length > 0,
                `${list} establishes no container, so nothing can key on its width`);
        });

        /**
         * And the icon goes only where the whole page is down to one column.
         *
         * It is the last thing a row gives up, because it is the only thing in
         * the row that carries the grade: the glyph wears it - see graded-glyph
         * - and the figure beside it is white whatever the reading. A row
         * without its icon states a number with no verdict on it.
         *
         * So it is given up at the width the overview card already gives it up
         * at, which is a phone: there the page is one column, every card is
         * equally tight, and they lose their glyphs together. Taken at the
         * three-across stage instead, this card would stand glyphless beside two
         * that kept theirs on exactly the same 324px of list - which reads as a
         * fault rather than as a tighter card, and costs the grade at a width
         * where an English reader was never cut at all.
         */
        it(`gives up the icon on ${name} only where every card is that tight`, () => {
            const dropping = containerBlocks(sheet)
                .filter(({body}) => /\.panel-row-icon\s*\{[^}]*display:\s*none/.test(body));

            assert.equal(dropping.length, 1,
                `${name} has ${dropping.length} steps that drop the icon, expected one`);

            const at = parseFloat(dropping[0].condition.match(/width\s*<\s*([\d.]+)rem/)?.[1]);

            assert.ok(Number.isFinite(at), `"${dropping[0].condition.trim()}" is not a width step`);
            assert.ok(at * 16 > PHONE_LIST,
                `the icon survives ${at * 16}px of list, so a phone keeps a glyph it has no room for`);
            assert.ok(at * 16 <= THREE_ACROSS_LIST,
                `the icon goes at ${at * 16}px of list, which strips this card `
                + "beside two that keep theirs on the same room");
        });
    }

    /**
     * And the value card establishes its container only where nothing is
     * measuring it.
     *
     * `container-type: inline-size` contains the inline axis, so a size
     * container contributes nothing of its contents to an intrinsic sizing pass
     * - and the dialog this card opens into is shrink-to-fit, which is nothing
     * but that pass. Measured with the container on: the enlarged card fell to
     * 402px against the 426 its rows want on a desktop, and to 282 against 351
     * on a phone, where the dialog's floor is min-content rather than its 400px
     * minimum. Nothing was cut - everything inside is width-relative - it simply
     * stopped filling the space it was given.
     *
     * The step is not wanted there in any case: the enlarged view wraps its
     * labels and steps its figure down on a phone, which is how it keeps them
     * whole without giving up the glyphs.
     *
     * The latest test needs no such guard - opened, that card renders the whole
     * test record instead of this list.
     */
    it("leaves the enlarged value card measurable by the dialog", () => {
        const sheet = compile("pages/Statistics/charts/AverageChart/styles.sass");
        const containers = [...sheet.matchAll(/([^{}]+)\{([^}]*)}/g)]
            .filter(([, , body]) => /container-type:\s*inline-size/.test(body))
            .map(([, selector]) => selector.trim());

        assert.ok(containers.length > 0, "the value card establishes no container at all");

        for (const selector of containers)
            assert.ok(selector.includes(":not(.chart-modal-body *)"),
                `"${selector}" contains the card inside the dialog too, which then has nothing to measure`);
    });

    /**
     * What the three-across stage gets instead: one size off the figure.
     *
     * That band is where French, Ukrainian and Russian are cut and English is
     * not, so the concession has to be one that costs a reader nothing - and the
     * figure is already stated a size larger than anything else in the card. One
     * step down frees more than the icon would and keeps the grade beside it.
     *
     * The latest test only. The value cards state their figure a step down
     * already, on every card at every width, so there is no step of theirs left
     * to take here.
     */
    it("steps the latest test's figure down before it touches the icon", () => {
        const sheet = compile("pages/Statistics/charts/LatestTestChart/styles.sass");
        const stepping = containerBlocks(sheet)
            .filter(({body}) => /\.panel-row-value\s*\{[^}]*font-size/.test(body));

        assert.equal(stepping.length, 1,
            `the card has ${stepping.length} steps that resize the figure, expected one`);

        const at = parseFloat(stepping[0].condition.match(/width\s*<\s*([\d.]+)rem/)?.[1]);

        assert.ok(at * 16 > THREE_ACROSS_LIST,
            `the figure holds its size down to ${at * 16}px of list, where the label beside it is cut`);
        assert.match(stepping[0].body, /font-size:\s*1\.4rem/,
            "the figure steps to a size of its own rather than the one the value cards use");

        const dropping = containerBlocks(sheet)
            .filter(({body}) => /\.panel-row-icon\s*\{[^}]*display:\s*none/.test(body));
        const iconAt = parseFloat(dropping[0].condition.match(/width\s*<\s*([\d.]+)rem/)?.[1]);

        assert.ok(at > iconAt,
            "the icon goes before the figure shrinks, which spends the grade to save a size");
    });

    // One figure for both cards, because they are one measurement: what a row
    // needs before the icon has to go. Two copies is the split that widens.
    it("names those widths once rather than once per card", () => {
        assert.match(rowSizes, /\$panel-icon-drop:\s*[\d.]+rem/,
            "the icon step is a literal in each card, so the two can drift apart");
        assert.match(rowSizes, /\$panel-figure-step:\s*[\d.]+rem/,
            "the figure step has no shared name");
    });
});

/**
 * The overview card's rows used to be spaced by an accident: its value was a
 * bare <h2> whose default margin - 0.83em top and bottom - pushed the rows
 * apart. The shared row states its value in a div, as it should, and the five
 * rows collapsed into one another the moment that margin went.
 */
describe("the overview card spaces its rows", () => {
    const css = compile("pages/Statistics/charts/OverviewChart/styles.sass");
    const container = css.match(/\.overview-items\s*\{([^}]*)}/)?.[1] ?? "";

    it("puts room between them rather than relying on a default margin", () => {
        assert.match(container, /gap:\s*[\d.]+rem/,
            "nothing separates one row from the next");
    });

    // How much room, and that it is the same room every other panel leaves,
    // belongs with the three cards it is shared with - see panelRowGap.test.js.
    // It used to spread the rows down the card instead, which is what made this
    // one the narrowest gap on a row of four cards that were meant to match.
    it("holds them to that room rather than spreading them", () => {
        assert.doesNotMatch(container, /justify-content:\s*space-between/,
            "the rows take whatever height the card has left, so the gap is a floor and not a gap");
    });
});

describe("the panels that state readings", () => {
    for (const {name, file, styles, retired} of PANELS) {
        const source = read(file);

        it(`${name} draws its rows through the shared row`, () => {
            assert.match(source, /import PanelRow from "@\/pages\/Statistics\/components\/PanelRow"/,
                `${name} does not use the shared row`);
            assert.match(source, /<PanelRow/, `${name} imports the shared row and never draws one`);
        });

        it(`${name} keeps no row layout of its own`, () => {
            assert.doesNotMatch(source, asClassName(retired),
                `${name} still draws ${retired} by hand`);
            assert.doesNotMatch(read(styles), asSelector(retired),
                `${name}'s stylesheet still dresses .${retired}`);
        });
    }

    /**
     * And the guard above can actually fail.
     *
     * It was written as a CSS selector and checked against the JSX with
     * String.includes, so the JSX half matched nothing in any of the four
     * components - before the refactor or after it. A regression guard that
     * cannot fail reads as coverage and is not.
     */
    it("recognises a hand-drawn row if one comes back", () => {
        for (const {retired} of PANELS) {
            assert.match(`<div className="${retired}">`, asClassName(retired),
                `a reintroduced ${retired} in the markup would not be noticed`);
            assert.match(`.${retired}\n  display: flex`, asSelector(retired),
                `a reintroduced .${retired} rule would not be noticed`);
        }
    });

    // ...without mistaking the container that legitimately survived for one.
    it("does not mistake the overview's row container for a retired row", () => {
        assert.doesNotMatch('<div className="overview-items">', asClassName("overview-item"));
        assert.doesNotMatch(".overview-items\n  display: flex", asSelector("overview-item"));
    });

    /**
     * And the sheet that dressed all four of them at once.
     *
     * The guard above asks each panel's own stylesheet, and each of the four
     * answered honestly. The shared dialog's sheet was not on the list: it
     * sized the svg and the font of every one of these rows for the enlarged
     * view, and four blocks of rules for classes no component had drawn since
     * the refactor sat there with the suite green over them.
     *
     * Rules nothing can match are not merely inert. They are the next reader's
     * evidence that the class is still in use, and the enlarged view is exactly
     * where someone would look to find out how these rows are meant to grow.
     *
     * Naming one more file would leave the same hole one file over, so the
     * question is put to every stylesheet the client has.
     */
    it("keeps no retired row in any stylesheet, not only the panel's own", () => {
        for (const file of STYLESHEETS) {
            const sheet = read(file);

            for (const {retired} of PANELS)
                assert.doesNotMatch(sheet, asSelector(retired),
                    `${file} still dresses .${retired}`);
        }
    });

    // The sweep is only worth its runtime if it reaches past the four files the
    // guard above already reads - the shared dialog's sheet being the one that
    // held these rules while every listed file was clean.
    it("sweeps the shared dialog's sheet, which held them", () => {
        assert.ok(STYLESHEETS.includes("common/components/ChartModal/styles.sass"),
            "the enlarged view's stylesheet is outside the sweep, which is where the dead rules were");
        assert.ok(STYLESHEETS.length > PANELS.length,
            "the sweep reads no more than the panels' own sheets");
    });
});
