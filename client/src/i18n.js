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

if (localStorage.getItem('language') === null)
    localStorage.setItem('language', navigator.language.split('-')[0]);

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

i18n.use(initReactI18next).use(LanguageDetector).use(HttpApi).init({
    supportedLngs: languages.map(lang => lang.code),
    fallbackLng: 'en',
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