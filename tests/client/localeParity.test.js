import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { flatten, localeGaps, LANGUAGE_SHARED, sharedKeys } from "../../scripts/localeGaps.js";

const ROOT = path.resolve(fileURLToPath(import.meta.url), "..", "..", "..");
const LOCALES = path.join(ROOT, "client", "public", "assets", "locales");
const SOURCE = "en";

const read = (code) => JSON.parse(fs.readFileSync(path.join(LOCALES, `${code}.json`), "utf8"));

const codes = fs.readdirSync(LOCALES)
    .filter((file) => file.endsWith(".json"))
    .map((file) => path.basename(file, ".json"))
    .filter((code) => code !== SOURCE)
    .sort();

const english = read(SOURCE);
const source = flatten(english);

/**
 * Every locale carries every string, in its own language.
 *
 * This used to hold German alone. German ships with the feature and the rest
 * followed through upstream's Crowdin project, so asserting the same of them
 * would have failed on every string until translators had been round - a normal
 * state for them to be in rather than a broken build, and the reason the check
 * was written narrow.
 *
 * They have now been round. Every locale is complete, so the floor can be the
 * same for all of them, and the interesting question stops being "how far
 * behind is this language" and becomes "did the string somebody just added get
 * translated". A new key in en.json fails here in fourteen languages at once,
 * which is the point: the alternative is what this replaced, where four German
 * strings went missing for a release and a German instance rendered "All time"
 * in its date picker beside German dates.
 *
 * The allowance for a value that is legitimately the English word lives in
 * scripts/localeGaps.js beside the report that uses it, rather than here, so
 * that the test and the tool cannot disagree about what counts as translated.
 */
