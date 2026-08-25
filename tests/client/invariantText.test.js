import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { initialize, getIntegrations } from "../../server/controller/integrations.js";
import {
    INTEGRATION_BRANDS, INTEGRATION_PLACEHOLDERS, integrationPlaceholder, integrationTitle, RETIRED_KEYS
} from "../../client/src/common/utils/InvariantText.js";

const ROOT = path.resolve(fileURLToPath(import.meta.url), "..", "..", "..");
const LOCALES = path.join(ROOT, "client", "public", "assets", "locales");

const readLocale = (code) =>
    JSON.parse(fs.readFileSync(path.join(LOCALES, `${code}.json`), "utf8"));

const valueAt = (object, key) => key.split(".").reduce((node, part) => node?.[part], object);

const codes = fs.readdirSync(LOCALES)
    .filter((file) => file.endsWith(".json"))
    .map((file) => path.basename(file, ".json"));

before(async () => {
    await initialize();
});

/**
 * The strings that are the same in every language, kept where a translator
 * cannot reach them.
 *
 * They used to be locale keys like any other, which meant fifteen copies of
 * "Discord" and an invitation to translate it. Several were duly translated:
 * German rendered the ntfy integration as "nackt" and Dutch as
 * "kant-en-klare", French turned Pushover into "Effet de poussée" and
 * HealthChecks into "Tests de santé", and Portuguese made Discord "Discórdia"
 * and Telegram "Telegrama".
 *
 * None of that was catchable from the locale files. A parity check can see a
 * value that is still the English text; it cannot see one that has been
 * confidently translated into the wrong thing, because that is what a
 * translation looks like. The only fix that holds is to stop asking.
 */
describe("the invariant strings", () => {
    it("are gone from every locale file", () => {
        const surviving = codes.flatMap((code) => {
            const locale = readLocale(code);
            return RETIRED_KEYS.filter((key) => valueAt(locale, key) !== undefined).map((key) => `${code}: ${key}`);
        });

        assert.deepEqual(surviving, [], "these were moved into constants and left behind in the locales");
    });

    it("are gone from the source locale too", () => {
        const english = readLocale("en");

        assert.deepEqual(RETIRED_KEYS.filter((key) => valueAt(english, key) !== undefined), [],
            "en.json still declares keys nothing reads");
    });
});

describe("integrationTitle", () => {
    const translate = (key) => `translated(${key})`;

    it("gives a brand its own name rather than a translation", () => {
        assert.equal(integrationTitle("discord", translate), "Discord");
        assert.equal(integrationTitle("ntfy", translate), "ntfy");
        assert.equal(integrationTitle("healthChecks", translate), "HealthChecks");
    });

    /**
     * Email is not a brand. "Email" is a word, and every language has one -
     * "E-Mail", "Correo electrónico", "電子邮件" - so its title stays a locale
     * key and this has to fall through to it.
     */
    it("still translates a title that is a word rather than a name", () => {
        assert.equal(integrationTitle("email", translate), "translated(integrations.email.title)");
    });

    /**
     * The name is what the dialog writes into integration_name when the card is
     * first saved. An integration with neither a brand here nor a title in the
     * locale stores its own raw key, and carries it in every language
     * afterwards - long after anyone fixes the locale.
     */
    it("has a name for every integration the server defines", () => {
        const english = readLocale("en");
        const nameless = Object.keys(getIntegrations()).filter((name) =>
            !(name in INTEGRATION_BRANDS) && valueAt(english, `integrations.${name}.title`) === undefined);

        assert.deepEqual(nameless, [], "these integrations would be stored as their own translation key");
    });

    it("names no integration the server does not define", () => {
        const defined = Object.keys(getIntegrations());
        const orphans = Object.keys(INTEGRATION_BRANDS).filter((name) => !defined.includes(name));

        assert.deepEqual(orphans, [], "these brands belong to integrations that no longer exist");
    });
});

describe("integrationPlaceholder", () => {
    it("gives back the placeholder a field declares", () => {
        assert.equal(integrationPlaceholder("ntfy", "url"), "https://ntfy.sh");
        assert.equal(integrationPlaceholder("ntfy", "priority"), "3");
    });

    it("gives back nothing for a field that has none, so the locale is asked", () => {
        assert.equal(integrationPlaceholder("ntfy", "topic"), undefined);
        assert.equal(integrationPlaceholder("nonexistent", "url"), undefined);
    });

    /**
     * Every placeholder here names a field that exists. One that does not is
     * silently never read, and the locale key it replaced is already gone - so
     * the field renders with no hint at all.
     */
    it("names only fields the server actually declares", () => {
        const declared = new Set(Object.entries(getIntegrations())
            .flatMap(([name, definition]) => definition.fields.map((field) => `${name}.${field.name}`)));

        const unknown = Object.keys(INTEGRATION_PLACEHOLDERS).filter((key) => !declared.has(key));

        assert.deepEqual(unknown, [], "these placeholders are attached to fields that do not exist");
    });
});
