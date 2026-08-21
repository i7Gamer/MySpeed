import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { supportedLanguage } from "../../client/src/common/utils/LanguageChoice.js";
import { readSource } from "../helpers/source.js";

/**
 * Which of the offered languages a stored code actually names.
 *
 * i18n.js seeds the stored language from `navigator.language` on a first visit
 * and wrote whatever it found. i18next itself copes - `supportedLngs` sends
 * anything unknown to the English fallback, so the interface reads correctly -
 * but the language dialog does not: it seeds its selection from that same stored
 * value and highlights the entry matching it, so a browser set to Japanese,
 * Korean, Czech or any of the other languages MySpeed does not ship opened the
 * dialog with nothing selected at all. The list gave no sign of which language
 * was in use, and the reader had to pick one to find out.
 *
 * A value stored by an earlier version is the same case, which is why this is
 * asked on the way out of storage as well as on the way in.
 */
const LANGUAGES = [{code: "en"}, {code: "de"}, {code: "pt"}, {code: "uk"}];

describe("supportedLanguage", () => {
    it("keeps a language that is offered", () => {
        assert.equal(supportedLanguage("de", LANGUAGES), "de");
        assert.equal(supportedLanguage("uk", LANGUAGES), "uk");
    });

    for (const [name, code] of [
        ["one that is not offered", "ja"],
        ["a region that is not a language here", "en-GB"],
        ["nothing stored yet", null],
        ["an undefined value", undefined],
        ["an empty string", ""]
    ])
        it(`falls back to English for ${name}`, () => {
            assert.equal(supportedLanguage(code, LANGUAGES), "en",
                "the dialog opens with no language selected at all");
        });

    // The fallback is the one i18next is configured with, so the dialog and the
    // interface cannot disagree about what is being read.
    it("takes the fallback it is given", () => {
        assert.equal(supportedLanguage("ja", LANGUAGES, "de"), "de");
    });
});

/**
 * And both ends ask it: the seed that writes the value, and the dialog that
 * reads it back. Either one alone leaves the other showing the wrong thing.
 */
describe("where the stored language comes from and goes", () => {
    it("is what i18n.js seeds a first visit with", () => {
        const source = readSource("client/src/i18n.js");

        assert.match(source, /supportedLanguage\(/,
            "the browser's own language is stored whether or not MySpeed offers it");
        assert.doesNotMatch(source, /writeStored\('language',\s*navigator\.language\.split\('-'\)\[0\]\)/,
            "the raw browser language is still written straight through");
    });

    it("is what the language dialog highlights", () => {
        const source = readSource("client/src/common/components/LanguageDialog/LanguageDialog.jsx");

        assert.match(source, /supportedLanguage\(/,
            "the dialog highlights the stored code even when it names no entry in the list");
    });

    /**
     * And it re-reads when it opens, as the four sibling dialogs do. A useState
     * initialiser runs once, at the mount the header does long before anything
     * is opened - so a language changed in another tab, or by the detector,
     * left the dialog pointing at the one it saw first.
     */
    it("is re-read each time the dialog opens", () => {
        const source = readSource("client/src/common/components/LanguageDialog/LanguageDialog.jsx");

        assert.match(source, /useSyncOnOpen\(/,
            "the selection is seeded once at mount and never refreshed");
    });
});
