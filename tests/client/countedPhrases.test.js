import { it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import i18next from "i18next";
import { OUTAGE_EVENT, RECOVERED_EVENT, outageSummary } from "../../server/util/outage.js";
import { zoneFromName } from "../../server/util/timezone.js";

const SINCE = "2026-08-13T09:15:00.000Z";
const zone = zoneFromName("UTC");
const expected = {
    en: ["1 test has failed since", "after 1 failed test since", "1 lost", "2 lost"],
    fr: ["1 test a échoué depuis", "après 1 test échoué depuis", "1 perdu", "2 perdus"],
    es: ["1 prueba ha fallado desde", "tras 1 prueba fallida desde", "1 perdido", "2 perdidos"],
    it: ["1 test è fallito da", "dopo 1 test fallito da", "1 perso", "2 persi"],
    de: ["1 Test ist seit", "nach 1 fehlgeschlagenem Test seit", "1 verloren", "2 verloren"]
};

for (const [language, [outage, recovery, oneLost, twoLost]] of Object.entries(expected)) {
    it(`${language} renders singular outage and recovery summaries through the notification path`, () => {
        const payload = {failuresInRow: 1, downSince: SINCE};
        assert.ok(outageSummary(OUTAGE_EVENT, payload, language, zone).includes(outage));
        assert.ok(outageSummary(RECOVERED_EVENT, payload, language, zone).includes(recovery));
        const own = JSON.parse(fs.readFileSync(`client/public/assets/locales/${language}.json`, "utf8"));
        assert.equal(outageSummary(OUTAGE_EVENT, {...payload, failuresInRow: 2}, language, zone),
            own.notification.outage_summary.replace("{{count}}", "2").replace("{{since}}", "2026-08-13 09:15"));
    });

    it(`${language} renders the route loss count with shipped i18next plural resolution`, async () => {
        const translator = i18next.createInstance();
        const locale = (code) => JSON.parse(fs.readFileSync(`client/public/assets/locales/${code}.json`, "utf8"));
        await translator.init({lng: language, fallbackLng: "en", resources: {
            en: {translation: locale("en")}, [language]: {translation: locale(language)}
        }});
        assert.equal(translator.t("test.details.route_lost", {count: 1}), oneLost);
        assert.equal(translator.t("test.details.route_lost", {count: 2}), twoLost);
    });
}

it("an unavailable notification locale uses the singular English fallback", () => {
    assert.match(outageSummary(OUTAGE_EVENT, {failuresInRow: 1, downSince: SINCE}, "unknown", zone), /^1 test has failed since /);
});
