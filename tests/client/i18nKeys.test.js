import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const LOCALES_DIR = "client/public/assets/locales";
const SOURCE_DIR = "client/src";
const SOURCE_LOCALE = "en";

const readLocale = (code) =>
    JSON.parse(fs.readFileSync(path.join(LOCALES_DIR, `${code}.json`), "utf8"));

const flatten = (object, prefix = "") => Object.entries(object).flatMap(([key, value]) => {
    const full = prefix ? `${prefix}.${key}` : key;
    return value && typeof value === "object" ? flatten(value, full) : [full];
});

const sourceFiles = (dir) => fs.readdirSync(dir, {withFileTypes: true}).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return /\.jsx?$/.test(entry.name) ? [full] : [];
});

const english = readLocale(SOURCE_LOCALE);
const knownKeys = new Set(flatten(english));

const sources = sourceFiles(SOURCE_DIR).map((file) => ({file, code: fs.readFileSync(file, "utf8")}));

// Only literal keys can be checked; t(`a.${b}`) and t("a." + b) are resolved at
// runtime and are deliberately skipped.
const collectReferences = () => {
    const references = [];

    for (const {file, code} of sources) {
        // The trailing [,)] matters: it excludes the prefix half of a
        // concatenated key such as t("dropdown." + name), which is dynamic.
        for (const match of code.matchAll(/\bt\(\s*"([a-z][a-zA-Z0-9_.]*[a-zA-Z0-9_])"\s*[,)]/g))
            references.push({file, key: match[1]});

        // <Trans …>some.key</Trans>
        for (const match of code.matchAll(/>\s*([a-z][a-zA-Z0-9_]*(?:\.[a-zA-Z0-9_]+)+)\s*<\/Trans>/g))
            references.push({file, key: match[1]});
    }

    return references;
};

describe("i18n keys", () => {
    it("finds literal key references to check", () => {
        assert.ok(collectReferences().length > 50, "expected the scanner to find references");
    });

    it("has every literally referenced key defined in the source locale", () => {
        const missing = collectReferences()
            .filter(({key}) => !knownKeys.has(key))
            .map(({file, key}) => `${key}  (${file.replace(/\\/g, "/")})`);

        assert.deepEqual(missing, [], `keys referenced in code but absent from ${SOURCE_LOCALE}.json`);
    });

    describe("keys added for previously unrendered features", () => {
        const required = [
            "dialog.provider.ookla_desc",
            "dialog.provider.libre_desc",
            "dialog.provider.cloudflare_desc",
            "calendar.select_start",
            "calendar.select_end",
            "calendar.last_7_days",
            "calendar.last_30_days",
            "calendar.last_90_days",
            "calendar.last_year",
            "info.recommendations_info",
            "info.recommendations_error",
            "test.details.server",
            "statistics.downsampled",
            // Built as `test.details.${direction}_target`, so the literal-key
            // scanner above cannot see them.
            "test.details.over_target",
            "test.details.under_target",
            "test.details.on_target",
            // Chosen by a ternary inside t(), which the scanner cannot read
            // either.
            "test.details.hide",
            "test.details.show",
            "storage.export_redacted_desc",
            "storage.export_with_secrets_desc",
            // Returned by passwordConfirmationProblem and rendered as
            // `t(mismatch)`, so the scanner sees a variable rather than a key.
            // Dropping it from the locales printed the key itself, in red,
            // under the confirmation box - in every language, since the en/de
            // parity check cannot see a key that is missing from both.
            "update.password_mismatch"
        ];

        for (const key of required) {
            it(`defines ${key} in every locale or leaves it to the english fallback`, () => {
                assert.ok(knownKeys.has(key), `${key} must exist in ${SOURCE_LOCALE}.json`);
            });
        }

        it("keeps the interpolation placeholders of the new strings intact", () => {
            assert.match(english.statistics.downsampled, /\{\{shown\}\}/);
            assert.match(english.statistics.downsampled, /\{\{total\}\}/);
        });

        /*
         * The test.result.* family - description, jitter, server - and
         * test.average.description were the speedtest result dialog, which the
         * inline detail view replaced. Nothing renders them any more, so they
         * are deliberately not pinned here: asserting on a dead string's
         * placeholders reads like a live contract. The keys themselves still
         * sit in every locale file, which is Crowdin's to clean up.
         */
    });

    describe("locale files", () => {
        const locales = fs.readdirSync(LOCALES_DIR).filter((file) => file.endsWith(".json"));

        for (const file of locales) {
            it(`${file} is valid json`, () => {
                assert.doesNotThrow(() => readLocale(path.basename(file, ".json")));
            });
        }

        /**
         * Checking only that "{{" and "}}" both appear somewhere in the string
         * passed a real defect: da.json carried "<Bold>{{down} Mbps</Bold>"
         * alongside a correct "{{up}}", so the string was balanced overall
         * while i18next rendered that sentence with the placeholder intact.
         */
        const eachString = function* () {
            for (const file of locales) {
                const translated = readLocale(path.basename(file, ".json"));
                for (const key of flatten(translated)) {
                    const value = key.split(".").reduce((node, part) => node?.[part], translated);
                    if (typeof value === "string") yield {file, key, value};
                }
            }
        };

        it("never leaves a translated string with a broken placeholder", () => {
            for (const {file, key, value} of eachString())
                assert.equal(value.includes("{{"), value.includes("}}"),
                    `${file}: ${key} has an unbalanced interpolation`);
        });

        it("closes every individual placeholder", () => {
            for (const {file, key, value} of eachString()) {
                // Every "{{" has to be followed by a name and "}}" before the
                // next "{{" begins.
                const opened = (value.match(/\{\{/g) ?? []).length;
                const wellFormed = (value.match(/\{\{[^{}]*}}/g) ?? []).length;

                assert.equal(wellFormed, opened, `${file}: ${key} has a malformed placeholder in "${value}"`);
            }
        });

        it("uses only placeholder names that the english source also uses", () => {
            const english = readLocale("en");
            const names = (value) => new Set((value.match(/\{\{([^{}]*)}}/g) ?? []).map((match) => match.slice(2, -2).trim()));

            for (const {file, key, value} of eachString()) {
                if (file === "en.json") continue;

                const source = key.split(".").reduce((node, part) => node?.[part], english);
                if (typeof source !== "string") continue;

                const expected = names(source);
                const actual = names(value);

                for (const name of actual)
                    assert.ok(expected.has(name),
                        `${file}: ${key} interpolates "${name}", which en.json does not provide`);

                // The other direction matters just as much: a translation that
                // silently drops a placeholder renders a sentence with the
                // number missing, and the one-way check above passed it.
                for (const name of expected)
                    assert.ok(actual.has(name),
                        `${file}: ${key} drops the "${name}" placeholder that en.json provides`);
            }
        });
    });
});
