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

    /**
     * These cards used to state their figure a step down at every width, on the
     * reasoning that a speed is the longest kind of figure the app prints and
     * these cards state three of them.
     *
     * What that missed is that a card is not read on its own. Held to a size no
     * other panel used, it was the odd card on the page at the widths where it
     * had as much room as any of them - and it still had nothing left to give at
     * the widths where it ran out, so "Самый высокий" was cut over the maximum
     * with no step remaining to spend on it.
     *
     * So it takes the shared steps at the shared widths, like every panel. The
     * full size costs it 6px of height where it is now stated, measured across
     * ten languages, and no sub-line that was one line becomes two: the target
     * sentence already wraps where the grid is tight, and the value beside it is
     * already two lines there - the figure over its delta.
     */
    it("state no figure size of their own", () => {
        assert.deepEqual(stepped.map(({selector}) => selector), [],
            "the value cards size their own figure again, so they step at a width of their own");
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
 * What every panel gives up as its list narrows, and what none of them does.
 *
 * The row cuts a label that will not fit, which keeps the figure whole and is
 * the right trade on a card - but a label cut to "Maximu..." names nothing, and
 * a reader is then looking at a number with no measurement attached.
 *
 * Two things were tried for that room and both were wrong. The icon went first,
 * which spends the only part of the row that carries the grade: the glyph wears
 * it and the figure beside it is white whatever the reading, so a row without
 * its icon states a number with no verdict on it. Then each card was left to
 * decide its own figure step, and the four of them disagreed - the latest test
 * stepped at 22rem of list, the summary at 30rem along with its descriptions,
 * the stability card at no width at all, and the value cards were simply a size
 * smaller everywhere. Reported from a real window three times over, and all
 * three reports are one fault seen from different widths: at 1263px the latest
 * test stood glyphless between two cards holding exactly the same list, at
 * 859px it alone stated a smaller figure than the card beside it, and at 795px
 * it lost its glyphs while the page was still two columns wide.
 *
 * So the figure carries both concessions, at two widths, stated once for every
 * panel - and the glyph is not for sale. Measured across fifteen languages with
 * the icon kept, as the widest list that still cuts a label:
 *
 *                     1.75rem   1.4rem   1.2rem
 *   summary             380px    360px    350px
 *   latest test         350px    316px    290px
 *   stability           270px    250px    240px
 *   value cards         360px    328px    300px
 *
 * The summary answers its own band by wrapping the label rather than cutting
 * it, from the width its descriptions go - see the overview card.
 */
describe("what a panel gives up as its list narrows", () => {
    const PANELS = [
        {name: "the summary", list: ".overview-items",
            styles: "pages/Statistics/charts/OverviewChart/styles.sass"},
        {name: "the latest test", list: ".info-container",
            styles: "pages/Statistics/charts/LatestTestChart/styles.sass"},
        {name: "the stability card", list: ".consistency-container",
            styles: "pages/Statistics/charts/ConsistencyChart/styles.sass"},
        {name: "the value cards", list: ".value-container",
            styles: "pages/Statistics/charts/AverageChart/styles.sass"}
    ];

    const ruleFor = (sheet, selector) =>
        sheet.match(new RegExp(`${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![-\\w])\\s*\\{([^}]*)}`));

    for (const {name, list, styles} of PANELS) {
        const sheet = compile(styles);

        /**
         * The list and not the viewport: the same card is drawn at a third of a
         * wide row, at the whole width of a phone, and again inside a dialog,
         * and one viewport figure cannot tell those apart. The overview card
         * learned this the hard way - see overviewModalStyles.test.js.
         *
         * Every panel, without exception: a card whose list is not a container
         * takes no step at all, which is exactly what the stability card did.
         * It held one figure size at every width, so on the two-column stage it
         * stood beside the latest test on the same list with a figure a size
         * larger.
         */
        it(`lets ${name} measure the room it actually has`, () => {
            assert.notEqual(ruleFor(sheet, list), null, `${list} has no base rule`);

            // Any rule for this list, not the base one: two of the cards state
            // it on a guarded selector of their own, for the reason below.
            const declaring = [...sheet.matchAll(/([^{}]+)\{([^}]*)}/g)]
                .filter(([, selector, body]) => new RegExp(`\\${list}(?![-\\w])`).test(selector)
                    && /container-type:\s*inline-size/.test(body));

            assert.ok(declaring.length > 0,
                `${list} establishes no container, so nothing can key on its width`);
        });

        /**
         * And the glyph is never given up, on any panel, at any width.
         *
         * It is the only thing in the row that carries the grade, so a row
         * without it states a number with no verdict on it - and it went at
         * widths the cards do not reach together, which left one card on a row
         * dressed differently from its line-mates and reading as a fault rather
         * than as a tighter card.
         */
        it(`keeps every glyph on ${name}`, () => {
            assert.doesNotMatch(sheet, /\.panel-row-icon\s*\{[^}]*display:\s*none/,
                `${name} hides the row icon, which takes the grade off the reading with it`);
        });

        /**
         * And no panel states a figure size of its own. That is what let the
         * four of them disagree: a size written per card is four thresholds
         * that hold until one of them is edited.
         */
        it(`leaves ${name} taking the shared figure size`, () => {
            const own = [...sheet.matchAll(/([^{}]*\.panel-row-value[^{}]*)\{([^}]*)}/g)]
                .filter(([, , body]) => /font-size/.test(body));

            assert.deepEqual(own.map(([, selector]) => selector.trim()), [],
                `${name} sizes its own figure, so it can step at a width no other panel steps at`);
        });
    }

    /**
     * And a card establishes its container only where nothing is measuring it.
     *
     * `container-type: inline-size` contains the inline axis, so a size
     * container contributes nothing of its contents to an intrinsic sizing pass
     * - and the dialog these cards open into is shrink-to-fit, which is nothing
     * but that pass. Measured with the container on: the enlarged value card
     * fell to 402px against the 426 its rows want on a desktop, and to 282
     * against 351 on a phone, where the dialog's floor is min-content rather
     * than its 400px minimum. Nothing was cut - everything inside is
     * width-relative - it simply stopped filling the space it was given.
     *
     * No step is wanted there in any case: with no container above them the rows
     * measure nothing, and the enlarged card states its figures at full size in
     * a dialog wider than any cell of the grid.
     *
     * The latest test needs no such guard - opened, that card renders the whole
     * test record instead of this list.
     */
    for (const [name, styles] of [
        ["value card", "pages/Statistics/charts/AverageChart/styles.sass"],
        ["stability card", "pages/Statistics/charts/ConsistencyChart/styles.sass"]
    ]) {
        it(`leaves the enlarged ${name} measurable by the dialog`, () => {
            const sheet = compile(styles);
            const containers = [...sheet.matchAll(/([^{}]+)\{([^}]*)}/g)]
                .filter(([, , body]) => /container-type:\s*inline-size/.test(body))
                .map(([, selector]) => selector.trim());

            assert.ok(containers.length > 0, `the ${name} establishes no container at all`);

            for (const selector of containers)
                assert.ok(selector.includes(":not(.chart-modal-body *)"),
                    `"${selector}" contains the card inside the dialog too, which then has nothing to measure`);
        });
    }

    /**
     * The steps themselves: two of them, on the figure, in the shared row.
     *
     * Written there rather than on each card because "the same width on every
     * panel" is the whole point of them. The query is unnamed, so a row steps on
     * whichever list it is drawn in - which is what makes cards drawn side by
     * side step together whatever stage the page is in, since line-mates hold
     * the same width.
     */
    describe("the figure's two steps", () => {
        const steps = containerBlocks(css)
            .map(({condition, body}) => ({
                at: parseFloat(condition.match(/width\s*<\s*([\d.]+)rem/)?.[1]),
                size: body.match(/font-size:\s*([\d.]+)rem/)?.[1],
                body
            }))
            .filter(({at}) => Number.isFinite(at));

        it("are stated by the row itself, so no card can hold one of its own", () => {
            assert.equal(steps.length, 2,
                `the shared row states ${steps.length} width steps, expected two`);

            for (const {body} of steps)
                assert.match(body, /\.panel-row-value\s*\{[^}]*font-size/,
                    "a step of the shared row's spends something other than the figure");
        });

        // Both land at the same specificity, so only source order settles which
        // one holds on a list narrow enough to match them both.
        it("state the tighter one second, where it can win", () => {
            assert.ok(steps[0].at > steps[1].at,
                `the ${steps[1].at}rem step is stated before the ${steps[0].at}rem one, `
                + "so the wider step wins on the narrowest lists");
            assert.ok(Number(steps[0].size) > Number(steps[1].size),
                "the tighter step does not state a smaller figure");
        });

        /**
         * And the first is taken before a label is cut: 350px of list is the
         * widest the latest test is cut at with its glyph kept, and that is the
         * card carrying the cut in nine of the fifteen languages.
         */
        it("takes the first step before a label is cut", () => {
            assert.ok(steps[0].at * 16 > 350,
                `the figure holds its size down to ${steps[0].at * 16}px of list, `
                + "where the label beside it is already being cut");
        });
    });

    // One figure for every card, because it is one measurement: what a row needs
    // before the figure has to step. A copy per card is the split that widens.
    it("names those widths once rather than once per card", () => {
        assert.match(rowSizes, /\$panel-figure-step:\s*[\d.]+rem/,
            "the first step is a literal in the row's rules, with no name to read it by");
        assert.match(rowSizes, /\$panel-figure-floor:\s*[\d.]+rem/,
            "the second step has no shared name");
        assert.match(rowSizes, /\$panel-value-size-tight:\s*[\d.]+rem/,
            "the tightest figure size has no shared name");
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
