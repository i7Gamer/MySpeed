import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { compile, rules } from "../helpers/sass.mjs";

/**
 * Every palette block tells the browser which scheme it is painting in.
 *
 * The client stamps `data-theme` on <html> and paints every surface itself, but
 * it never declared `color-scheme` - so the parts of a form control the browser
 * draws rather than the stylesheet were drawn in the browser's default light
 * scheme on top of the app's dark fields. That is a number input's spin
 * buttons, a time input's clock glyph and its empty `--:--` segments, the time
 * picker's popup, and every native <select>'s open list: black-on-black or
 * white-panel-on-dark-dialog, none of them reachable by a rule.
 *
 * One declaration in the palette-tokens mixin settles all of them, and settles
 * them for a palette added later - which is the reason it is checked here the
 * way the contrast floors are, by finding the blocks rather than listing them.
 * A palette block is identified by declaring `--background`: every block states
 * every token, so that is what makes one a palette block rather than a rule
 * that happens to share a selector shape.
 */

const css = compile("common/styles/default.sass");

// The light blocks are exactly the ones selected through [data-theme=light] -
// `:root` and a bare [data-palette] are the dark halves. Read off the selector
// rather than from a list, so a fifth palette is judged by the same sentence.
const paletteBlocks = rules(css)
    .filter(({body}) => /--background:/.test(body))
    .map(({selector, body}) => ({
        selector,
        body,
        mode: selector.includes("[data-theme=light]") ? "light" : "dark"
    }));

const declared = (body) => body.match(/(?:^|[;{\s])color-scheme:\s*([^;]+)/)?.[1]?.trim();

describe("the palette blocks", () => {
    it("finds every block the stylesheet emits", () => {
        // Two for the unstamped document plus two per palette. Four palettes
        // ship today, so ten - asserted as a floor, because the point of the
        // check below is that a new palette joins it without being named.
        assert.ok(paletteBlocks.length >= 10,
            `only found ${paletteBlocks.length} palette blocks; the emit changed shape`);
        assert.ok(paletteBlocks.some(({mode}) => mode === "light"), "no light block was recognised");
    });

    for (const {selector, body, mode} of paletteBlocks) {
        it(`declares the ${mode} colour scheme on ${selector}`, () => {
            assert.equal(declared(body), mode,
                `${selector} paints ${mode} surfaces but leaves the browser drawing its controls otherwise`);
        });
    }
});
