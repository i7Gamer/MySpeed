import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import i18next from "i18next";

const CLIENT_SRC = path.resolve(fileURLToPath(import.meta.url), "..", "..", "..", "client", "src");

const source = fs.readFileSync(path.join(CLIENT_SRC, "i18n.js"), "utf8");

/**
 * Values interpolated into a translation are printed, not escaped.
 *
 * Reported from the delete confirmation, which read "The test from
 * 8&#x2F;15&#x2F;2026 14:53 will be deleted." i18next escapes interpolated
 * values by default - it is written for templating engines that inject raw
 * HTML - and its escaper turns a slash into `&#x2F;`. React then renders that
 * entity as the literal text it is, because React escapes on its own.
 *
 * It survived this long because it only shows where the value carries a
 * character worth escaping. An English date is 8/15/2026 and a German one is
 * 15.08.2026, so the German build - and every test written against it - was
 * clean. An ISP or server name containing an ampersand has the same fault.
 *
 * The app's own module cannot be imported here: i18n.js pulls in fifteen .webp
 * flags, which node cannot parse. So the mechanism is proven against the real
 * i18next below, and the app is checked for the option that switches it off.
 */
describe("a value interpolated into a translation", () => {
    const translate = async (interpolation) => {
        const instance = i18next.createInstance();

        await instance.init({
            lng: "en",
            fallbackLng: "en",
            resources: {en: {translation: {line: "The test from {{date}} will be deleted."}}},
            ...(interpolation ? {interpolation} : {})
        });

        return instance.t("line", {date: "8/15/2026 14:53"});
    };

    // The bug, stated as a fact about the library rather than about the app:
    // if this ever stops being true the rule below is guarding nothing.
    it("is HTML-escaped by i18next unless it is told not to", async () => {
        assert.match(await translate(null), /&#x2F;/,
            "i18next no longer escapes interpolated values, so escapeValue guards nothing");
    });

    it("keeps its slashes once escaping is off", async () => {
        assert.equal(await translate({escapeValue: false}),
            "The test from 8/15/2026 14:53 will be deleted.");
    });

    // An ampersand is the same fault in a value nobody thinks of as markup.
    it("keeps an ampersand in a name it was handed", async () => {
        const instance = i18next.createInstance();

        await instance.init({
            lng: "en", fallbackLng: "en",
            resources: {en: {translation: {isp: "Measured against {{name}}."}}},
            interpolation: {escapeValue: false}
        });

        assert.equal(instance.t("isp", {name: "AT&T"}), "Measured against AT&T.");
    });

    /**
     * And the app asks for it.
     *
     * Safe here specifically because nothing in the client renders a
     * translation as markup - there is no dangerouslySetInnerHTML anywhere in
     * client/src - so React is what escapes, once, at the point of rendering.
     * The <Trans> components that wrap parts of a sentence in an element are
     * given real React children rather than a string of HTML.
     */
    it("is what the app configures", () => {
        assert.match(source, /interpolation:\s*\{[^}]*escapeValue:\s*false/,
            "i18n.js still lets i18next escape interpolated values, which double-escapes every date");
    });
});
