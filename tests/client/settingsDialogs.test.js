import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readSource, withoutJsComments } from "../helpers/source.js";
import { compile } from "../helpers/sass.mjs";

const ROOT = path.resolve(fileURLToPath(import.meta.url), "..", "..", "..");
const COMPONENTS = path.join(ROOT, "client", "src", "common", "components");

/**
 * The dialogs behind the settings menu, and the things they should agree on.
 *
 * They had drifted: five said 28rem, language said 22 and preferences 26, and
 * none of them recorded why. A reader opening two of them in a row saw the
 * dialog change size for no reason they could name, and the narrowest was the
 * one with fifteen rows in it.
 *
 * The list is read from the menu rather than written here, so a dialog added to
 * that menu later is held to the same agreement without anyone remembering.
 */
describe("every dialog in the settings menu", () => {
    const dropdown = withoutJsComments(readSource("client/src/common/components/Dropdown/DropdownComponent.jsx"));

    /*
     * Excluded, each for a stated reason rather than because it failed:
     * storage is a tabbed table and genuinely wider, and integration and
     * welcome size to their content. The exclusions are named so that adding
     * one is a decision somebody writes down.
     */
    const SIZES_TO_ITS_CONTENT = ["StorageDialog", "IntegrationDialog", "WelcomeDialog"];

    const opened = () => [...new Set([...dropdown.matchAll(/setShow(\w+Dialog)\(true\)/g)]
        .map(([, name]) => name))].filter((name) => !SIZES_TO_ITS_CONTENT.includes(name));

    /**
     * The class the dialog puts on itself, and the width the compiled sheet
     * gives that class.
     *
     * Read from the output rather than from the source: a `width:` in a .sass
     * file is only the dialog's own if it is at the right nesting depth, and a
     * check that guesses at indentation reports every field and swatch inside
     * the dialog as well. What matters is the rule the browser applies.
     */
    const declaredWidth = (component) => {
        const jsx = readSource(`client/src/common/components/${component}/${component}.jsx`);
        const [, selector] = /className="([a-z-]*dialog[a-z-]*)"/.exec(jsx) ?? [];

        if (!selector) return null;

        // Its own stylesheet, not default.sass: a component's styles reach the
        // page through its JSX importing them, so they are nowhere in the one
        // sheet App.jsx loads.
        const styles = compile(`common/components/${component}/styles.sass`);
        const at = styles.indexOf(`.${selector} {`);

        if (at === -1) return null;

        return (/width:\s*([^;]+);/.exec(styles.slice(at, styles.indexOf("}", at))) ?? [])[1] ?? null;
    };

    it("finds the dialogs to check", () => {
        assert.ok(opened().length >= 6, `only found ${opened().length} settings dialogs in the menu`);
        assert.ok(opened().every((name) => declaredWidth(name) !== null),
            `could not read a width for ${opened().filter((name) => declaredWidth(name) === null).join(", ")}`);
    });

    it("is the same width as the one beside it in the menu", () => {
        const widths = opened().map((name) => [name, declaredWidth(name)]);
        const [, shared] = widths[0];

        assert.deepEqual(widths.filter(([, width]) => width !== shared).map(([name]) => name), [],
            `these differ from ${shared}, so the menu changes size between them`);
    });
});

/**
 * The list that scrolls inside the language dialog.
 *
 * Raising it to 28rem made the dialog taller than a laptop viewport leaves
 * room for, which handed `.dialog-main` - itself overflow auto - a few pixels
 * of slack. A wheel at the list's bottom then chains into that slack: the
 * whole dialog shifts up, the last language's bottom border slides under the
 * dialog's edge, and scrolling back has to unwind the dialog before the list
 * will sit at its real bottom again. Measured at 1280x620: 20px of slack, and
 * the last row's border cropped by exactly the chained pixel.
 *
 * Two rules close both halves: the height yields to the viewport, so the
 * dialog fits and the slack never exists - and the list contains its own
 * overscroll, so whatever slack a window still produces cannot be reached
 * from inside the list.
 */
