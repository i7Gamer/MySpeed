import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { bodyOf, readSource } from "../helpers/source.js";
import { metricValue } from "../../server/util/metricValue.js";
import { isFailedTest, isSuccessfulTest } from "../../server/util/testOutcome.js";

/**
 * A gauge is set from a stored row, and a stored row is not always a number.
 *
 * prom-client throws "Value is not a valid number" for anything that is not
 * one, and the throw happens before the scrape is served - so a single
 * unreadable value in the newest test answered 500 for every scrape until a
 * newer test landed. Prometheus reads that as the exporter being down: no
 * sample is recorded, every myspeed_* series goes stale, and the alert blames
 * the wrong thing. The route already learned this once for a null serverId;
 * what it did not learn is that null is not the only way a column arrives
 * unreadable.
 *
 * Two ways in, both real:
 *
 *   - serverId was the one numeric column importTests never checked, so
 *     PUT /api/storage/tests/history could write "auto" into it today.
 *   - Every measurement column can hold a string on a history imported before
 *     that validation existed, which createRecommendations guards against by
 *     name and this route did not.
 */
describe("metricValue", () => {
    it("passes an ordinary measurement through", () => {
        assert.equal(metricValue(12.5), 12.5);
        assert.equal(metricValue(0), 0, "zero is a measurement, not an absence");
        assert.equal(metricValue(-1), -1, "the failure placeholder is the caller's to judge");
    });

    it("refuses what a gauge cannot take", () => {
        for (const value of ["auto", "", null, undefined, NaN, Infinity, -Infinity, {}, []])
            assert.equal(metricValue(value), null, `${JSON.stringify(value)} was handed to a gauge`);
    });

    // sqlite hands a numeric column back as whatever it was given, so a legacy
    // row can carry the digits as text. That is a readable measurement, and
    // dropping the series for it would lose a metric that is really there.
    it("reads a numeric string, which is how sqlite returns an imported one", () => {
        assert.equal(metricValue("42"), 42);
        assert.equal(metricValue("0.4"), 0.4);
    });
});

/**
 * And the route sets nothing it has not read through that.
 *
 * Held as a scan rather than by firing a scrape: collect() needs a database, a
 * registry and a response, and what is asserted is only that no gauge is set
 * from a raw column - which is the property that broke.
 */
describe("the metrics route", () => {
    const collect = bodyOf(readSource("server/routes/prometheus.js"), "const collect = async");

    /*
     * Every numeric column the route reads, checked at the point it is read
     * rather than at the point it is set.
     *
     * Scanning for `someGauge.set(...)` covered one of the seven set calls in
     * this body: `timeGauge.set(labels, time)` hands over a local, and the
     * shared `measured()` helper sets through a lowercase parameter that no
     * pattern requiring a capital G can match. So the scan came back empty for
     * reasons that had nothing to do with the guard, and stayed empty with the
     * guard removed. Reading from the column end instead covers all of them,
     * because a column is the only place an unreadable value can enter.
     */
    const NUMERIC_COLUMNS = ["ping", "jitter", "download", "upload", "time",
        "serverId", "packetLoss", "downloadLatency", "uploadLatency"];

    it("reads every numeric column through the check", () => {
        for (const column of NUMERIC_COLUMNS) {
            // Wide enough to hold "measured(downloadLatencyGauge, ", the
            // longest way a column legitimately reaches a gauge.
            const reads = [...collect.matchAll(new RegExp(`(.{0,40})latest\\.${column}\\b`, "g"))];

            for (const [, before] of reads)
                assert.ok(/metricValue\($/.test(before) || /measured\(\w+, $/.test(before),
                    `latest.${column} reaches a gauge unchecked, which throws for anything but a number`);
        }
    });

    // And the helper the scan above accepts on trust, which is the one place
    // six of the seven gauges are set from. Without this, dropping metricValue
    // from inside it restores the throw for every measurement at once.
    it("checks the value inside the helper the measurements share", () => {
        assert.match(collect, /const measured = \([^)]*\) => \{[^}]*metricValue\(/,
            "the shared gauge setter no longer checks what it is given");
    });

    it("still reports the failure placeholder rather than dropping the scrape", () => {
        assert.match(collect, /testFailedGauge\.set\(labels, 1\)/,
            "a failed test no longer reports as failed");
    });
});

/**
 * The other half of the same widening, which was left behind.
 *
 * metricValue was taught to read a numeric string because that is what an
 * imported history holds - and isFailedTest, the partner that decides whether
 * those numbers are measurements at all, still compared with === against the
 * number -1. So exactly the rows the widening admitted walked past the
 * failed-test branch: the scrape published myspeed_test_failed 0 and then
 * myspeed_ping -1 beside it, a line delivering minus one megabit recorded as a
 * healthy sample. Before the widening that scrape 500'd, which was wrong but
 * was at least visibly wrong.
 *
 * The predicate reads its columns the same way the gauges do. Every other
 * reader of a stored row gains the same answer, which is the point: the client,
 * the status route and the statistics all judge these rows too.
 */
describe("a failure imported as text", () => {
    const asText = {ping: "-1", download: "-1", upload: "-1", error: null};

    it("is still a failure", () => {
        assert.equal(isFailedTest(asText), true,
            "an imported failure reports its placeholders as measurements");
        assert.equal(isSuccessfulTest(asText), false);
    });

    it("does not make a success out of a mixed row", () => {
        // One real reading is enough to keep the row, exactly as it is for a
        // row stored as numbers - the widening must not change that judgement,
        // only the spelling it accepts.
        assert.equal(isFailedTest({...asText, download: "480.2"}), false);
        assert.equal(isFailedTest({ping: -1, download: 480.2, upload: -1, error: null}), false);
    });

    it("leaves a row it cannot read alone", () => {
        // "auto" is not -1 and not a measurement either; nothing here should
        // promote an unreadable column into a placeholder.
        assert.equal(isFailedTest({ping: "auto", download: "auto", upload: "auto", error: null}), false);
        assert.equal(isFailedTest({ping: "", download: "", upload: "", error: null}), false);
    });
});
