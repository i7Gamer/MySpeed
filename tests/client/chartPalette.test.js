import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readSource, walkSources, withoutJsComments } from "../helpers/source.js";
import { compile, declarationsIn } from "../helpers/sass.mjs";

const CHARTS = "client/src/pages/Statistics";

const config = withoutJsComments(readSource(`${CHARTS}/charts/lineChartConfig.js`));

/**
 * The palette had two copies and no reader.
 *
 * _colors.sass declared seven --chart-* properties and chartThemeColors held the
 * same colours again as hsl() literals, keyed on a boolean; four more sat in the
 * chart components themselves and two more in Statistics.jsx, passed down as a
 * prop. Nothing compared any of them. Changing a chart colour in the stylesheet
 * moved nothing on screen, and every literal was free to drift from the property
 * that was supposed to be its source.
 *
 * Both halves are checked here, because either one alone leaves the same hole: a
 * component that names its own colour escapes the palette, and a property with
 * no reader is a colour nobody can see.
 */
describe("the chart palette", () => {
    const css = compile("common/styles/default.sass");

    /** Every --chart-* property the stylesheet declares for one selector. */
    const declared = (selector) =>
        new Set(Object.keys(declarationsIn(css, selector)).filter((name) => name.startsWith("chart-")));

    /** The same blocks, keeping what each property was declared as. */
    const declaredValues = (selector) => declarationsIn(css, selector);

    /** Every property chartThemeColors asks the document for. */
    const read = () => {
        const body = config.slice(config.indexOf("export const chartThemeColors"));

        return new Set([...body.slice(0, body.indexOf("};")).matchAll(/token\("(chart-[\w-]+)"\)/g)]
            .map(([, name]) => name));
    };

    const root = declared(":root");

    it("finds both sides to compare", () => {
        assert.ok(root.size >= 10, `only found ${root.size} chart properties in the stylesheet`);
        assert.ok(read().size >= 10, `only found ${read().size} token reads in chartThemeColors`);
    });

    it("is read where it is declared", () => {
        assert.deepEqual([...root].filter((name) => !read().has(name)).sort(), [],
            "the stylesheet declares these and nothing in the client reads them");
    });

    it("declares what the charts read", () => {
        assert.deepEqual([...read()].filter((name) => !root.has(name)).sort(), [],
            "chartThemeColors asks for these and the stylesheet never declares them - they resolve to the fallback grey");
    });

    /**
     * The chrome a mark sits in follows the chrome everything else sits in.
     *
     * These were four hand-written pairs - a tick colour, a tooltip background,
     * a tooltip border, restated per theme with the same values the surfaces
     * already had. That is two places to change and one of them to forget, and
     * it does not survive a second palette: eight blocks, each restating the
     * dialog colours a chart's tooltip has to match.
     *
     * So they point at the surfaces instead, and a palette gets them for free.
     * What has to be checked is that they still point at something.
     */
    it("takes its chrome from the surfaces", () => {
        const root = declaredValues(":root");

        const stranded = ["chart-tick", "chart-tooltip-bg", "chart-tooltip-title",
            "chart-tooltip-body", "chart-tooltip-border"]
            .map((name) => [name, /^var\(--([\w-]+)\)$/.exec(root[name] ?? "")])
            .filter(([, reference]) => !reference || root[reference[1]] === undefined)
            .map(([name]) => `${name} = ${root[name] ?? "undeclared"}`);

        assert.deepEqual(stranded, [],
            "these do not resolve to a surface, so a palette cannot move them");
    });

    /** The two that cannot derive, because they carry an alpha of their own. */
    it("states the chrome that has to be stated, per palette", () => {
        for (const selector of [":root", "[data-theme=light]"])
            for (const name of ["chart-grid", "chart-crosshair"])
                assert.ok(declared(selector).has(name),
                    `${name} is missing from ${selector}, so it holds the outgoing theme's value`);
    });
});

/**
 * A palette read once and never again.
 *
 * chartThemeColors reads the document, so what keys the memo around it decides
 * how long a chart keeps the outgoing theme's colours - and nothing in the call
 * itself says what that key should be. A chart that memoised on its data, or on
 * nothing, would draw correctly until the reader changed the theme and then keep
 * the old palette for as long as the page stayed open, which no lint rule and no
 * render test would catch. useChartTheme is the one place that answer lives.
 */
