import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readSource, withoutJsComments } from "../helpers/source.js";
import { compile } from "../helpers/sass.mjs";

const ROOT = path.resolve(fileURLToPath(import.meta.url), "..", "..", "..");
const LOCALES = path.join(ROOT, "client", "public", "assets", "locales");

const readLocale = (code) => JSON.parse(fs.readFileSync(path.join(LOCALES, `${code}.json`), "utf8"));
const valueAt = (object, key) => key.split(".").reduce((node, part) => node?.[part], object);

const dialog = withoutJsComments(readSource("client/src/common/components/PreferencesDialog/PreferencesDialog.jsx"));
const context = withoutJsComments(readSource("client/src/common/contexts/Preferences/PreferencesContext.jsx"));

const clientSources = (dir) => fs.readdirSync(dir, {withFileTypes: true}).flatMap((entry) => {
    const full = path.join(dir, entry.name);

    if (entry.isDirectory()) return clientSources(full);
    return /\.jsx?$/.test(entry.name) ? [fs.readFileSync(full, "utf8")] : [];
});

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
        const calls = clientSources(path.join(ROOT, "client", "src"))
            .flatMap((source) => [...source.matchAll(/updatePreferences\(\{([\s\S]{0,200}?)\}\)/g)])
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
    const english = readLocale("en");

    const optionKeys = () => [...dialog.matchAll(/labelKey:\s*"([^"]+)",\s*descKey:\s*"([^"]+)"/g)]
        .flatMap(([, label, desc]) => [label, desc]);

    it("finds the options to check", () => {
        assert.ok(optionKeys().length >= 14, `only found ${optionKeys().length} option strings`);
    });

    it("has a string for its label and its description", () => {
        const missing = optionKeys().filter((key) => valueAt(english, key) === undefined);

        assert.deepEqual(missing, [], "these option rows would render their own key");
    });

    it("names the section it sits in", () => {
        const sections = [...dialog.matchAll(/title=\{t\("([^"]+)"\)}\s*\n\s*description=\{t\("([^"]+)"\)}/g)]
            .flatMap(([, title, description]) => [title, description]);

        assert.ok(sections.length >= 8, `only found ${sections.length} section strings`);
        assert.deepEqual(sections.filter((key) => valueAt(english, key) === undefined), []);
    });
});

/**
 * The verdict colours are rendered as text, so they answer to text contrast.
 *
 * They never were. All five accents were chosen against a near-black background
 * and light mode inherited them unchanged - so a grade printed in the old green
 * measured 2.42:1 on #f8fafc, under even the 3:1 floor for large text, and the
 * figure carrying the verdict was the least readable thing on the page.
 *
 * Computed from the stylesheet rather than from a list here, so a palette added
 * later is held to the same bar without anybody remembering to add it.
 */
describe("the grade colours", () => {
    const css = compile("common/styles/default.sass");

    const luminance = (hex) => {
        const channel = (value) => {
            const v = value / 255;
            return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
        };
        const [r, g, b] = [1, 3, 5].map((i) => channel(parseInt(hex.slice(i, i + 2), 16)));

        return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };

    const contrast = (a, b) => {
        const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x);
        return (high + 0.05) / (low + 0.05);
    };

    /** Every custom property a selector's blocks declare, across the sheet. */
    const declaredIn = (selector) => {
        const found = {};
        let at = css.indexOf(selector);

        assert.notEqual(at, -1, `${selector} is not in the compiled stylesheet`);

        // Several blocks share the selector - _colors.sass writes one and
        // _grade-palette.sass another - and the later one wins, so they are read
        // in source order and allowed to overwrite.
        while (at !== -1) {
            const block = css.slice(at, css.indexOf("}", at));

            for (const [, name, value] of block.matchAll(/--([\w-]+):\s*([^;]+);/g)) found[name] = value.trim();
            at = css.indexOf(selector, at + 1);
        }

        return found;
    };

    /**
     * A grade's actual colour. Most point at an accent through var(), and light
     * mode overrides only some of them - so an unresolved name falls back to
     * what :root declared, exactly as the cascade would.
     */
    const resolve = (name, block, root) => {
        const value = block[name] ?? root[name];
        if (!value) return null;

        const reference = value.match(/^var\(--([\w-]+)\)$/);
        return reference ? resolve(reference[1], block, root) : value;
    };

    // The grades, not the accents. These are what carries a verdict, and
    // _grades.sass renders them with `color` - the accents they are often drawn
    // from are also button backgrounds, which answer to a different bar.
    const READ_AS_TEXT = ["grade-good", "grade-fair", "grade-poor", "grade-none", "grade-failed"];
    const TEXT_CONTRAST = 4.5;

    const root = declaredIn(":root");

    it("finds both themes in the stylesheet", () => {
        assert.ok(READ_AS_TEXT.every((name) => resolve(name, root, root)?.startsWith("#")),
            "the dark grade colours could not be resolved to hex");
        assert.ok(Object.keys(declaredIn("[data-theme=light]")).length >= 4,
            "light mode declares nothing of its own, so it inherits colours picked for a dark page");
    });

    for (const [theme, selector, surface] of [
        ["dark", ":root", "#0f1419"],
        ["dark card", ":root", "#1a2029"],
        ["light", "[data-theme=light]", "#f8fafc"],
        ["light card", "[data-theme=light]", "#ffffff"]
    ]) {
        it(`are readable on the ${theme} surface`, () => {
            const block = declaredIn(selector);

            const failing = READ_AS_TEXT
                .map((name) => [name, resolve(name, block, root)])
                .filter(([, value]) => value?.startsWith("#"))
                .map(([name, value]) => [name, contrast(value, surface)])
                .filter(([, ratio]) => ratio < TEXT_CONTRAST)
                .map(([name, ratio]) => `${name} ${ratio.toFixed(2)}:1`);

            assert.deepEqual(failing, [], `below ${TEXT_CONTRAST}:1 against ${surface}`);
        });
    }
});
