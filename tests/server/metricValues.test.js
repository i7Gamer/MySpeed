import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { bodyOf, readSource } from "../helpers/source.js";
import { metricValue } from "../../server/util/metricValue.js";

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

    it("sets every gauge from a checked value", () => {
        const raw = [...collect.matchAll(/(\w+Gauge)\.set\(([^)]*)\)/g)]
            .filter(([, , args]) => /latest\.\w+/.test(args) && !args.includes("metricValue("));

        assert.deepEqual(raw.map(([, gauge]) => gauge), [],
            "a gauge is set straight from a stored column, which throws for anything but a number");
    });

    it("still reports the failure placeholder rather than dropping the scrape", () => {
        assert.match(collect, /testFailedGauge\.set\(labels, 1\)/,
            "a failed test no longer reports as failed");
    });
});
