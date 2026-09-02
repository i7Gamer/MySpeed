import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { initialize, getIntegrations } from "../../server/controller/integrations.js";

const ROOT = path.resolve(fileURLToPath(import.meta.url), "..", "..", "..");
const DIALOG = path.join(ROOT, "client", "src", "common", "components", "IntegrationDialog", "IntegrationDialog.jsx");
const I18N = path.join(ROOT, "client", "src", "i18n.js");

/**
 * The languages the client registers, read off its own list. The server's
 * options come off the locale directory, so this is the check that a locale
 * file merged ahead of its menu entry is not offered under a raw code.
 */
const registeredCodes = () =>
    [...fs.readFileSync(I18N, "utf8").matchAll(/code: '([a-z-]+)'/g)].map(([, code]) => code).sort();

/**
 * The language a notifier writes in reaches the form as a select whose
 * options are the server's - the locale codes it can answer - and whose
 * labels are the client's, the native names the language menu already shows
 * beside each flag. Neither side lists the languages by hand.
 *
 * The dialog needs six contexts to render, so the wiring is pinned by
 * reading it: the options come off the field definition, and the labels off
 * the one list of languages the client keeps.
 */
before(async () => {
    await initialize();
});

describe("the language setting on every notifier", () => {
    const notifiers = () => Object.entries(getIntegrations())
        .filter(([, definition]) => definition.fields.some((field) => field.name === "alert_only"));

    it("is offered wherever the threshold settings are", () => {
        assert.ok(notifiers().length >= 6, "fewer notifiers than ship");

        for (const [name, definition] of notifiers()) {
            const field = definition.fields.find((candidate) => candidate.name === "language");

            assert.ok(field, `${name} offers no language`);
            assert.equal(field.type, "select");
            assert.equal(field.required, false, `${name} demands a language`);
            assert.deepEqual([...field.options].sort(), registeredCodes(),
                `${name} offers a language the client cannot name, or misses one it can`);
            assert.equal(field.options[0], "en", "the default is not offered first");
        }
    });

    it("is not offered to a module that tells nobody anything", () => {
        for (const [name, definition] of Object.entries(getIntegrations())) {
            if (notifiers().some(([notifier]) => notifier === name)) continue;

            assert.ok(!definition.fields.some((field) => field.name === "language"),
                `${name} sends no prose and offers a language for it`);
        }
    });

    describe("in the dialog", () => {
        const source = fs.readFileSync(DIALOG, "utf8");

        it("labels each code with the native name the language menu uses", () => {
            assert.match(source, /import \{[^}]*\blanguages\b[^}]*\} from "@\/i18n"/,
                "the dialog keeps a list of language names of its own, or none");
        });

        it("hands the field's options to the form field", () => {
            assert.match(source, /options=\{[^}]*selectOptions\(field\)/, "the select is drawn without its options");
            assert.match(source, /const selectOptions = \(field\) => \(field\.options/,
                "the options come from somewhere other than the field definition");
        });
    });
});