describe("the locale files", () => {
    it("finds the locales to check", () => {
        assert.ok(codes.length > 10, `only found ${codes.length} locale files`);
        assert.ok(Object.keys(source).length > 500, "en.json did not read as the source");
    });

    /**
     * "named@@0" is what a translation pipeline writes where a string's ICU
     * placeholder metadata leaked into the value - it is machinery, not a word
     * in any language, and it renders exactly as written. Dutch shipped it as
     * the label of the preferences menu item, and the parity checks above are
     * blind to it: the value is present, non-empty, and different from the
     * English, which is what a real translation looks like. The artifact has a
     * shape the words never have, so the shape is what is checked - in every
     * file including English, since the pipeline touches them all.
     */
    it("carries no machine-translation artifact in any value", () => {
        const leaked = [SOURCE, ...codes].flatMap((code) =>
            Object.entries(flatten(read(code)))
                .filter(([, value]) => /@@/.test(String(value)))
                .map(([key, value]) => `[${code}] ${key} = ${JSON.stringify(value)}`));

        assert.deepEqual(leaked, [], "these values are pipeline metadata, rendered verbatim to the reader");
    });

    /**
     * The notification phrases carry no markdown and no line breaks.
     *
     * These are the only strings in the files that the server composes into a
     * message rather than the interface rendering into a DOM node, and two of
     * the sinks parse what they are handed as markdown. Telegram's legacy
     * parser has no escape syntax and answers a 400 for formatting that does
     * not balance - it delivers nothing at all - and Discord renders masked
     * links inside an embed description. util/markdown.js cleans the values
     * that are interpolated *into* a template and deliberately leaves the
     * template alone, because the operator's own formatting is theirs; the
     * words a phrase supplies land inside the template, between the
     * delimiters the shipped default puts there - `*${word("finished")}*` -
     * so an asterisk or a backtick from a translator closes a pair early and
     * takes the message down for a language nobody tested in.
     *
     * A carriage return or a newline is here for the plainer reason: the
     * templates lay the phrases out themselves, and ntfy carries its title in
     * a header, where a line break is also how a request smuggles a second
     * header in.
     *
     * The per cent sign is not in the list, though the templates' own
     * %variables% are written with it: `shortfall` legitimately spells a
     * percentage in every language, and it is safe there because
     * replaceVariables never re-reads what it substituted - a phrase is put
     * into the message, not into the template.
     *
     * Every locale is clean today, English included. This is the guard that
     * keeps the next translation from being the one that is never delivered.
     */
    it("keeps the notification phrases free of markup in every language", () => {
        const FORMATTING = /[`*_[\]~|\\\r\n]/;

        const marked = [SOURCE, ...codes].flatMap((code) =>
            Object.entries(read(code).notification ?? {})
                .filter(([, value]) => FORMATTING.test(String(value)))
                .map(([key, value]) => `[${code}] notification.${key} = ${JSON.stringify(value)}`));

        assert.deepEqual(marked, [],
            "these land between a template's own markdown delimiters, and an unbalanced message is not delivered");
    });

    /**
     * The one family a locale is allowed to disagree with English about.
     *
     * `time.<unit>_ago` is the i18next context spanInWords wears behind the
     * word "ago" (FormatUtil.js), and which units need one is a fact about the
     * language rather than about the interface: German inflects the day and
     * nothing else, Polish and Czech inflect every unit after "przed"/"před",
     * and the seventeen languages that inflect nothing need none at all.
     *
     * Held out of both directions on purpose. Counting a missing one as a gap
     * would have every locale carry a copy of its own base key to say "this
     * language does not inflect here" - and counting an extra one as a leftover
     * would forbid Polish the six keys its grammar actually needs. What the
     * reader gets when a key is absent is the base form, which is the right
     * answer for the languages that do not inflect.
     */
    const AGO_INFLECTION = /^time\.[a-z]+_ago$/;

    const withoutAgoInflection = (keys) => keys.filter((key) => !AGO_INFLECTION.test(key));

    for (const code of codes) {
        describe(`${code}.json`, () => {
            const locale = read(code);
            const gaps = localeGaps(english, locale, sharedKeys(code));

            it("translates every English key", () => {
                const missing = withoutAgoInflection(gaps.missing);

                assert.deepEqual(missing, [],
                    `${missing.length} key(s) absent or empty; a ${code} instance renders these in English`);
            });

            it("carries no key English does not have", () => {
                assert.deepEqual(withoutAgoInflection(gaps.extra), [],
                    "these outlived the English they were translated from");
            });

            /**
             * A value that is present and still the English text. Indistinguish-
             * able from a missing key to a reader, and invisible to a key count -
             * three locales were carrying about a hundred and sixty each.
             */
            it("leaves no value as the untranslated English text", () => {
                assert.deepEqual(gaps.untranslated, [],
                    `translate these, or add them to LANGUAGE_SHARED.${code} if ${code} really uses the English word`);
            });

            /**
             * The allowance list has to stay a record of live decisions. Without
             * this, a key that somebody later did translate sits on it forever,
             * and the next reader cannot tell which entries still mean anything.
             */
            it("still needs every allowance it is granted", () => {
                const target = flatten(locale);
                const stale = (LANGUAGE_SHARED[code] ?? []).filter((key) => target[key] !== source[key]);

                assert.deepEqual(stale, [],
                    `these are translated now, so remove them from LANGUAGE_SHARED.${code}`);
            });

            /**
             * i18next fills {{name}} from the values the component passes. A
             * translation that drops one silently renders a sentence with the
             * number missing - "Average latency, between and" - and a
             * translation that invents one renders the braces literally.
             */
            it("keeps the interpolations English declares", () => {
                const target = flatten(locale);
                const names = (value) => [...String(value).matchAll(/\{\{(\w+)}}/g)].map(([, name]) => name).sort();

                const broken = Object.keys(source)
                    .filter((key) => key in target)
                    .filter((key) => names(source[key]).join() !== names(target[key]).join())
                    .map((key) => `${key}: expected ${names(source[key]).join()||"none"}, got ${names(target[key]).join()||"none"}`);

                assert.deepEqual(broken, [], "the placeholders do not match English");
            });

            /**
             * <Trans> matches these tags to real React children by name. One that
             * English has and the translation does not takes its content with it:
             * the Ookla notice loses the link to the EULA, and the delete prompt
             * loses the date it is asking about.
             */
            it("keeps the component tags English declares", () => {
                const target = flatten(locale);
                const tags = (value) => [...String(value).matchAll(/<(\/?\w+)\/?>/g)].map(([, tag]) => tag).sort();

                const broken = Object.keys(source)
                    .filter((key) => key in target && tags(source[key]).length)
                    .filter((key) => tags(source[key]).join() !== tags(target[key]).join())
                    .map((key) => `${key}: expected ${tags(source[key]).join()}, got ${tags(target[key]).join()||"none"}`);

                assert.deepEqual(broken, [], "the <Trans> tags do not match English");
            });
        });
    }

    /**
     * An allowance for a language that no longer ships is dead weight, and one
     * for a language that does not exist is a typo that silently waves nothing
     * through.
     */
    it("grants allowances only to locales that ship", () => {
        const unknown = Object.keys(LANGUAGE_SHARED).filter((code) => !codes.includes(code));

        assert.deepEqual(unknown, [], "LANGUAGE_SHARED names locales with no file");
    });
});
