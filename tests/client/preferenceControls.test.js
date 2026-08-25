import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readLocale, readSource, walkSources, withoutJsComments } from "../helpers/source.js";
import { compile } from "../helpers/sass.mjs";
// The same flattening the parity suite reads keys with: "a.b.c" against the
// nested locale object, one implementation for both.
import { flatten } from "../../scripts/localeGaps.js";

const dialog = withoutJsComments(readSource("client/src/common/components/PreferencesDialog/PreferencesDialog.jsx"));
const context = withoutJsComments(readSource("client/src/common/contexts/Preferences/PreferencesContext.jsx"));

/**
 * A preference nothing can set.
 *
 * `gradeValues` shipped in 1.3.2 with everything except a way to turn it on: it
 * was declared in DEFAULTS, stamped on the document, read by _grades.sass and
 * covered by gradePlacement.test.js - and no control anywhere wrote it. The
 * release notes promised "a new preference to colour the figure as well" and the
 * dialog had three sections, none of them that one. Every individual piece had a
 * test; the chain from a click to the attribute did not.
 *
 * This is the general form: whatever DEFAULTS declares, something has to write.
 */
describe("every preference", () => {
    const declared = () => {
        const block = context.slice(context.indexOf("const DEFAULTS = {"));
        const body = block.slice(0, block.indexOf("};"));

        return [...body.matchAll(/^\s{4}(\w+):/gm)].map(([, name]) => name);
    };

    const written = () => {
        const calls = walkSources("client/src")
            .flatMap(({source}) => [...source.matchAll(/updatePreferences\(\{([\s\S]{0,200}?)\}\)/g)])
            .map(([, body]) => body);

        return new Set(calls.flatMap((body) => [...body.matchAll(/(\w+)\s*[:,}]/g)].map(([, name]) => name)));
    };

    it("finds the defaults to check", () => {
        assert.ok(declared().length >= 4, `only parsed ${declared().length} preferences out of DEFAULTS`);
    });

    it("has something that can set it", () => {
        const unreachable = declared().filter((name) => !written().has(name));

        assert.deepEqual(unreachable, [],
            "these are declared, read and styled, and no control in the client writes them");
    });
});

/**
 * An option row with no words in it.
 *
 * The dialog builds every row from a `labelKey` and a `descKey`, and i18nKeys
 * cannot see either: they are properties of an object literal, not arguments to
 * t(). A row whose keys are missing renders its own key as its title, in every
 * language including English.
 */
describe("every option the preferences dialog offers", () => {
    const english = flatten(readLocale("en"));

    // Every descKey, and every labelKey that exists. A row whose name is the
    // same in every language carries a `label` constant instead - see
    // PALETTE_NAMES - so matching only on the labelKey/descKey pair would have
    // skipped the four palette rows silently, which is the failure this
    // describe exists to catch.
    const optionKeys = () => [...dialog.matchAll(/(?:labelKey|descKey):\s*"([^"]+)"/g)]
        .map(([, key]) => key);

    /**
     * The rows themselves, so a row that declares neither a key nor a constant
     * - or both - fails rather than going unmeasured.
     */
    const optionRows = () => [...dialog.matchAll(/\{id:[^}]*?descKey:[^}]*?}/g)].map(([row]) => row);

    it("finds the options to check", () => {
        assert.ok(optionKeys().length >= 14, `only found ${optionKeys().length} option strings`);
        assert.ok(optionRows().length >= 9, `only found ${optionRows().length} option rows`);
    });

    it("has a string for its label and its description", () => {
        const missing = optionKeys().filter((key) => english[key] === undefined);

        assert.deepEqual(missing, [], "these option rows would render their own key");
    });

    it("names itself exactly one way", () => {
        const wrong = optionRows()
            .filter((row) => /\blabelKey:/.test(row) === /\blabel:/.test(row))
            .map((row) => row.slice(0, 60));

        assert.deepEqual(wrong, [],
            "a row needs either a labelKey to translate or a label that is the same everywhere");
    });

    it("names the section it sits in", () => {
        const sections = [...dialog.matchAll(/title=\{t\("([^"]+)"\)}/g)].map(([, key]) => key);

        assert.ok(sections.length >= 6, `only found ${sections.length} section headings`);
        assert.deepEqual(sections.filter((key) => english[key] === undefined), [],
            "these sections would render their own key as their heading");
    });
});

