import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
    flatten, localeGaps, mergeLocale, nest, serialise, sharedKeys, UNIVERSAL_SHARED
} from "../../scripts/localeGaps.js";

const ROOT = path.resolve(fileURLToPath(import.meta.url), "..", "..", "..");
const LOCALES = path.join(ROOT, "client", "public", "assets", "locales");

const read = (code) => JSON.parse(fs.readFileSync(path.join(LOCALES, `${code}.json`), "utf8"));

/**
 * A locale file is edited by writing one back out, so the writer has to agree
 * with the format the files are already in - to the byte. It does not, quite
 * reasonably, get to decide that format: a locale carrying a hundred added
 * strings and nine hundred re-indented ones is unreviewable, and the review is
 * the only thing standing between a translation and the users who cannot read
 * the source language to check it.
 *
 * Hence the round-trip test below over the real files, rather than a fixture:
 * the assertion that matters is about these files, and a fixture would only
 * prove the writer agrees with itself.
 */
describe("flatten and nest", () => {
    const nested = {a: {b: "one", c: {d: "two"}}, e: "three"};

    it("turns nested locale JSON into dotted keys", () => {
        assert.deepEqual(flatten(nested), {"a.b": "one", "a.c.d": "two", e: "three"});
    });

    it("puts it back together again", () => {
        assert.deepEqual(nest(flatten(nested)), nested);
    });

    it("keeps the order it is given", () => {
        assert.deepEqual(Object.keys(nest({"z.b": "1", "z.a": "2", "y": "3"})), ["z", "y"]);
        assert.deepEqual(Object.keys(nest({"z.b": "1", "z.a": "2"}).z), ["b", "a"]);
    });

    it("round-trips every locale that ships", () => {
        for (const code of fs.readdirSync(LOCALES).map((file) => path.basename(file, ".json")))
            assert.deepEqual(nest(flatten(read(code))), read(code), `${code}.json did not survive the round trip`);
    });
});

describe("serialise", () => {
    it("writes two-space JSON with a trailing newline", () => {
        assert.equal(serialise({a: {b: "c"}}), '{\n  "a": {\n    "b": "c"\n  }\n}\n');
    });

    it("writes the line ending it is asked for", () => {
        assert.equal(serialise({a: "b"}, "\r\n"), '{\r\n  "a": "b"\r\n}\r\n');
    });

    /**
     * The locales are full of text no ASCII escape would survive being read by
     * a translator. JSON.stringify leaves it alone; a hand-rolled escaper would
     * not, and the files would turn into \u sequences on their first edit.
     */
    it("leaves non-ascii text as itself", () => {
        assert.equal(serialise({a: "Échec 中文"}), '{\n  "a": "Échec 中文"\n}\n');
    });

    it("reproduces every locale file that ships, byte for byte", () => {
        for (const file of fs.readdirSync(LOCALES)) {
            const raw = fs.readFileSync(path.join(LOCALES, file), "utf8");
            const eol = raw.includes("\r\n") ? "\r\n" : "\n";

            assert.equal(serialise(JSON.parse(raw), eol), raw, `writing ${file} back out would change it`);
        }
    });
});

describe("localeGaps", () => {
    const english = {a: "One", b: "Two", c: "Mbps"};

    it("reports the keys the locale does not have", () => {
        assert.deepEqual(localeGaps(english, {a: "Eins"}).missing, ["b", "c"]);
    });

    it("reports the keys the locale has and English does not", () => {
        assert.deepEqual(localeGaps(english, {a: "Eins", z: "Drei"}).extra, ["z"]);
    });

    it("reports a value still holding the English text", () => {
        assert.deepEqual(localeGaps(english, {a: "One", b: "Zwei", c: "Mbps"}).untranslated, ["a", "c"]);
    });

    it("does not report one the language is allowed to share", () => {
        const gaps = localeGaps(english, {a: "One", b: "Zwei", c: "Mbps"}, new Set(["c"]));

        assert.deepEqual(gaps.untranslated, ["a"]);
    });

    /**
     * An empty string is a key the file claims to have and does not: i18next
     * finds it, stops looking, and renders nothing where a label belongs.
     * Counted as missing rather than as its own category, because the answer to
     * both is the same - somebody has to write the string.
     */
    it("counts an empty value as missing rather than as translated", () => {
        assert.deepEqual(localeGaps(english, {a: "", b: "Zwei", c: "Mbps"}).missing, ["a"]);
    });
});

