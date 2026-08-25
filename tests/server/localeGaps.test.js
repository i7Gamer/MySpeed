import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
    flatten, LANGUAGE_SHARED, localeGaps, mergeLocale, nest, serialise, sharedKeys
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

/**
 * There was a second half to this registry once: a UNIVERSAL_SHARED list, for
 * values identical in every language at the same time.
 *
 * It is gone, and so are the keys it named. A value that no language can
 * translate has no business being offered to a translator - several were duly
 * translated, and a parity check cannot catch that, because a wrong translation
 * looks exactly like a right one. They are constants now; see
 * client/src/common/utils/InvariantText.js.
 *
 * What remains is per-language, which is the only kind of allowance that means
 * anything: French really does write "ms" and "Mbps", and Russian really does
 * not.
 */
describe("the shared-value registry", () => {
    const english = flatten(read("en"));
    const every = Object.entries(LANGUAGE_SHARED);

    it("finds allowances to check", () => {
        assert.ok(every.length > 10, `only ${every.length} languages carry a list`);
    });

    it("names only keys English actually has", () => {
        const unknown = every.flatMap(([code, keys]) =>
            keys.filter((key) => !(key in english)).map((key) => `${code}: ${key}`));

        assert.deepEqual(unknown, [], "these allowances name keys that are not in en.json");
    });

    it("hands a language its own list and nothing else", () => {
        assert.deepEqual([...sharedKeys("de")], LANGUAGE_SHARED.de);
        assert.deepEqual([...sharedKeys("nonexistent")], []);
    });

    /**
     * An allowance says "this value is the same word in the target language", so
     * one carrying a whole translatable sentence is a mistake rather than a
     * shortcut. The notification templates are the exception: they are long, and
     * every word in them is a %variable% or a unit.
     */
    it("waves through nothing longer than a label", () => {
        const wordy = every.flatMap(([code, keys]) => keys
            .filter((key) => !/_message_placeholder$/.test(key))
            .filter((key) => String(english[key]).split(/\s+/).filter(Boolean).length > 4)
            .map((key) => `${code}: ${key}`));

        assert.deepEqual(wordy, [], "these are sentences, not words - they need translating");
    });

    /**
     * The near miss the old universal list invited, kept as a check on the
     * per-language ones. A unit may be shared by the languages that use the
     * English symbol, but never by all of them at once: "ms" is "мс" in Russian
     * and "毫秒" in Chinese, "Mbps" is "Mbit/s" across much of Europe. An entry
     * every language carries is a key that should not have been translatable.
     */
    it("shares no value across every single language", () => {
        const codes = every.map(([code]) => code);
        const counted = new Map();

        for (const [, keys] of every) for (const key of keys) counted.set(key, (counted.get(key) ?? 0) + 1);

        const universal = [...counted].filter(([, count]) => count === codes.length).map(([key]) => key);

        assert.deepEqual(universal, [],
            "no language translates these, so they belong in InvariantText.js rather than the locales");
    });
});
