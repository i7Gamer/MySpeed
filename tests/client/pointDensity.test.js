import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import {
    DENSE_SERIES_THRESHOLD, lineTensionFor, lonePointHoverRadius, lonePointRadius, pointStyleFor
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

/**
 * A gap in the data is a gap on the screen.
 *
 * The server goes to lengths to emit null exactly where nothing was measured -
 * a failed test, a latency nobody took - and `spanGaps: true` then drew the
 * line straight across it: an outage rendered as a continuous curve, and a
 * bufferbloat reading interpolated over the tests that never measured one.
 */
describe("what the line does at a gap", () => {
    const read = (file) => fs.readFileSync(
        fileURLToPath(new URL(`../../client/src/pages/Statistics/charts/${file}`, import.meta.url)),
        "utf8");

    it("breaks rather than bridging it", () => {
        for (const file of ["SpeedChart/SpeedChart.jsx", "PingChart.jsx"])
            assert.doesNotMatch(read(file), /spanGaps: true/,
                `${file} draws a line across the very nulls the server emits for an outage`);
    });

    /**
     * A reading between two gaps has no line segment left once the gaps are
     * honest, so at the radius-0 densities it was literally invisible - one
     * successful test in a bad hour, gone from the chart. It gets a dot.
     */
    it("gives a reading with no drawn neighbour a visible dot", () => {
        for (const file of ["SpeedChart/SpeedChart.jsx", "PingChart.jsx"]) {
            assert.match(read(file), /pointRadius: lonePointRadius\(pointStyle\)/,
                `${file} hides a lone reading at the densities that draw no points`);
            assert.match(read(file), /pointHoverRadius: lonePointHoverRadius\(pointStyle\)/,
                `${file}'s lone dots vanish under the crosshair on the compact cards`);
        }
    });
});

describe("lonePointRadius", () => {
    const dense = {radius: 0, hoverRadius: 4};
    const normal = {radius: 3, hoverRadius: 6};
    const compact = {radius: 0, hoverRadius: 0};

    const at = (data, index) => ({dataset: {data}, dataIndex: index});
    const point = (y) => ({x: 1, y});

    it("keeps the configured radius while the line connects", () => {
        const data = [point(1), point(2), point(3)];

        assert.equal(lonePointRadius(dense)(at(data, 1)), 0);
        assert.equal(lonePointRadius(normal)(at(data, 1)), 3);
    });

    it("makes a reading between two gaps visible", () => {
        const data = [point(null), point(2), point(null)];

        assert.ok(lonePointRadius(dense)(at(data, 1)) > 0,
            "the one successful test in a bad hour is invisible");
    });

    /**
     * Smaller than the ordinary dot, deliberately. The radius-0 densities
     * exist because markers merge into a band that hides the line - and a
     * sparse series makes *every* drawn point lone (the loaded-latency line
     * is null wherever a provider measured neither direction), so a lone dot
     * at full size would repaint the very band those densities removed.
     */
    it("keeps the lone dot below the ordinary one at the dense densities", () => {
        const data = [point(null), point(2), point(null)];

        assert.ok(lonePointRadius(dense)(at(data, 1)) < normal.radius,
            "a fragmented dense series is a band of full-size dots again");
    });

    // The edges have one neighbour each; a missing one counts as a gap.
    it("treats the ends of the series as gaps", () => {
        assert.ok(lonePointRadius(dense)(at([point(5)], 0)) > 0);
        assert.ok(lonePointRadius(dense)(at([point(5), point(null)], 0)) > 0);
        assert.equal(lonePointRadius(dense)(at([point(5), point(6)], 0)), 0,
            "a series edge with a drawn neighbour needs no dot");
    });

    it("draws nothing for the gap itself", () => {
        const data = [point(null), point(2), point(null)];

        assert.equal(lonePointRadius(dense)(at(data, 0)), 0);
        assert.equal(lonePointRadius(dense)(at(data, 2)), 0);
    });

    // A visible configured radius stays as it is - a lone dot must not shrink.
    it("never shrinks a radius that was already visible", () => {
        const data = [point(null), point(2), point(null)];

        assert.equal(lonePointRadius(normal)(at(data, 1)), 3);
    });
});

/**
 * The hover radius has to keep up. pointRadius became scriptable and
 * pointHoverRadius stayed the scalar style, so on the compact cards -
 * hoverRadius 0, and an interaction mode that activates every index the
 * crosshair passes - a lone dot painted at rest and vanished the moment the
 * pointer reached it: dots blinking on and off along the sweep.
 */
describe("lonePointHoverRadius", () => {
    const compact = {radius: 0, hoverRadius: 0};
    const dense = {radius: 0, hoverRadius: 4};

    const at = (data, index) => ({dataset: {data}, dataIndex: index});
    const point = (y) => ({x: 1, y});
    const lonely = [point(null), point(2), point(null)];

    it("never lets a hovered lone dot shrink below its resting size", () => {
        const resting = lonePointRadius(compact)(at(lonely, 1));

        assert.ok(lonePointHoverRadius(compact)(at(lonely, 1)) >= resting,
            "the lone dot vanishes the moment the crosshair reaches it");
    });

    it("keeps the configured hover radius everywhere else", () => {
        const data = [point(1), point(2), point(3)];

        assert.equal(lonePointHoverRadius(dense)(at(data, 1)), 4);
        assert.equal(lonePointHoverRadius(compact)(at(data, 1)), 0);
    });

    it("keeps a hover radius that was already larger", () => {
        assert.equal(lonePointHoverRadius(dense)(at(lonely, 1)), 4);
    });
});