describe("mergeLocale", () => {
    const english = {greeting: {hello: "Hello", bye: "Bye"}, unit: "ms"};
    const locale = {greeting: {bye: "Tschüss"}};

    it("adds the patch and keeps what was already translated", () => {
        const merged = mergeLocale(english, locale, {"greeting.hello": "Hallo", unit: "ms"});

        assert.deepEqual(merged, {greeting: {hello: "Hallo", bye: "Tschüss"}, unit: "ms"});
    });

    /**
     * Pure insertions, which is the whole point: every Crowdin-managed locale is
     * already in English's order, so following it means the diff of a
     * translation pass is the lines it added and nothing else.
     */
    it("puts the result in English's key order", () => {
        const merged = mergeLocale(english, locale, {"greeting.hello": "Hallo"});

        assert.deepEqual(Object.keys(merged.greeting), ["hello", "bye"]);
    });

    it("leaves a key neither side has out, rather than inventing an empty one", () => {
        assert.deepEqual(mergeLocale(english, locale, {}), {greeting: {bye: "Tschüss"}});
    });

    /**
     * A mistyped key in a patch is otherwise silent: it lands in the file, no
     * component ever asks for it, and the string it was meant to translate is
     * still missing. Refusing here is the only place it shows.
     */
    it("refuses a patch key English does not have", () => {
        assert.throws(() => mergeLocale(english, locale, {"greeting.helo": "Hallo"}), /greeting\.helo/);
    });

    it("drops a key English no longer has", () => {
        assert.deepEqual(mergeLocale(english, {retired: "Alt", unit: "ms"}, {}), {unit: "ms"});
    });
});

describe("the shared-value registry", () => {
    const english = flatten(read("en"));

    it("names only keys English actually has", () => {
        const unknown = UNIVERSAL_SHARED.filter((key) => !(key in english));

        assert.deepEqual(unknown, [], "the universal list names keys that are not in en.json");
    });

    it("gives a language its own allowances on top of the universal ones", () => {
        for (const key of UNIVERSAL_SHARED) assert.ok(sharedKeys("de").has(key), `${key} is not shared for German`);
    });

    /**
     * The registry says "this value is the same in the target language", so a
     * key on it that carries a whole translatable sentence is a mistake rather
     * than a shortcut.
     */
    it("waves through nothing longer than a label", () => {
        const wordy = UNIVERSAL_SHARED
            .filter((key) => String(english[key]).split(/\s+/).filter(Boolean).length > 4);

        assert.deepEqual(wordy, [], "these are sentences, not brand names - they need translating");
    });

    /**
     * The near miss this list invites. Units read as untranslatable and are not:
     * "ms" is "мс" in Russian and "毫秒" in Chinese, "Mbps" is "Mbit/s" across
     * much of Europe, "MB/s" is "Mo/s" in French - and the notification
     * templates carry those same units in among their %variables%. Waving any of
     * them through here would mean the parity test never asks a new language for
     * them, and a Ukrainian instance would read "%download% Mbps".
     */
    it("does not wave through the units, or the templates that carry them", () => {
        const unitBearing = Object.keys(english).filter((key) =>
            /_unit$|_message_placeholder$/.test(key) || key === "nodes.placeholder.url");

        assert.ok(unitBearing.length > 10, "the unit-bearing keys could not be found to check");
        assert.deepEqual(unitBearing.filter((key) => UNIVERSAL_SHARED.includes(key)), [],
            "these vary by language and must stay translatable");
    });
});
