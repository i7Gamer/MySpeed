import {before, it} from "node:test";
import assert from "node:assert/strict";
import i18next from "i18next";
import {bodyOf, localeCodes, readLocale, readSource} from "../helpers/source.js";
import {spanInWords} from "../../client/src/common/utils/FormatUtil.js";
import {lineChartOptions, chartThemeColors} from "../../client/src/pages/Statistics/charts/lineChartConfig.js";
import {outageSummary, OUTAGE_EVENT, RECOVERED_EVENT} from "../../server/util/outage.js";
import {zoneFromName} from "../../server/util/timezone.js";
import {mergeLocale, localeGaps} from "../../scripts/localeGaps.js";

const COUNTS = [0, 1, 2, 3, 4, 5, 11, 12, 14, 21, 22, 31, 101];
const SECOND = 1;
const MINUTE = 60;
const HOUR = 3600;
const DAY = 86400;
const SINCE = "2026-08-13T09:15:00.000Z";
const UTC = zoneFromName("UTC");
const locales = Object.fromEntries(localeCodes().map(code => [code, readLocale(code)]));
// Evaluate the shipped init options, supplying only browser-free dependencies.
const configured = new Function("languages", "FALLBACK_LANGUAGE", "englishTranslations", "withBasePath",
    `return (${bodyOf(readSource("client/src/i18n.js"), "i18n.use(initReactI18next).use(LanguageDetector).use(HttpApi).init(")});`
)(localeCodes().map(code => ({code})), "en", locales.en, value => value);
before(async () => i18next.init({...configured, lng: "en", resources:
    Object.fromEntries(Object.entries(locales).map(([code, translation]) => [code, {translation}]))}));

const words = {
    ru: {seconds: ["секунда", "секунды", "секунд"], minutes: ["минута", "минуты", "минут"], hours: ["час", "часа", "часов"], days: ["день", "дня", "дней"]},
    uk: {seconds: ["секунда", "секунди", "секунд"], minutes: ["хвилина", "хвилини", "хвилин"], hours: ["година", "години", "годин"], days: ["день", "дні", "днів"]},
    pl: {seconds: ["sekunda", "sekundy", "sekund"], minutes: ["minuta", "minuty", "minut"], hours: ["godzina", "godziny", "godzin"], days: ["dzień", "dni", "dni"]},
    cs: {seconds: ["sekunda", "sekundy", "sekund"], minutes: ["minuta", "minuty", "minut"], hours: ["hodina", "hodiny", "hodin"], days: ["den", "dny", "dnů"]}
};

for (const [code, units] of Object.entries(words)) {
    it(`${code} renders durations using its cardinal categories, including 21`, async () => {
        await i18next.changeLanguage(code);
        for (const [unit, multiplier] of Object.entries({seconds: SECOND, minutes: MINUTE, hours: HOUR, days: DAY})) {
            for (const count of COUNTS.filter(count => count > 0 && (unit === "days" || count < (unit === "hours" ? 24 : 60)))) {
                const category = new Intl.PluralRules(code).select(count);
                const index = category === "one" ? 0 : category === "few" ? 1 : 2;
                assert.equal(spanInWords(count * multiplier), `${count} ${units[unit][index]}`, `${code} ${unit} ${count}`);
            }
        }
    });

    it(`${code} renders actual chart callbacks and server summaries with the same category`, async () => {
        await i18next.changeLanguage(code);
        const adjective = code === "pl" ? ["nieudany", "nieudane", "nieudanych"]
            : code === "cs" ? ["neúspěšný", "neúspěšné", "neúspěšných"]
                : code === "ru" ? ["неудачный", "неудачных", "неудачных"] : ["невдалий", "невдалі", "невдалих"];
        for (const count of COUNTS.filter(count => count > 0)) {
            const category = new Intl.PluralRules(code).select(count);
            const index = category === "one" ? 0 : category === "few" ? 1 : 2;
            const options = lineChartOptions({themeColors: chartThemeColors(), labels: [SINCE], errors: [null], failedCounts: [count], pointStyle: {}});
            const label = options.plugins.tooltip.callbacks.label({dataset: {label: i18next.t("statistics.failed_test")}, dataIndex: 0});
            assert.ok(label.includes(`${count} ${adjective[index]}`), label);
            for (const [event, family] of [[OUTAGE_EVENT, "outage_summary"], [RECOVERED_EVENT, "recovered_summary"]]) {
                const expected = locales[code].notification[`${family}_${category}`];
                assert.equal(typeof expected, "string", `${code} ${family}_${category}`);
                assert.equal(outageSummary(event, {failuresInRow: count, downSince: SINCE}, code, UTC),
                    expected.replace("{{count}}", count).replace("{{since}}", "2026-08-13 09:15"));
            }
        }
    });
}

