import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readSource, withoutJsComments } from "../helpers/source.js";
import { compile } from "../helpers/sass.mjs";
import {
    DEFAULT_PALETTE, normalisePalette, PALETTES, PALETTE_SLATE
} from "../../client/src/common/contexts/Theme/paletteChoice.js";
import { PALETTE_NAMES } from "../../client/src/common/utils/InvariantText.js";
import { THEMES } from "../../client/src/common/contexts/Theme/themeChoice.js";

/**
 * One name, declared twice, with nothing holding the two ends together.
 *
 * This is the shape of every silent fault this codebase has had: an integration
 * naming an icon nothing registered, a toast asking for a colour the stylesheet
 * had no rule for, a preference the stylesheets read that no control could
 * write. Each was correct on both sides and wrong between them, and nothing
 * failed - not the build, not the tests, not the eye, until the thing was in
 * front of a reader looking blank.
 *
 * A palette is the same shape three times over: a name in PALETTES, a block in
 * _colors.sass, a row in the dialog, and a line of prose in fifteen locale
 * files. So all four are compared here rather than trusted.
 */
describe("every palette the client offers", () => {
    const css = compile("common/styles/default.sass");
    const dialog = withoutJsComments(readSource("client/src/common/components/PreferencesDialog/PreferencesDialog.jsx"));

    const emitted = [...new Set([...css.matchAll(/\[data-palette=([\w-]+)\]/g)].map(([, name]) => name))];

    it("has a block in the stylesheet", () => {
        assert.deepEqual(PALETTES.filter((name) => !emitted.includes(name)), [],
            "these are offered and the stylesheet declares nothing for them, so choosing one changes no colour");
    });

    it("is offered for every block the stylesheet declares", () => {
        assert.deepEqual(emitted.filter((name) => !PALETTES.includes(name)), [],
            "these are styled and unreachable - nothing can put the attribute on the document");
    });

    it("has a name that is not translated", () => {
        assert.deepEqual(PALETTES.filter((name) => !PALETTE_NAMES[name]), [],
            "a palette with no constant would render as its own key or as nothing");
        assert.deepEqual(Object.keys(PALETTE_NAMES).filter((name) => !PALETTES.includes(name)), [],
            "a name for a palette that no longer exists");
    });

    /**
     * Built from PALETTES rather than written out, so this cannot drift - but
     * that is the claim, and a claim is what a test is for. If the array in the
     * dialog ever goes back to being a literal, this is what says so.
     */
    it("has a row in the preferences dialog", () => {
        const at = dialog.indexOf("const PALETTE_OPTIONS =");

        assert.notEqual(at, -1, "PALETTE_OPTIONS is not where the dialog declares its palette rows");
        assert.match(dialog.slice(at, dialog.indexOf("}));", at)), /PALETTES\.map/,
            "the rows are written out rather than built from PALETTES, so the two can disagree");
    });

    it("describes itself in English", () => {
        const english = JSON.parse(readSource("client/public/assets/locales/en.json"));

        assert.deepEqual(PALETTES.filter((name) => !english.preferences?.palette?.[`${name}_desc`]), [],
            "these rows would render their own key as their description");
    });
});

/**
 * The theme rows had the same gap and still have no such guarantee elsewhere:
 * THEME_OPTIONS is a literal, and nothing joined it to THEMES. A theme with no
 * row is unreachable; a row for a theme normaliseTheme rejects sets the stored
 * value back to the default the moment it is read.
 */
describe("every theme the client accepts", () => {
    const dialog = withoutJsComments(readSource("client/src/common/components/PreferencesDialog/PreferencesDialog.jsx"));

    const offered = () => {
        const block = dialog.slice(dialog.indexOf("const THEME_OPTIONS = ["));

        return [...block.slice(0, block.indexOf("];")).matchAll(/\{id: (\w+),/g)]
            .map(([, constant]) => ({THEME_SYSTEM: "system", THEME_DARK: "dark", THEME_LIGHT: "light"})[constant]);
    };

    it("finds the rows to check", () => {
        assert.equal(offered().length, THEMES.length, `parsed ${offered().length} theme rows`);
    });

    it("has a row in the preferences dialog", () => {
        assert.deepEqual([...THEMES].sort(), [...offered()].sort(),
            "the dialog offers a different set of themes than the context accepts");
    });
});

describe("normalisePalette", () => {
    it("keeps a palette we have", () => {
        for (const name of PALETTES) assert.equal(normalisePalette(name), name);
    });

    /**
     * Storage outlives releases. A palette dropped in a later version is still
     * in localStorage on every machine that chose it, and an unknown value
     * matches no block - the document would keep the default's properties while
     * the dialog showed a selection nobody can see.
     */
    it("answers the default for anything else", () => {
        for (const stored of [undefined, null, "", "sepia", "SLATE", 3, {}])
            assert.equal(normalisePalette(stored), DEFAULT_PALETTE);
    });

    it("defaults to the colours MySpeed shipped with", () => {
        assert.equal(DEFAULT_PALETTE, PALETTE_SLATE,
            "an upgrade must not repaint an instance nobody asked to repaint");
    });
});
