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
            "test.result.server",
            "statistics.downsampled"
        ];

        for (const key of required) {
            it(`defines ${key} in every locale or leaves it to the english fallback`, () => {
                assert.ok(knownKeys.has(key), `${key} must exist in ${SOURCE_LOCALE}.json`);
            });
        }

        it("keeps the interpolation placeholders of the new strings intact", () => {
            assert.match(english.test.result.server, /\{\{server\}\}/);
            assert.match(english.statistics.downsampled, /\{\{shown\}\}/);
            assert.match(english.statistics.downsampled, /\{\{total\}\}/);
        });
    });

    describe("locale files", () => {
        const locales = fs.readdirSync(LOCALES_DIR).filter((file) => file.endsWith(".json"));

        for (const file of locales) {
            it(`${file} is valid json`, () => {
                assert.doesNotThrow(() => readLocale(path.basename(file, ".json")));
            });
        }

        it("never leaves a translated string with a broken placeholder", () => {
            for (const file of locales) {
                const translated = readLocale(path.basename(file, ".json"));
                for (const key of flatten(translated)) {
                    const value = key.split(".").reduce((node, part) => node?.[part], translated);
                    if (typeof value !== "string") continue;
                    assert.equal(value.includes("{{"), value.includes("}}"),
                        `${file}: ${key} has an unbalanced interpolation`);
                }
            }
        });
    });
});
