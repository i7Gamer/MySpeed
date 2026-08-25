import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readSource, withoutJsComments } from "../helpers/source.js";

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
        const missing = optionKeys().filter((key) => valueAt(english, key) === undefined);

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
        const sections = [...dialog.matchAll(/title=\{t\("([^"]+)"\)}\s*\n\s*description=\{t\("([^"]+)"\)}/g)]
            .flatMap(([, title, description]) => [title, description]);

        assert.ok(sections.length >= 8, `only found ${sections.length} section strings`);
        assert.deepEqual(sections.filter((key) => valueAt(english, key) === undefined), []);
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
