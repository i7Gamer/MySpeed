import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { compile, read, rules } from "../helpers/sass.mjs";
import { walkSources } from "../helpers/source.js";

/**
 * One ring, drawn the same way wherever the keyboard lands.
 *
 * It was five treatments and a gap. Two offsets - 2px on the header's icons,
 * 3px on the help buttons and the card rows - a soft box-shadow on the
 * checkbox, a sharp-cornered ring on the one control with no corner radius of
 * its own, and four controls with no rule at all, which left them wearing the
 * browser's: on a dark theme that is a white double ring, which is what a date
 * picker closed with Escape was drawing.
 *
 * The tests below hold the ring to one definition rather than to a list of
 * selectors, so a component that invents its own is caught where it is written
 * rather than the next time somebody tabs through the page.
 */

const FOCUS = read("common/styles/_focus.sass");

const token = (name) => {
    const found = new RegExp(`\\$${name}:\\s*([^\\n]+)`).exec(FOCUS)?.[1]?.trim();

    assert.ok(found, `_focus.sass defines no $${name}`);
    return found;
};

/** Every rule in the client that paints something when focus is visible. */
const focusRules = () => walkSources("client/src", /\.sass$/)
    .flatMap(({path}) => {
        const relative = path.replace(/^client\/src\//, "");
        let css;
        try { css = compile(relative); } catch { return []; }

        return rules(css)
            .filter(({selector}) => selector.includes(":focus-visible"))
            .map((rule) => ({...rule, file: relative}));
    });

const declaration = (body, property) =>
    new RegExp(`(?:^|[;{])\\s*${property}:\\s*([^;]+)`).exec(body)?.[1]?.trim();

describe("the focus ring", () => {
    it("has one definition to be drawn from", () => {
        assert.ok(token("focus-ring-width"), "the width is spelled out per component again");
        assert.ok(token("focus-ring-offset"), "the offset is spelled out per component again");
    });

    /**
     * Width and colour are the ring. An offset differs by a pixel between a
     * 200px button and a 14px glyph and nobody can see it; a 1px white ring
     * beside a 2px green one is a different control.
     */
    it("is the same width and colour wherever it is drawn", () => {
        const painted = focusRules().filter(({body}) => declaration(body, "outline"));

        assert.ok(painted.length >= 8, `only ${painted.length} rules draw a ring at all`);

        for (const {selector, body, file} of painted)
            assert.equal(declaration(body, "outline"),
                `${token("focus-ring-width")} solid var(--accent-primary)`,
                `${file} draws "${selector}" with a ring of its own`);
    });

    /**
     * An outline follows the element's own corner radius, so most controls need
     * nothing. The exception is a control with no radius at all, which gets a
     * hard-cornered box around a round glyph.
     */
    it("takes a corner where the control has none", () => {
        const body = focusRules().find(({selector}) => selector.includes(".header-icon"))?.body;

        assert.ok(body, "the header's icons draw no ring");
        assert.ok(declaration(body, "border-radius"),
            "a 30px square ring around a round glyph reads as a box bolted on");
    });

    /**
     * The four that had none. Each was left wearing the browser's own ring,
     * which on this theme is white - reported against the date picker, and true
     * of the other three.
     */
    for (const [control, sheet] of [
        [".date-range-trigger", "common/components/DateRangePicker/styles.sass"],
        [".start-test", "common/components/StartTestButton/styles.sass"],
        [".export-button", "common/components/ExportButton/styles.sass"],
        [".pagination-item", "common/components/Header/components/Pagination/styles.sass"]
    ]) {
        it(`is drawn by ${control} rather than left to the browser`, () => {
            const drawn = rules(compile(sheet))
                .some(({selector, body}) => selector.includes(`${control}:focus-visible`)
                    && declaration(body, "outline"));

            assert.ok(drawn, `${control} still falls back to the browser's own ring`);
        });
    }

    /**
     * A button drawn around nothing but an icon is that icon's box, and an
     * icon's box is not its picture: the glyphs are drawn at a fixed 1.25em
     * width whatever shape they are, so an arrow sat in a box with 9px of
     * nothing either side and the ring drew around the nothing. The ping paddle
     * fared worse - 0px above, -2px below, 4 left and 14 right.
     *
     * Its own aspect makes the box the glyph; the padding is then the ring's
     * air, equal on every side; and the negative margin hands the layout back
     * what the padding took, so nothing around it moves.
     */
    it("gives a bare glyph a box its own shape, with equal air round it", () => {
        const help = rules(compile("common/styles/default.sass"))
            .find(({selector}) => selector === ".help-button");

        assert.ok(help, "the help button rule has moved");
        assert.equal(declaration(help.body, "padding"), token("focus-ring-pad"),
            "the ring sits straight on the ink again");
        assert.equal(declaration(help.body, "margin"), `-${token("focus-ring-pad")}`,
            "the padding is not given back, so every icon has shifted");
        assert.equal(declaration(help.body, "justify-content"), "center",
            "the glyph is not centred in the box the ring draws");
    });

    /**
     * And the spacing to the figure is the row's, not the glyph's. As a margin
     * on the glyph it sat inside the button, so the ring enclosed it - which is
     * where the 14px of dead space on one side came from.
     */
    it("keeps the gap to the figure outside the button", () => {
        const icon = rules(compile("common/styles/default.sass"))
            .find(({selector}) => selector === ".speedtest-icon");

        assert.ok(icon, "the overview glyph rule has moved");
        assert.equal(declaration(icon.body, "margin-right"), undefined,
            "the gap is inside the button again, so the ring draws around it");

        const row = rules(compile("pages/Home/components/Speedtest/styles.sass"))
            .find(({selector}) => selector === ".speedtest-row");

        assert.ok(declaration(row?.body ?? "", "gap"),
            "nothing separates the glyph from its figure now the margin has gone");
    });

    /**
     * A ring is not an animation. `transition: all` takes the outline with it,
     * so the ring fades in over the control's own duration after a keypress -
     * and where the keyboard is standing is the last thing that should arrive
     * late. It was doing exactly that on the header's icons and the storage
     * tabs, which is how it was found.
     *
     * Held against every control that draws a ring rather than against those
     * two, since the next one to reach for `all` would be silently the same.
     */
    it("appears at once, wherever it is drawn", () => {
        for (const {selector, file} of focusRules()) {
            const base = selector.replace(/:focus-visible.*$/, "").trim();
            const rule = rules(compile(file)).find((r) => r.selector === base);
            if (!rule) continue;

            assert.doesNotMatch(declaration(rule.body, "transition") ?? "", /\ball\b/,
                `${file}: "${base}" transitions all, which animates its focus ring`);
        }
    });
});