describe("every chart that draws on a canvas", () => {
    const CANVAS_CHARTS = [
        "charts/SpeedChart/SpeedChart.jsx",
        "charts/PingChart.jsx",
        "charts/HourlyChart.jsx"
    ];

    for (const chart of CANVAS_CHARTS) {
        const source = readSource(`${CHARTS}/${chart}`);

        it(`${chart} takes the palette from the shared hook`, () => {
            assert.match(source, /const themeColors = useChartTheme\(\);/,
                "this chart memoises the palette itself, so it decides for itself when to re-read it");
            assert.doesNotMatch(withoutJsComments(source), /chartThemeColors\(/,
                "calling chartThemeColors directly means keying the memo by hand");
        });

        /**
         * The crosshair plugin is registered globally, so it draws on every one
         * of these - and it takes its colour from the options rather than
         * reading the document once per hovered frame. A chart that does not
         * pass it gets the literal the plugin keeps for a chart that says
         * nothing, which is a colour no palette owns. The hourly chart did that
         * under all eight combinations.
         */
        it(`${chart} hands the crosshair its colour`, () => {
            const options = withoutJsComments(source);

            assert.ok(/crosshair:\s*\{[^}]*color:\s*themeColors\.crosshair/.test(options)
                || /lineChartOptions\(\{/.test(options),
                "this chart neither sets plugins.crosshair.color nor builds its options with lineChartOptions");
        });
    }
});

/**
 * A colour written into a chart is a colour outside the palette.
 *
 * The two fallbacks below are deliberate and named: each is what a caller gets
 * when the document has nothing to say, which is the case in a test and in the
 * moment before the stylesheet has loaded.
 */
describe("no chart under Statistics", () => {
    // A written-out colour: a hex, or a functional notation whose first argument
    // is a number. The second half is not just `hsl(` because withAlpha builds
    // those names from a template - `rgba(${…})` is code that makes a colour out
    // of one it was given, not a colour anybody chose here.
    const COLOUR = /#[\da-fA-F]{3,8}\b|\b(?:hsl|rgb)a?\(\s*[\d.]/;
    const ALLOWED = new Map([
        ["client/src/pages/Statistics/charts/lineChartConfig.js", 1],
        ["client/src/pages/Statistics/crosshairPlugin.js", 1]
    ]);

    const literalsIn = (source) => withoutJsComments(source)
        .split("\n")
        .filter((line) => COLOUR.test(line));

    it("finds the sources to check", () => {
        assert.ok(walkSources(CHARTS).length >= 8, `only found ${walkSources(CHARTS).length} chart sources`);
    });

    it("names a colour of its own", () => {
        const offenders = walkSources(CHARTS).flatMap(({path: file, source}) => {
            const found = literalsIn(source);
            const allowed = ALLOWED.get(file) ?? 0;

            return found.length > allowed ? [`${file}: ${found.length} (allowed ${allowed})`] : [];
        });

        assert.deepEqual(offenders, [],
            "these hold a colour the palette does not own, so a theme cannot change it");
    });
});

/**
 * The fill under a line is its own colour at an alpha, and the palette speaks
 * hex. withAlpha only knew hsl() - it would have handed the hex straight back,
 * and both stops of the gradient would have been the same opaque colour.
 */
describe("withAlpha", () => {
    it("takes a hex colour to rgba", async () => {
        const {withAlpha} = await import("../../client/src/pages/Statistics/charts/lineChartConfig.js");

        assert.equal(withAlpha("#0891b2", 0.25), "rgba(8, 145, 178, 0.25)");
        assert.equal(withAlpha("#abc", 0.5), "rgba(170, 187, 204, 0.5)");
    });

    it("still takes the functional notations", async () => {
        const {withAlpha} = await import("../../client/src/pages/Statistics/charts/lineChartConfig.js");

        assert.equal(withAlpha("hsl(38, 92%, 50%)", 0.25), "hsla(38, 92%, 50%, 0.25)");
        assert.equal(withAlpha("rgb(8, 145, 178)", 0.4), "rgba(8, 145, 178, 0.4)");
    });

    it("replaces an alpha rather than appending a second one", async () => {
        const {withAlpha} = await import("../../client/src/pages/Statistics/charts/lineChartConfig.js");

        assert.equal(withAlpha("rgba(139, 153, 171, 0.6)", 0.1), "rgba(139, 153, 171, 0.1)");
    });
});