describe("the language list", () => {
    const css = compile("common/components/LanguageDialog/styles.sass");

    const listRule = () => {
        const at = css.indexOf(".language-list {");

        assert.notEqual(at, -1, "the language list has no rule in its stylesheet");
        return css.slice(at, css.indexOf("}", at));
    };

    it("keeps its wheel to itself at its ends", () => {
        assert.match(listRule(), /overscroll-behavior:\s*contain/,
            "a wheel at the list's end scrolls the dialog behind it, which hides the last row's border");
    });

    it("yields its height to the viewport before the dialog has to scroll", () => {
        // The compiler may drop the redundant calc() inside min(), so the
        // assertion reads the mechanism - a viewport term minus an allowance -
        // rather than one spelling of it.
        assert.match(listRule(), /max-height:\s*min\(28rem,\s*(?:calc\()?100dvh\s*-\s*\d/,
            "a fixed max-height makes the dialog outgrow short viewports, which is where the slack comes from");
    });
});

/**
 * The scrollbar, which had no visible thumb anywhere in the app.
 *
 * $light-gray is a border colour, and as a thumb it measured 1.30:1 against a
 * dialog's surface - a scrollbar is a control, which answers to 3:1. Under
 * 730px it was worse than invisible: a 5px bar with a 3px inset on each side
 * leaves the thumb less than nothing to be drawn in, so there was no position
 * indicator at all.
 *
 * The colour is held by paletteContrast.test.js, which measures it against
 * every surface of every palette. What is held here is the geometry, and that
 * one rule serves every surface rather than each dialog writing its own.
 */
describe("the scrollbar", () => {
    const css = compile("common/styles/default.sass");

    const ruleFor = (selector, from = 0) => {
        const at = css.indexOf(`${selector} {`, from);
        return at === -1 ? null : css.slice(at, css.indexOf("}", at));
    };

    it("leaves room for the thumb inside the bar", () => {
        const widths = [...css.matchAll(/::-webkit-scrollbar \{[^}]*?width:\s*(\d+)px/g)].map(([, px]) => Number(px));
        const insets = [...css.matchAll(/::-webkit-scrollbar-thumb \{[^}]*?border(?:-width)?:\s*(\d+)px/g)]
            .map(([, px]) => Number(px));

        assert.ok(widths.length >= 2, `only found ${widths.length} scrollbar widths`);
        assert.ok(insets.length >= 1, "the thumb states no inset");
        assert.ok(Math.min(...widths) > 2 * Math.max(...insets),
            `a ${Math.min(...widths)}px bar cannot hold a thumb inset by ${Math.max(...insets)}px on each side`);
    });

    it("does not paint a surface it cannot know", () => {
        const thumb = ruleFor("::-webkit-scrollbar-thumb");

        assert.match(thumb, /background-clip:\s*padding-box/,
            "without this the inset has to be painted in some surface's colour, and a dialog is not the page");
        assert.match(ruleFor("::-webkit-scrollbar-track"), /background:\s*(transparent|none|0 0)/);
    });

    /** Firefox has none of the -webkit- rules and answers to these instead. */
    it("is themed for a browser without ::-webkit-scrollbar", () => {
        assert.match(css, /@supports not selector\(::-webkit-scrollbar\)/);
        assert.match(css, /scrollbar-color:\s*var\(--scrollbar-thumb\)/);
    });

    it("is stated once rather than per dialog", () => {
        const own = fs.readdirSync(COMPONENTS)
            .filter((name) => fs.existsSync(path.join(COMPONENTS, name, "styles.sass")))
            .filter((name) => /::-webkit-scrollbar/.test(fs.readFileSync(path.join(COMPONENTS, name, "styles.sass"), "utf8")));

        assert.deepEqual(own, [],
            "these carry their own scrollbar rules, which is how the colour got fixed everywhere except here");
    });
});
