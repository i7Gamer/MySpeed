import i18n from "i18next";
import {initReactI18next} from "react-i18next";
import LanguageDetector from 'i18next-browser-languagedetector';
import HttpApi from 'i18next-http-backend';
import {readStored, writeStored} from "@/common/utils/Storage";
import {supportedLanguage} from "@/common/utils/LanguageChoice";
import {withBasePath} from "@/common/utils/BasePath";
/*
 * The English locale, bundled rather than fetched.
 *
 * Upstream #725 and #1330. Every language was loaded over HTTP at boot, English
 * included, and one failed request set the state that renders the error page -
 * which reloads itself after five seconds, fetches the same missing file, and
 * fails again. The floor has to be something no request can take away, and this
 * is it: whatever else does or does not arrive, there is always a full set of
 * strings to render with.
 *
 * Imported from public/ rather than copied into src/, because that path is
 * crowdin's source file (see crowdin.yml). A copy would be a second English to
 * keep in step, and the one the translators edit would not be the one shipped.
 */
import englishTranslations from "../public/assets/locales/en.json";

/**
 * The language everything falls back to, and therefore the one that is bundled.
 * Named because three places have to agree on it: the resource below, the
 * fallback below that, and App.jsx asking whether anything is loadable at all.
 */
export const FALLBACK_LANGUAGE = "en";

/**
 * Every flag the dialog can draw, in one declaration.
 *
 * These were seventeen hand-written imports that differed only in the file
 * name, and every new language meant writing an eighteenth. The eager glob is
 * the same thing to the bundler - each file is resolved and hashed at build
 * time exactly as a static import is - so nothing changes in the output; what
 * changes is that a language is now one list entry and one file.
 *
 * The flag is keyed by country and the locale by language, so the two are not
 * always the same word: Portuguese is keyed "pt" against the "br" flag,
 * Ukrainian "uk" against "ua", and Irish "ga" against "ie". A name with no
 * file behind it resolves to undefined and the entry draws no image, which is
 * why tests/client/localeRegistry.test.js holds every entry to a file that
 * exists.
 */
const FLAGS = import.meta.glob("./common/assets/languages/*.webp", {eager: true, import: "default"});

const flag = (country) => FLAGS[`./common/assets/languages/${country}.webp`];

export const languages = [
    {name: 'English', code: 'en', flag: flag('en')},
    {name: 'Deutsch', code: 'de', flag: flag('de')},
    {name: 'Български', code: 'bg', flag: flag('bg')},
    // Named apart from 繁體中文 below since the day both shipped - a bare 中文
    // stopped saying which one it was.
    {name: '简体中文', code: 'zh', flag: flag('zh')},
    {name: 'Nederlands', code: 'nl', flag: flag('nl')},
    {name: 'Français', code: 'fr', flag: flag('fr')},
    // Rebuilt from Crowdin's 2026-08-19 state and completed in-repo: the
    // strings Crowdin had not reached are machine-authored, pending a native
    // speaker's pass.
    {name: 'Gaeilge', code: 'ga', flag: flag('ie')},
    {name: 'Italiano', code: 'it', flag: flag('it')},
    {name: 'Português do Brasil', code: 'pt', flag: flag('br')},
    {name: 'Русский', code: 'ru', flag: flag('ru')},
    {name: 'Español', code: 'es', flag: flag('es')},
    {name: 'Dansk', code: 'da', flag: flag('da')},
    {name: 'Polski', code: 'pl', flag: flag('pl')},
    {name: 'Türkçe', code: 'tr', flag: flag('tr')},
    {name: 'Bahasa Indonesia', code: 'id', flag: flag('id')},
    {name: 'Українська', code: 'uk', flag: flag('ua')},
    /*
     * The six below are authored in-repo rather than through Crowdin, pending
     * native review - the same standing Gaeilge has above.
     *
     * Two codes deserve a note. Norwegian is "nb" (Bokmål), which is what
     * browsers send; a browser that says only "no" falls back to English until
     * someone asks for the alias. Traditional Chinese is spelled "zh-tw" in
     * lowercase so the tests' lowercase code checks keep holding - and this
     * comment must never name that character class literally, because the
     * inventory test reads this list up to the first closing bracket. The
     * detector seeds from navigator.language's first segment, so a zh-TW
     * browser arrives at Simplified and picks Traditional by hand.
     */
    {name: 'Čeština', code: 'cs', flag: flag('cz')},
    {name: 'Norsk', code: 'nb', flag: flag('no')},
    {name: 'Svenska', code: 'sv', flag: flag('se')},
    {name: '日本語', code: 'ja', flag: flag('jp')},
    {name: '한국어', code: 'ko', flag: flag('kr')},
    {name: '繁體中文', code: 'zh-tw', flag: flag('tw')}
]

/*
 * Seeded below the list rather than above it, because the seed is now judged
 * against it.
 *
 * The browser's language used to be stored exactly as it came. i18next copes -
 * `supportedLngs` sends anything unknown to the English fallback - but the
 * language dialog reads this same value to decide which entry to highlight, so
 * a browser set to a language MySpeed does not ship opened it with nothing
 * selected and no sign of what was in use.
 */
if (readStored('language') === null)
    writeStored('language', supportedLanguage(navigator.language.split('-')[0], languages));

i18n.use(initReactI18next).use(LanguageDetector).use(HttpApi).init({
    supportedLngs: languages.map(lang => lang.code),
    fallbackLng: FALLBACK_LANGUAGE,
    // Seeds the store, rather than replacing the backend: with
    // partialBundledLanguages every other language is still fetched on demand,
    // and English is simply already there. Without that flag `resources` turns
    // the HTTP backend off altogether and a twenty-two-language interface
    // silently becomes an English one that still offers to change language.
    resources: {[FALLBACK_LANGUAGE]: {translation: englishTranslations}},
    partialBundledLanguages: true,
    // Values are printed, not injected as markup. i18next escapes them by
    // default - it is written for templating engines that build HTML strings -
    // and its escaper turns a slash into `&#x2F;`, which React then renders as
    // that literal text because React escapes on its own. The delete
    // confirmation read "The test from 8&#x2F;15&#x2F;2026 will be deleted";
    // any name carrying an ampersand had the same fault, and a German date -
    // 15.08.2026 - hid it, which is why it survived this long.
    //
    // Safe because nothing here renders a translation as markup: there is no
    // dangerouslySetInnerHTML in the client, and <Trans> is given real React
    // children rather than a string of HTML.
    interpolation: {
        escapeValue: false
    },
    backend: {
        // Through the prefix, like every other URL the client emits (#771).
        // Absolute, this 404s under a subdirectory and every language but the
        // bundled English silently stops loading.
        loadPath: withBasePath('/assets/locales/{{lng}}.json')
    },
    detection: {
        order: ['localStorage'],
        lookupLocalStorage: 'language'
    }
});

export default i18n;