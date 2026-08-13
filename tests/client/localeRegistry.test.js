import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(fileURLToPath(import.meta.url), "..", "..", "..");
const LOCALES = path.join(ROOT, "client", "public", "assets", "locales");
const FLAGS = path.join(ROOT, "client", "src", "common", "assets", "languages");

const source = fs.readFileSync(path.join(ROOT, "client", "src", "i18n.js"), "utf8");

/**
 * The language menu and the files behind it.
 *
 * A language is three things that have to agree: an entry in the list i18n.js
 * exports, a locale file the http backend fetches by code at runtime, and a
 * flag imported at build time. Nothing checked that they did. A registered
 * language with no locale file is not a build error - the backend simply 404s
 * on the fetch, and the interface silently falls back to English with the menu
 * still offering the language.
 *
 * Read from the source rather than imported: i18n.js imports webp assets, which
 * only vite can resolve.
 */
const registered = [...source.matchAll(/\{name:\s*'([^']+)',\s*code:\s*'([a-z-]+)',\s*flag:\s*(\w+)}/g)]
    .map(([, name, code, flag]) => ({name, code, flag}));

const flagImports = Object.fromEntries(
    [...source.matchAll(/import\s+(\w+)\s+from\s+"@\/common\/assets\/languages\/([\w-]+)\.webp"/g)]
        .map(([, binding, file]) => [binding, file])
);

describe("the language registry", () => {
    it("finds the registered languages to check", () => {
        assert.ok(registered.length > 10, `only parsed ${registered.length} languages out of i18n.js`);
    });

    it("has a locale file for every language it offers", () => {
        const missing = registered
            .filter(({code}) => !fs.existsSync(path.join(LOCALES, `${code}.json`)))
            .map(({name, code}) => `${name} (${code}.json)`);

        assert.deepEqual(missing, [], "offered in the menu but the backend has nothing to fetch");
    });

    it("has a flag for every language it offers", () => {
        const missing = registered
            .filter(({flag}) => !flagImports[flag] || !fs.existsSync(path.join(FLAGS, `${flagImports[flag]}.webp`)))
            .map(({name, flag}) => `${name} (${flag})`);

        assert.deepEqual(missing, [], "the menu entry has no flag to draw");
    });

    it("parses every locale file it offers", () => {
        for (const {code} of registered)
            assert.doesNotThrow(() => JSON.parse(fs.readFileSync(path.join(LOCALES, `${code}.json`), "utf8")),
                `${code}.json is not valid JSON`);
    });

    // Requested upstream as gnmyt/MySpeed#962, with a finished translation
    // attached to the issue.
    it("offers Ukrainian", () => {
        const ukrainian = registered.find(({code}) => code === "uk");

        assert.ok(ukrainian, "Ukrainian is not in the language list");
        assert.equal(ukrainian.name, "Українська", "the menu names each language in its own language");
    });
});

/**
 * A locale carries no key that English has since dropped.
 *
 * A translation contributed against an older version brings the interface of
 * that version with it. Those keys are read by nothing, and if one is ever
 * reintroduced for a different purpose the stale translation becomes a wrong
 * one that no longer looks stale.
 *
 * Only the direction that can go wrong is checked. A key English has and a
 * locale does not is the ordinary state of every translation between one
 * release and the next, and falls back to English.
 */
describe("locale files", () => {
    const flatten = (object, prefix = "") => Object.entries(object).flatMap(([key, value]) => {
        const full = prefix ? `${prefix}.${key}` : key;
        return value && typeof value === "object" ? flatten(value, full) : [full];
    });

    const read = (code) => JSON.parse(fs.readFileSync(path.join(LOCALES, `${code}.json`), "utf8"));
    const english = new Set(flatten(read("en")));

    // Only the locales this build offers. The directory also holds files for
    // languages the menu does not list, which Crowdin keeps up to date on its
    // own schedule.
    for (const {name, code} of registered.filter(({code}) => code !== "en")) {
        it(`${name} carries no key English has dropped`, () => {
            const stale = flatten(read(code)).filter((key) => !english.has(key));

            assert.deepEqual(stale, [], `${code}.json translates keys that no longer exist`);
        });
    }
});

/**
 * The two optimal-speed labels are not swapped.
 *
 * uk.json had dropdown.upload reading "Оптимальна швидкість завантаження" and
 * dropdown.download reading "Оптимальна швидкість вивантаження", the wrong way
 * round: everywhere else the same file uses завантаження for downloading and
 * вивантаження for uploading. No component reads the two keys today, so the
 * mistake was armed rather than visible, and the stale-key check above cannot
 * see it because English still carries both keys.
 *
 * The words to look for come out of the same file, from latest.down and
 * latest.up, so a retranslation that changes the vocabulary retires the check
 * instead of failing it. Only the presence of the opposite direction's word
 * fails - a rewording in different terms passes.
 */
describe("the Ukrainian optimal-speed labels", () => {
    const uk = JSON.parse(fs.readFileSync(path.join(LOCALES, "uk.json"), "utf8"));

    const downwards = uk.latest.down.toLowerCase();
    const upwards = uk.latest.up.toLowerCase();

    it("names the two directions with words that tell them apart", () => {
        assert.ok(!downwards.includes(upwards) && !upwards.includes(downwards),
            `"${uk.latest.down}" and "${uk.latest.up}" cannot be told apart by containment`);
    });

    it("does not describe the optimal down-speed as uploading", () => {
        assert.ok(!uk.dropdown.download.toLowerCase().includes(upwards),
            `dropdown.download reads "${uk.dropdown.download}", which is the word for ${uk.latest.up}`);
    });

    it("does not describe the optimal up-speed as downloading", () => {
        assert.ok(!uk.dropdown.upload.toLowerCase().includes(downwards),
            `dropdown.upload reads "${uk.dropdown.upload}", which is the word for ${uk.latest.down}`);
    });
});
