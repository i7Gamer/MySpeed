import {it} from "node:test";
import assert from "node:assert/strict";
import {readLocale} from "../helpers/source.js";
import {alertSummary} from "../../server/util/alertThreshold.js";

const LOCALES = ["ja", "ko", "zh", "zh-tw", "id", "tr"];
const locale = Object.fromEntries(LOCALES.map(code => [code, readLocale(code)]));

it("Indonesian and Turkish name a rolling 365-day window, not the previous calendar year", () => {
    assert.match(locale.id.calendar.last_year, /365 hari terakhir/);
    assert.match(locale.tr.calendar.last_year, /Son 365 gün/);
});

it("endpoint comparisons keep the endpoint noun separate from numerical goals", () => {
    for (const [code, endpoint] of Object.entries({zh: /测速点/, "zh-tw": /測速點/, id: /tujuan/i, tr: /test nokt/i})) {
        assert.match(locale[code].statistics.targets.title, endpoint, code);
        assert.match(locale[code].statistics.targets.empty, endpoint, code);
        assert.match(locale[code].targets.baseline_desc, endpoint, code);
        assert.doesNotMatch(locale[code].statistics.values.target, endpoint, code);
    }
});

it("Chinese connection change copy distinguishes the reporting test service from the ISP", () => {
    assert.match(locale.zh.connections.description, /测速服务/);
    assert.match(locale["zh-tw"].connections.description, /測速服務/);
});

it("Indonesian and Turkish grade settings describe coloring numbers", () => {
    assert.match(locale.id.preferences.grade_values.description, /warna/i);
    assert.match(locale.id.preferences.grade_values.description, /angka/i);
    assert.match(locale.tr.preferences.grade_values.description, /ren[kg]/i);
    assert.match(locale.tr.preferences.grade_values.description, /say/i);
});

it("Indonesian latency help says unusable rather than unused", () => {
    for (const key of ["loaded_latency", "bufferbloat"]) {
        assert.doesNotMatch(locale.id.info[key].description, /tak terpakai/);
        assert.match(locale.id.info[key].description, /tidak dapat digunakan/);
    }
});

it("low-speed server alerts use an out-of-bounds heading, not an above-limit heading", () => {
    const PAYLOAD = {download: 50};
    const LIMITS = {alert_download_below: 100};
    for (const [code, heading] of Object.entries({ja: /基準外/, ko: /기준 이탈/, id: /Batas dilanggar/, tr: /Sınır ihlali/})) {
        const message = alertSummary(PAYLOAD, {...LIMITS, language: code});
        assert.match(message, heading, code);
        assert.ok(message.includes("50") && message.includes("100"), message);
    }
});

it("last failure help includes failed results, not only tests that did not finish", () => {
    const failed = {ja: /失敗/, ko: /실패/, zh: /失败/, "zh-tw": /失敗/, id: /gagal/, tr: /başarısız/};
    for (const code of LOCALES) assert.match(locale[code].statistics.overview.last_failure_description, failed[code], code);
});

it("Indonesian recovery announces reconnection without promising normal performance", () => {
    assert.doesNotMatch(locale.id.notification.recovered, /normal/);
    assert.match(locale.id.notification.recovered, /tersambung/);
    assert.doesNotMatch(locale.id.integrations.fields.send_outage, /normal/);
});
