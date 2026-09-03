import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readSource } from "../helpers/source.js";
import { applyDocumentLanguage, followLanguage } from "../../client/src/common/utils/DocumentLanguage.js";

/**
 * index.html ships `lang="en"` and nothing ever changed it, so a German
 * interface told every screen reader and spell checker it was English. The
 * document's lang now follows the language i18n.js speaks.
 */
describe("the document language", () => {
    it("stamps the language on the element", () => {
        const element = {lang: "en"};

        applyDocumentLanguage(element, "de");

        assert.equal(element.lang, "de");
    });

    // An empty or missing language must not blank the attribute the markup
    // shipped with: "" is worse than a wrong language, it is no language.
    it("leaves the element alone when there is nothing to stamp", () => {
        const element = {lang: "en"};

        applyDocumentLanguage(element, "");
        applyDocumentLanguage(element, undefined);
        applyDocumentLanguage(element, null);

        assert.equal(element.lang, "en");
    });

    it("copes with no element at all", () => {
        assert.doesNotThrow(() => applyDocumentLanguage(null, "de"));
    });

    it("applies the current language at once and every change after it", () => {
        const i18n = Object.assign(new EventEmitter(), {language: "fr"});
        const element = {lang: "en"};

        followLanguage(i18n, element);
        assert.equal(element.lang, "fr", "the language already chosen was not applied");

        i18n.emit("languageChanged", "de");
        assert.equal(element.lang, "de");

        i18n.emit("languageChanged", "ja");
        assert.equal(element.lang, "ja");
    });

    it("stops following once unsubscribed", () => {
        const i18n = Object.assign(new EventEmitter(), {language: "en"});
        const element = {lang: "en"};

        const stop = followLanguage(i18n, element);
        stop();
        i18n.emit("languageChanged", "de");

        assert.equal(element.lang, "en", "a change arrived after the follower was stopped");
    });

    // And the bootstrap hands it the real document. i18n.js cannot be imported
    // here - it wires the HTTP backend and the browser detector - so the
    // wiring is read, the way languageChoice.test.js reads it.
    it("is followed by the i18n bootstrap", () => {
        const source = readSource("client/src/i18n.js");

        assert.match(source, /followLanguage\(i18n, /, "i18n.js never hands the document its language");
        assert.match(source, /document\.documentElement/, "the follower is given something other than the document element");
        assert.match(source, /typeof document === "undefined"/, "a load without a document would throw");
    });
});
