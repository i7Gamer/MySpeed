import i18n from "i18next";
import {initReactI18next} from "react-i18next";
import LanguageDetector from 'i18next-browser-languagedetector';
import HttpApi from 'i18next-http-backend';
import EnglishFlag from "@/common/assets/languages/en.webp";
import GermanFlag from "@/common/assets/languages/de.webp";
import BulgarianFlag from "@/common/assets/languages/bg.webp";
import ChineseFlag from "@/common/assets/languages/zh.webp";
import DutchFlag from "@/common/assets/languages/nl.webp";
import FranceFlag from "@/common/assets/languages/fr.webp";
import ItalianFlag from "@/common/assets/languages/it.webp";
import PortugueseBrazilFlag from "@/common/assets/languages/br.webp";
import RussianFlag from "@/common/assets/languages/ru.webp";
import SpanishFlag from "@/common/assets/languages/es.webp";
import TurkishFlag from "@/common/assets/languages/tr.webp";
import DanishFlag from "@/common/assets/languages/da.webp";
import PolishFlag from "@/common/assets/languages/pl.webp";
import IndonesianFlag from "@/common/assets/languages/id.webp";
// The locale is keyed by language ("uk") and the flag by country ("ua"), as
// Portuguese is already keyed "pt" against a "br" flag.
import UkrainianFlag from "@/common/assets/languages/ua.webp";
import {readStored, writeStored} from "@/common/utils/Storage";
import {supportedLanguage} from "@/common/utils/LanguageChoice";
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

export const languages = [
    {name: 'English', code: 'en', flag: EnglishFlag},
    {name: 'Deutsch', code: 'de', flag: GermanFlag},
    {name: 'Български', code: 'bg', flag: BulgarianFlag},
    {name: '中文', code: 'zh', flag: ChineseFlag},
    {name: 'Nederlands', code: 'nl', flag: DutchFlag},
    {name: 'Français', code: 'fr', flag: FranceFlag},
    {name: 'Italiano', code: 'it', flag: ItalianFlag},
    {name: 'Português do Brasil', code: 'pt', flag: PortugueseBrazilFlag},
    {name: 'Русский', code: 'ru', flag: RussianFlag},
    {name: 'Español', code: 'es', flag: SpanishFlag},
    {name: 'Dansk', code: 'da', flag: DanishFlag},
    {name: 'Polski', code: 'pl', flag: PolishFlag},
    {name: 'Türkçe', code: 'tr', flag: TurkishFlag},
    {name: 'Bahasa Indonesia', code: 'id', flag: IndonesianFlag},
    {name: 'Українська', code: 'uk', flag: UkrainianFlag}
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
    // partialBundledLanguages the other fourteen are still fetched on demand,
    // and English is simply already there. Without that flag `resources` turns
    // the HTTP backend off altogether and a fifteen-language interface silently
    // becomes an English one that still offers to change language.
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
        loadPath: '/assets/locales/{{lng}}.json'
    },
    detection: {
        order: ['localStorage'],
        lookupLocalStorage: 'language'
    }
});

export default i18n;