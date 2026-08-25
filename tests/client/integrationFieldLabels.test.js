import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { initialize, getIntegrations } from "../../server/controller/integrations.js";

const ROOT = path.resolve(fileURLToPath(import.meta.url), "..", "..", "..");

const readLocale = (code) =>
    JSON.parse(fs.readFileSync(path.join(ROOT, "client", "public", "assets", "locales", `${code}.json`), "utf8"));

const valueAt = (object, key) => key.split(".").reduce((node, part) => node?.[part], object);

/**
 * Every setting an integration declares has a label a person can read.
 *
 * i18nKeys.test.js cannot see these. Its scanner matches double-quoted `t("…")`
 * literals, and every integration field key is built from a template literal -
 * `integrations.${name}.fields.${field}` - so a field added on the server with
 * no matching string ships as its own raw key, rendered to the user in every
 * language including English. Nothing anywhere caught that until this.
 *
 * The field list is taken from the server definitions rather than written out
 * here, so a field added to any module - or handed to every notifier at once,
 * as the threshold settings are - is checked the moment it exists.
 */
before(async () => {
    await initialize();
});

// The two-tier lookup the dialog performs: an integration's own string first,
// then the shared namespace that exists so a setting common to every notifier
// is written once rather than once per integration.
const labelKeys = (integration, field) => [
    `integrations.${integration}.fields.${field}`,
    `integrations.fields.${field}`
];

describe("integration field labels", () => {
    const english = readLocale("en");

    const everyField = () => Object.entries(getIntegrations())
        .flatMap(([name, definition]) => definition.fields.map((field) => ({name, field: field.name})));

    it("finds fields to check", () => {
        assert.ok(everyField().length > 40, "the definitions gave nothing to check");
    });

    /**
     * The name an integration is listed and stored under is checked in
     * invariantText.test.js instead, because most of them are no longer locale
     * keys: nine are brand names, which belong nowhere a translator can reach
     * them, and only "Email" is still a word this file could look up.
     */

    it("has a label for every declared field", () => {
        const missing = everyField()
            .filter(({name, field}) => !labelKeys(name, field).some((key) => valueAt(english, key) !== undefined))
            .map(({name, field}) => `${name}.${field}`);

        assert.deepEqual(missing, [], "these fields render as their own key in the interface");
    });

    /**
     * The shared strings are written once. Naming them per integration would be
     * the same sentence copied into every notifier, in every locale - and each
     * copy is a string nothing would notice going missing.
     */
    it("names the shared settings once rather than once per integration", () => {
        const shared = Object.keys(english.integrations.fields ?? {});

        assert.ok(shared.length > 0, "no shared field namespace exists");

        for (const field of shared)
            for (const [name] of Object.entries(getIntegrations()))
                assert.equal(valueAt(english, `integrations.${name}.fields.${field}`), undefined,
                    `${name} carries its own copy of the shared "${field}" label`);
    });

    // Every locale is now held to full parity by localeParity.test.js, which
    // covers this and more. Kept because it names the shared namespace
    // specifically: these six settings reach every notifier at once, so one of
    // them going untranslated is six dialogs wrong rather than one.
    it("translates every shared setting into German", () => {
        const german = readLocale("de");

        for (const field of Object.keys(english.integrations.fields ?? {})) {
            const key = `integrations.fields.${field}`;

            assert.notEqual(valueAt(german, key), undefined, `de.json is missing ${key}`);
            assert.notEqual(valueAt(german, key), valueAt(english, key),
                `${key} is still the English sentence`);
        }
    });
});
