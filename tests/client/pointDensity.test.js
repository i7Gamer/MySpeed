import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
    DENSE_SERIES_THRESHOLD, lineTensionFor, pointStyleFor
} from "../../client/src/pages/Statistics/charts/pointDensity.js";

describe("pointStyleFor", () => {
    describe("the small card on the overview", () => {
        it("draws no points at all, whatever the series length", () => {
            for (const count of [0, 10, 300, 1000])
                assert.deepEqual(pointStyleFor(count, {compact: true}), {radius: 0, hoverRadius: 0});
        });
    });

    describe("the detail view", () => {
        it("draws visible points for an ordinary series", () => {
            assert.deepEqual(pointStyleFor(300), {radius: 3, hoverRadius: 6});
            assert.deepEqual(pointStyleFor(DENSE_SERIES_THRESHOLD), {radius: 3, hoverRadius: 6});
        });

        // At a thousand points the markers touch and become a band that hides
        // the line underneath.
        it("hides the points once the series is dense", () => {
            assert.equal(pointStyleFor(DENSE_SERIES_THRESHOLD + 1).radius, 0);
            assert.equal(pointStyleFor(1000).radius, 0);
        });

        // Hovering still has to land on something, or the extra resolution is
        // unreadable.
        it("keeps a hover target when the points are hidden", () => {
            assert.ok(pointStyleFor(1000).hoverRadius > 0);
        });

        it("defaults to the non-compact style when no options are given", () => {
            assert.deepEqual(pointStyleFor(10), pointStyleFor(10, {}));
        });
    });
});

describe("lineTensionFor", () => {
    it("keeps the familiar curve for an ordinary series", () => {
        assert.equal(lineTensionFor(300), 0.35);
        assert.equal(lineTensionFor(DENSE_SERIES_THRESHOLD), 0.35);
    });

    // A spline through closely spaced samples overshoots between them, which
    // reads as measurements that were never taken.
    it("flattens the curve once the samples are close together", () => {
        assert.ok(lineTensionFor(DENSE_SERIES_THRESHOLD + 1) < 0.35);
        assert.ok(lineTensionFor(1000) < 0.35);
    });

    it("never goes negative, which would loop the line back on itself", () => {
        for (const count of [0, 500, 5000]) assert.ok(lineTensionFor(count) >= 0);
    });
});