it("every shipped count and context family survives translation writing and renders without fallback keys", async () => {
    for (const [code, locale] of Object.entries(locales)) {
        assert.deepEqual(mergeLocale(locales.en, locale, {}), locale, code);
        assert.deepEqual(localeGaps(locales.en, locale).extra, [], code);
        await i18next.changeLanguage(code);
        for (const count of COUNTS) for (const key of ["time.seconds", "time.minutes", "time.hours", "time.days", "statistics.failed_in_period", "test.details.route_lost"]) {
            for (const context of [undefined, "ago"]) {
                const text = i18next.t(key, {count, seconds: count, minutes: count, hours: count, days: count, failed: count, context});
                assert.ok(!text.includes("{{") && text !== key && text.includes(String(count)), `${code} ${key} ${count}: ${text}`);
            }
        }
        for (const count of COUNTS.filter(count => count > 0)) {
            for (const event of [OUTAGE_EVENT, RECOVERED_EVENT]) {
                const text = outageSummary(event, {failuresInRow: count, downSince: SINCE}, code, UTC);
                assert.ok(!text.includes("{{") && text.includes(String(count)) && text.includes("2026-08-13 09:15"), text);
            }
        }
    }
});

it("resolves Traditional Chinese variants to its shipped file using production options", async () => {
    for (const requested of ["zh-tw", "zh-TW"]) {
        await i18next.changeLanguage(requested);
        assert.equal(i18next.t("test.details.route_lost", {count: 2}), "2 個遺失");
        assert.equal(i18next.languages[0], "zh-tw");
    }
    await i18next.changeLanguage("de-DE");
    assert.equal(i18next.t("test.details.route_lost", {count: 2}), "2 verloren");
    await i18next.changeLanguage("zh-CN");
    assert.equal(i18next.t("test.details.route_lost", {count: 2}), "2 个丢失");
});

it("selects the counted Polish route-loss adjective and preserves invariant wording", async () => {
    await i18next.changeLanguage("pl");
    assert.equal(i18next.t("test.details.route_lost", {count: 2}), "2 utracone");
    assert.equal(i18next.t("test.details.route_lost", {count: 21}), "21 utraconych");
    for (const code of ["id", "ja", "ko", "zh", "zh-tw"]) {
        await i18next.changeLanguage(code);
        for (const count of COUNTS) assert.equal(i18next.t("test.details.route_lost", {count}),
            locales[code].test.details.route_lost.replace("{{count}}", count));
    }
});

it("floors fractional durations before selecting the grammatical category", async () => {
    await i18next.changeLanguage("en");
    assert.equal(spanInWords(1.9), "1 second");
    assert.equal(spanInWords(0.9), "0 seconds");
    await i18next.changeLanguage("ru");
    assert.equal(spanInWords(21.9), "21 секунда");
    assert.equal(spanInWords(21.9, {context: "ago"}), "21 секунду");
});

it("keeps instrumental duration forms behind ago", async () => {
    for (const [code, expected] of [["pl", ["1 minutą", "2 minutami", "21 minutami"]], ["cs", ["1 minutou", "2 minutami", "21 minutami"]]]) {
        await i18next.changeLanguage(code);
        for (const [index, count] of [1, 2, 21].entries()) assert.equal(spanInWords(count * MINUTE, {context: "ago"}), expected[index]);
    }
});
