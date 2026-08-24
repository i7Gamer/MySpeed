import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const LOCALES_DIR = "client/public/assets/locales";

const read = (code) => JSON.parse(fs.readFileSync(path.join(LOCALES_DIR, `${code}.json`), "utf8"));

const flatten = (object, prefix = "") => Object.entries(object).flatMap(([key, value]) => {
    const full = prefix ? `${prefix}.${key}` : key;
    return value && typeof value === "object" ? flatten(value, full) : [full];
});

/**
 * German ships with the feature; every other language follows through Crowdin.
 *
 * That is the project's actual practice - de.json tracked English exactly,
 * while the remaining locales sat some dozens of keys behind - but nothing
 * enforced it, so four strings added with the all-time range, the empty-range
 * message and the period comparison never got a German translation. A German
 * instance rendered "All time" in its date picker and "Changes compared with
 * 28. Juli 2026 - 03. Aug. 2026": an English sentence with German dates in it.
 *
 * Only German is held to this. Asserting the same of the Crowdin-managed
 * locales would fail on every string until translators had been round, which
 * is a normal state for them to be in rather than a broken build.
 */
describe("the German locale", () => {
    const english = new Set(flatten(read("en")));
    const german = new Set(flatten(read("de")));

    it("translates every English key", () => {
        const missing = [...english].filter((key) => !german.has(key));

        assert.deepEqual(missing, [],
            `de.json is missing ${missing.length} key(s); a German instance renders these in English`);
    });

    it("carries no key English does not have", () => {
        const extra = [...german].filter((key) => !english.has(key));

        assert.deepEqual(extra, [], "de.json has keys that no longer exist in en.json");
    });

    it("leaves no value as the untranslated English text", () => {
        const en = read("en");
        const de = read("de");
        const valueAt = (object, key) => key.split(".").reduce((node, part) => node?.[part], object);

        /**
         * Values a German reader sees in the same shape an English one does:
         * units, bare placeholders, and product terms that are not translated
         * in German either. Listed one by one rather than waved through by a
         * pattern - this check is what caught "1 day" and "{{days}} days"
         * sitting among fully translated siblings, and a loose rule would have
         * let them past.
         */
        const SHARED = new Set([
            "latest.speed_unit", "latest.ping_unit", "latest.jitter_unit", "latest.byte_speed_unit",
            "storage.csv", "storage.json",
            "welcome.ms", "update.ping_placeholder",
            "test.details.seconds", "test.details.bufferbloat_value",
            "integrations.influxdb.fields.token", "integrations.telegram.fields.token",
            "integrations.telegram.fields.chat_id", "integrations.ntfy.fields.title_placeholder",
            // The notification templates are variable names, identical everywhere.
            ...["discord", "email", "gotify", "pushover", "ntfy", "telegram"]
                .map((name) => `integrations.${name}.fields.finished_message_placeholder`)
        ]);

        const copied = [...english].filter((key) =>
            !SHARED.has(key) && valueAt(en, key) === valueAt(de, key) && /\s/.test(String(valueAt(en, key) ?? "")));

        assert.deepEqual(copied, [], "these German values are still the English sentence");
    });
});
