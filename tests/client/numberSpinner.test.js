import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { compile, rules, CLIENT_SRC } from "../helpers/sass.mjs";

/**
 * No number field carries the browser's own spinner.
 *
 * `color-scheme` recolours it, which is worth having, but it stays a cramped
 * two-arrow widget the stylesheet cannot reach: it has no palette, no hover of
 * the app's, and a hit area too small to aim at on anything but a mouse. The
 * app draws its own stepper where stepping is worth offering (NumberField), and
 * the arrow keys go on working everywhere it does not.
 *
 * Said once, on the type, rather than on the three field classes that exist
 * today - .dialog-input, .form-field-input and .storage-input, which are
 * independent and which between them dress fourteen number inputs across six
 * components. StorageDialog was the only one that had thought to suppress it,
 * in its own stylesheet, which is exactly the shape of miss the rule beside
 * this one in default.sass records: a control written next year is right
 * without its author having to know any of this.
 */

const css = compile("common/styles/default.sass");

const ruleFor = (selector) => rules(css).find((rule) => rule.selector === selector);

describe("number inputs", () => {
    it("suppress the spinner on the type, not on a field class", () => {
        const field = ruleFor('input[type=number]');

        assert.ok(field, "no rule targets number inputs themselves");
        assert.match(field.body, /(?:^|[;\s])appearance:\s*textfield/,
            "the standard property is missing, so Safari keeps the spinner");
        assert.match(field.body, /-moz-appearance:\s*textfield/,
            "Firefox keeps the spinner without the prefixed property");
    });

    it("takes both webkit spin buttons off", () => {
        // Asked of whichever rule carries each pseudo-element rather than of an
        // exact selector: the two are written as one grouped rule and sass
        // emits them that way, so a test pinned to the individual spellings
        // would fail on a stylesheet that is correct.
        for (const part of ["inner", "outer"]) {
            const spin = rules(css).find(({selector}) =>
                selector.includes(`input[type=number]::-webkit-${part}-spin-button`));

            assert.ok(spin, `nothing hides the ${part} spin button`);
            assert.match(spin.body, /-webkit-appearance:\s*none/);
            assert.match(spin.body, /margin:\s*0/,
                "the button is hidden but the margin it sat in still pads the field");
        }
    });
});

// -------------------------------------------------------------- no second copy

/** Every .sass under client/src, as a path relative to it. */
const stylesheets = (function walk(dir) {
    return fs.readdirSync(dir, {withFileTypes: true}).flatMap((entry) => {
        const full = path.join(dir, entry.name);

        if (entry.isDirectory()) return walk(full);

        return entry.name.endsWith(".sass") ? [path.relative(CLIENT_SRC, full)] : [];
    });
})(CLIENT_SRC);

const GLOBAL = path.join("common", "styles", "default.sass");

describe("the suppression", () => {
    it("lives in one stylesheet", () => {
        const copies = stylesheets.filter((file) => file !== GLOBAL
            && /-webkit-(inner|outer)-spin-button/.test(fs.readFileSync(path.join(CLIENT_SRC, file), "utf8")));

        assert.deepEqual(copies, [],
            "a component states the rule again; two copies of it can drift the way the select caret did");
    });
});
