import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { compile, rules, CLIENT_SRC } from "../helpers/sass.mjs";
import { withoutJsComments } from "../helpers/source.js";

/**
 * Every native <select> wears the same arrow, from one place.
 *
 * A <select> draws its own arrow in the browser's chrome, and `color-scheme`
 * alone only recolours it - it stays the operating system's glyph beside
 * controls drawn in the app's. StorageDialog had already answered that for its
 * retention picker, with a wrapper and a rotated-border caret written into its
 * own stylesheet; the other four selects, the quiet-hours timezone among them,
 * kept the native arrow. One control styled and four not is the drift, and a
 * private copy in one component's sheet is what let it happen.
 *
 * So the caret is `.select-wrap` and the reset is `.select-field`, next to
 * `.dialog-input` in the dialog stylesheet every one of these lives inside.
 * The check that matters is the last one: a sixth select added next year fails
 * here until its author opts in, which is the thing a mixin alone cannot do.
 */

const dialogCss = compile("common/contexts/Dialog/styles.sass");
const storageCss = compile("common/components/StorageDialog/styles.sass");

const ruleFor = (css, selector) => rules(css).find((rule) => rule.selector === selector);

describe("the shared select chrome", () => {
    it("anchors the caret on the wrapper", () => {
        const wrap = ruleFor(dialogCss, ".select-wrap");

        assert.ok(wrap, ".select-wrap is not in the dialog stylesheet");
        assert.match(wrap.body, /position:\s*relative/,
            "the caret is absolutely positioned, so the wrapper has to be its containing block");
    });

    it("draws the caret as a rotated corner, in the palette's subtext", () => {
        const caret = ruleFor(dialogCss, ".select-wrap::after");

        assert.ok(caret, "no ::after on .select-wrap; there is no caret to draw");
        assert.match(caret.body, /border-right:[^;]*var\(--subtext\)/, "the caret left the palette");
        assert.match(caret.body, /border-bottom:[^;]*var\(--subtext\)/, "the caret left the palette");
        assert.match(caret.body, /rotate\(45deg\)/, "the corner is no longer turned into a caret");
        assert.match(caret.body, /pointer-events:\s*none/,
            "the caret would swallow the click that opens the list it points at");
    });

    it("answers a hover on the field, not on the caret alone", () => {
        const hover = ruleFor(dialogCss, ".select-wrap:hover::after");

        assert.ok(hover, "hovering the select no longer lights its caret");
        assert.match(hover.body, /border-color:\s*var\(--accent-primary\)/);
    });

    it("takes the browser's own arrow off the field", () => {
        const field = ruleFor(dialogCss, ".select-field");

        assert.ok(field, ".select-field is not in the dialog stylesheet");
        assert.match(field.body, /(?:^|[;\s])appearance:\s*none/, "the native arrow is back beside the drawn one");
        assert.match(field.body, /-webkit-appearance:\s*none/);
        assert.match(field.body, /-moz-appearance:\s*none/);
        assert.match(field.body, /padding-right:/, "the value would run underneath the caret");
        assert.ok(ruleFor(dialogCss, ".select-field::-ms-expand"), "Edge's legacy arrow is unhidden");
    });

    it("leaves no private copy in the storage dialog", () => {
        assert.equal(ruleFor(storageCss, ".storage-retention-select-wrap::after"), undefined,
            "the caret is drawn twice, and the two copies can drift again");
        assert.equal(ruleFor(storageCss, ".storage-select"), undefined,
            "the reset is stated twice, and the two copies can drift again");
    });
});

// ------------------------------------------------------------------ every site

/**
 * Every .jsx under client/src, as a path and its source with the comments gone.
 *
 * Stripped, because CompareSelect's header explains that it is a menu of its
 * own "rather than a <select>" - and a scan that counts the tag in prose asks
 * a component with no select in it to carry a wrapper.
 */
const components = (function walk(dir) {
    return fs.readdirSync(dir, {withFileTypes: true}).flatMap((entry) => {
        const full = path.join(dir, entry.name);

        if (entry.isDirectory()) return walk(full);
        if (!entry.name.endsWith(".jsx")) return [];

        return [{
            file: path.relative(CLIENT_SRC, full),
            source: withoutJsComments(fs.readFileSync(full, "utf8"))
        }];
    });
})(CLIENT_SRC);

const count = (source, pattern) => source.match(pattern)?.length ?? 0;

describe("every native select in the client", () => {
    const withSelects = components.filter(({source}) => /<select[\s>]/.test(source));

    it("finds the selects to check", () => {
        assert.ok(withSelects.length >= 5,
            `only found selects in ${withSelects.length} components; the scan stopped seeing them`);
    });

    for (const {file, source} of withSelects) {
        it(`is wrapped and reset in ${file}`, () => {
            const selects = count(source, /<select[\s>]/g);

            assert.equal(count(source, /className="[^"]*\bselect-wrap\b/g), selects,
                `${selects} select(s) here, and not that many .select-wrap parents`);
            assert.equal(count(source, /\bselect-field\b/g), selects,
                `${selects} select(s) here, and not that many carry .select-field`);
        });
    }
});
