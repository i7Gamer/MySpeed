import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
    DEFAULT_LANGUAGE, NOTIFICATION_LANGUAGES, phrase
} from "../../server/util/notificationLocale.js";

/**
 * The words a notification is built from, in the recipient's language.
 *
 * They come from the same locale files the interface ships - the ones the
 * translators edit - rather than a second catalog kept beside the server. A
 * copy would be a second English to keep in step, and the one the translators
 * edit would not be the one a message is written from.
 *
 * Read in this process from client/public/assets/locales, which is where the
 * files are before a build; a running instance reads them from the build
 * beside it, or from the client embedded in the binary. The three sources hold
 * the same files, so the catalog is tested against the one that is always
 * here.
 */
describe("the notification phrases", () => {
    it("answers English by default", () => {
        assert.equal(DEFAULT_LANGUAGE, "en");
        assert.equal(phrase(undefined, "finished"), "A speedtest is finished");
        assert.equal(phrase(null, "finished"), "A speedtest is finished");
        assert.equal(phrase("", "finished"), "A speedtest is finished");
    });

    it("answers in the language asked for", () => {
        assert.equal(phrase("de", "finished"), "Ein Speedtest ist abgeschlossen");
    });

    // A language the interface does not ship, or a stored value from a
    // language since dropped, is English rather than a thrown lookup.
    it("falls back to English for a language it does not know", () => {
        assert.equal(phrase("tlh", "finished"), "A speedtest is finished");
        assert.equal(phrase("../../etc/passwd", "finished"), "A speedtest is finished");
    });

    // Per key, not per language: a locale that has not caught up with a key
    // added later answers that one key in English and the rest in its own.
    it("falls back to English one key at a time", () => {
        assert.equal(phrase("de", "a_key_no_locale_defines"), phrase("en", "a_key_no_locale_defines"));
        assert.equal(phrase("de", "finished"), "Ein Speedtest ist abgeschlossen");
    });

    it("answers the key itself when even English lacks it", () => {
        assert.equal(phrase("en", "a_key_no_locale_defines"), "a_key_no_locale_defines");
    });

    it("fills the placeholders a phrase carries", () => {
        assert.equal(phrase("en", "limit_over", {metric: "ping", value: 62, unit: "ms", limit: 50}),
            "ping 62 ms over 50");
    });

    // A placeholder nothing was given for is left standing rather than
    // printed as "undefined", the way replaceVariables leaves an unknown
    // %variable%.
    it("leaves a placeholder it was given nothing for", () => {
        assert.equal(phrase("en", "limit_over", {metric: "ping"}), "ping {{value}} {{unit}} over {{limit}}");
    });

    /**
     * The languages a notifier may be set to are exactly the locale files that
     * ship, read off the directory rather than listed by hand - a language
     * added to the interface is offered to the notifiers without a second
     * edit, and one that is offered is guaranteed to answer.
     */
    it("offers every language the interface ships, English first", () => {
        assert.equal(NOTIFICATION_LANGUAGES[0], "en");
        assert.ok(NOTIFICATION_LANGUAGES.includes("de"));
        assert.ok(NOTIFICATION_LANGUAGES.length >= 20, "fewer languages than the interface ships");

        for (const code of NOTIFICATION_LANGUAGES)
            assert.match(code, /^[a-z]{2}(-[a-z]{2})?$/, `${code} is not a locale code`);
    });
});