/**
 * The explanations behind the section icons, whose keys nothing else can see.
 *
 * PreferencesInfo builds them - `preferences.${section}.${choice}_desc` - so
 * i18nKeys.test.js, which scans for a literal t("…"), walks straight past every
 * one. That is the same shape as an integration naming an icon nothing
 * registered: a name assembled at runtime, with nothing checking that anything
 * answers to it. A missing key here renders as the key itself, inside the popup
 * that exists to explain the setting.
 *
 * Expanded from the source rather than listed, so a section added later is
 * covered by having been written.
 */
describe("every explanation the preferences dialog offers", () => {
    const english = flatten(readLocale("en"));
    const info = withoutJsComments(readSource("client/src/common/utils/PreferencesInfo.js"));

    // explains("theme", ["system", "dark", "light"]) becomes the eight keys it reads.
    const expanded = () => [...info.matchAll(/explains\("(\w+)",\s*\[([^\]]+)]\)/g)]
        .flatMap(([, section, choices]) => {
            const names = [...choices.matchAll(/"([^"]+)"/g)].map(([, name]) => name);

            return [`preferences.${section}.title`, `preferences.${section}.description`,
                ...names.flatMap((name) => [`preferences.${section}.${name}`, `preferences.${section}.${name}_desc`])];
        });

    it("finds the keys to check", () => {
        assert.ok(expanded().length >= 20, `only expanded ${expanded().length} keys`);
    });

    it("has a string behind every icon", () => {
        const missing = expanded().filter((key) => english[key] === undefined);

        assert.deepEqual(missing, [], "these would render their own key inside the explanation popup");
    });

    /**
     * The palette lines do not go through explains(): the names are constants
     * rather than keys, so only the sentence under each is translated. Read from
     * InvariantText, so a fifth palette needs a line before it can ship.
     */
    it("has a line for every palette", () => {
        const names = withoutJsComments(readSource("client/src/common/utils/InvariantText.js"));
        const block = names.slice(names.indexOf("export const PALETTE_NAMES = {"));
        const palettes = [...block.slice(0, block.indexOf("};")).matchAll(/(\w+):\s*"/g)].map(([, id]) => id);

        assert.ok(palettes.length >= 4, `only found ${palettes.length} palette names`);
        assert.deepEqual(palettes.filter((id) => english[`preferences.palette.${id}_desc`] === undefined), [],
            "these palettes would show their own key where their description belongs");
    });

    /** The chart resolution reuses the toolbar's own strings rather than adding any. */
    it("reuses the strings the chart toolbar already has", () => {
        for (const key of ["statistics.detail.title", "statistics.detail.description"])
            assert.notEqual(english[key], undefined, `${key} is gone, and the dialog still reads it`);
    });
});

/**
 * The lines those explanations are built of.
 *
 * PreferencesInfo joins the section sentence and one line per choice with
 * "\n", and the alert prints the result in a <p>. HTML collapses a newline to
 * a space, so without a rule saying otherwise the popup that exists to list
 * the choices ran them together into one paragraph - the description of Dark
 * flowing straight into the name of Light. The rule lives on the dialog's
 * description class, where every alert already renders; a description with no
 * newline in it cannot tell the difference.
 */
describe("the line breaks in those explanations", () => {
    it("are written into the text", () => {
        const info = withoutJsComments(readSource("client/src/common/utils/PreferencesInfo.js"));

        assert.match(info, /\.join\("\\n"\)/,
            "the explanations no longer join their lines with a newline, so this pairing guards nothing");
    });

    it("are preserved where the alert renders them", () => {
        const css = compile("common/contexts/Dialog/styles.sass");
        const at = css.indexOf(".dialog-description {");

        assert.notEqual(at, -1, "the alert's description class is gone from the dialog stylesheet");
        assert.match(css.slice(at, css.indexOf("}", at)), /white-space:\s*pre-line/,
            "without pre-line the popup collapses one-line-per-choice into a single run-on paragraph");
    });
});

/*
 * The verdict colours used to be checked here, against two hard-coded
 * selectors and two hard-coded surfaces. They are checked in
 * paletteContrast.test.js now, which finds the blocks in the compiled
 * stylesheet instead of naming them - every palette, both modes, every surface
 * a figure can land on, and the marks and the accent labels with them.
 *
 * The version that lived here could also measure nothing and pass: it filtered
 * to values starting with "#", so a grade that resolved to anything else was
 * skipped rather than failed. The replacement asserts that every colour it is
 * about to measure is one it can measure.
 */
