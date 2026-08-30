import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { localeCodes, readLocale, walkSources } from "../helpers/source.js";
import { flatten } from "../../scripts/localeGaps.js";

const read = (code) => flatten(readLocale(code));

const codes = localeCodes();
const english = read("en");

/**
 * The measurement units, which are the one kind of string a translator can
 * quietly destroy.
 *
 * InvariantText.js holds every string that reads the same in every language and
 * argues, at length, that the units are not among them: "ms" really is "мс" in
 * Russian and "毫秒" in Chinese, "Mbps" is "Mbit/s" across much of Europe, and
 * "MB/s" is "Mo/s" in French. They have to stay translatable.
 *
 * Which leaves them exposed, and upstream is the proof. On gnmyt/MySpeed's
 * development branch as this was written, `latest.jitter_unit` reads "M" in
 * German, "m" in Spanish and "Mms" in French - three languages where the
 * millisecond has been mangled into something that is not a unit at all, and in
 * all three the *ping* unit beside it still says "ms". Nothing failed. A parity
 * check cannot see it either: the value is present, non-empty, and different
 * from the English, which is exactly what a real translation looks like.
 *
 * So what is checked is the shape of the damage rather than the words. A real
 * translation of a unit either keeps the symbol or replaces it outright; what it
 * never does is truncate it, re-case it, or bolt something onto the front.
 */
describe("every unit MySpeed prints", () => {
    const UNIT_KEYS = Object.keys(english).filter((key) => /_unit$/.test(key));

    // Long enough for "Мбіт/с"; nothing that measures anything needs a sentence.
    const LONGEST_UNIT = 10;

    it("finds the units to check", () => {
        assert.ok(UNIT_KEYS.length >= 4, `only found ${UNIT_KEYS.length} unit keys`);
        assert.ok(codes.length > 10, `only found ${codes.length} locales`);
    });

    it("is a unit rather than a phrase", () => {
        const wrong = [];

        for (const code of codes) {
            const locale = read(code);

            for (const key of UNIT_KEYS) {
                const value = locale[key];

                if (typeof value !== "string" || value.trim() === "")
                    wrong.push(`[${code}] ${key} is empty`);
                else if (value !== value.trim())
                    wrong.push(`[${code}] ${key} = ${JSON.stringify(value)} has padding`);
                else if (value.length > LONGEST_UNIT)
                    wrong.push(`[${code}] ${key} = ${JSON.stringify(value)} is ${value.length} characters`);
            }
        }

        assert.deepEqual(wrong, []);
    });

    /**
     * The two latency units name the same quantity, so within one locale they
     * have to be the same word. This is what upstream's German fails: ping "ms"
     * beside jitter "M", in one file, measuring one thing two ways.
     */
    it("names the same quantity the same way", () => {
        const disagreeing = codes
            .map((code) => [code, read(code)])
            .filter(([, locale]) => locale["latest.ping_unit"] !== locale["latest.jitter_unit"])
            .map(([code, locale]) =>
                `[${code}] ping ${JSON.stringify(locale["latest.ping_unit"])} vs jitter ${JSON.stringify(locale["latest.jitter_unit"])}`);

        assert.deepEqual(disagreeing, [], "both are milliseconds, so both are the same word");
    });

    /**
     * A translation, or the symbol as it stands - not something in between.
     *
     * "мс", "毫秒", "Mo/s" and "Мбіт/с" are translations: they share no letters
     * with the English at all. "ms" unchanged is fine, because a symbol often is
     * international. What is never right is a value that is the English one
     * chewed - "m" is "ms" cut short, "M" is that plus a capital, "Mms" is "ms"
     * with something stuck on the front. Each of those is what a machine does to
     * a string it has mistaken for a word.
     */
    it("keeps the symbol or replaces it, and does not maul it", () => {
        const mauled = [];

        for (const code of codes.filter((name) => name !== "en")) {
            const locale = read(code);

            for (const key of UNIT_KEYS) {
                const source = english[key].toLowerCase();
                const value = String(locale[key]).toLowerCase();

                if (value === source) continue;

                // Shares the English spelling without being it: either cut down
                // from it, or built around it.
                if (source.startsWith(value) || value.includes(source))
                    mauled.push(`[${code}] ${key} = ${JSON.stringify(locale[key])} against ${JSON.stringify(english[key])}`);
            }
        }

        assert.deepEqual(mauled, [],
            "these read as the English unit damaged rather than as a translation of it");
    });
});

/**
 * The two units that arrive already inside brackets.
 *
 * `welcome.ms` and `welcome.mbps` are not "ms" and "Mbps" - they are "(in ms)"
 * and "(in Mbps)", a parenthetical the locale writes whole, because where the
 * bracket goes is part of the translation: Japanese writes （ms 単位）with
 * full-width brackets and the unit before the word, Turkish writes
 * "(ms cinsinden)" with it after.
 *
 * So a component that renders one has nothing to add. The target editor added
 * a pair of its own - `({unit})` around a value that opens and closes itself -
 * and every optimal value in the dialog was labelled "Ping ((in ms))", in all
 * twenty-three languages, including the two that would have been doubled with
 * mismatched bracket widths.
 */
describe("the units that come already bracketed", () => {
    const BRACKETED = ["welcome.ms", "welcome.mbps"];

    // The ASCII pair and the CJK full-width pair, which is what ja and zh-tw use.
    const OPENS = /^\s*[(（]/;
    const CLOSES = /[)）]\s*$/;

    it("is how every locale writes them", () => {
        const bare = [];

        for (const code of codes) {
            const locale = read(code);

            for (const key of BRACKETED) {
                const value = String(locale[key]);
                if (!OPENS.test(value) || !CLOSES.test(value))
                    bare.push(`[${code}] ${key} = ${JSON.stringify(value)}`);
            }
        }

        assert.deepEqual(bare, [],
            "these carry no brackets of their own, so whatever renders them has to supply a pair");
    });

    /**
     * Read off the JSX rather than off a render: what went wrong is a literal
     * pair of parentheses in the markup, and that is visible in the source.
     */
    it("so nothing wraps them in a second pair", () => {
        const doubled = walkSources("client/src")
            .filter(({source}) => /className="[^"]*unit[^"]*"\s*>\s*\(\s*\{/.test(source))
            .map(({path}) => path);

        assert.deepEqual(doubled, [],
            "these print a bracket around a unit that already opens and closes itself");
    });
});
