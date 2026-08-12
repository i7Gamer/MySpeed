import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { crosshairPlugin } from "../../client/src/pages/Statistics/crosshairPlugin.js";

/**
 * The dashed vertical line drawn through the hovered point.
 *
 * It read `chart.tooltip._active[0].element.x` and `chart.scales.y.top` with no
 * guard on either. Both are reachable as undefined: `_active` is Chart.js
 * internal state that survives a dataset swap by a frame or two, so an element
 * can be gone while the entry that pointed at it is still in the list, and
 * `scales.y` only exists on a chart that has an axis by that name. afterDraw
 * runs inside Chart.js's own render loop, so a throw there is not contained -
 * it takes the frame down and the chart stops repainting.
 *
 * Changing the range while the pointer is over the chart is the ordinary way to
 * hit this.
 */
const canvasStub = () => {
    const calls = [];

    return {
        calls,
        save() { calls.push(["save"]); },
        restore() { calls.push(["restore"]); },
        beginPath() { calls.push(["beginPath"]); },
        setLineDash(pattern) { calls.push(["setLineDash", pattern]); },
        moveTo(x, y) { calls.push(["moveTo", x, y]); },
        lineTo(x, y) { calls.push(["lineTo", x, y]); },
        stroke() { calls.push(["stroke"]); }
    };
};

const chartWith = ({active, scales = {y: {top: 10, bottom: 200}}} = {}) => ({
    ctx: canvasStub(),
    tooltip: active === undefined ? undefined : {_active: active},
    scales
});

const drew = (chart) => chart.ctx.calls.some(([name]) => name === "stroke");

describe("the crosshair plugin", () => {
    it("draws a line through the hovered point, spanning the y axis", () => {
        const chart = chartWith({active: [{element: {x: 42}}]});

        crosshairPlugin.afterDraw(chart);

        assert.ok(drew(chart), "nothing was drawn for a perfectly ordinary hover");
        assert.deepEqual(chart.ctx.calls.find(([name]) => name === "moveTo"), ["moveTo", 42, 10]);
        assert.deepEqual(chart.ctx.calls.find(([name]) => name === "lineTo"), ["lineTo", 42, 200]);
    });

    it("leaves the canvas balanced", () => {
        const chart = chartWith({active: [{element: {x: 42}}]});

        crosshairPlugin.afterDraw(chart);

        const saves = chart.ctx.calls.filter(([name]) => name === "save").length;
        const restores = chart.ctx.calls.filter(([name]) => name === "restore").length;

        assert.equal(saves, restores, "the canvas state was saved without being restored");
    });

    it("draws nothing when nothing is hovered", () => {
        for (const active of [[], undefined])
            assert.doesNotThrow(() => crosshairPlugin.afterDraw(chartWith({active})));
    });

    it("draws nothing when there is no tooltip at all", () => {
        assert.doesNotThrow(() => crosshairPlugin.afterDraw({ctx: canvasStub(), scales: {}}));
    });

    describe("state that is mid-update", () => {
        it("survives an active entry whose element has gone", () => {
            const chart = chartWith({active: [{}]});

            assert.doesNotThrow(() => crosshairPlugin.afterDraw(chart));
            assert.equal(drew(chart), false);
        });

        it("survives an element with no x yet", () => {
            const chart = chartWith({active: [{element: {}}]});

            assert.doesNotThrow(() => crosshairPlugin.afterDraw(chart));
            assert.equal(drew(chart), false);
        });

        it("survives a chart with no y axis", () => {
            const chart = chartWith({active: [{element: {x: 42}}], scales: {}});

            assert.doesNotThrow(() => crosshairPlugin.afterDraw(chart));
            assert.equal(drew(chart), false);
        });

        it("survives no scales at all", () => {
            const chart = {ctx: canvasStub(), tooltip: {_active: [{element: {x: 42}}]}};

            assert.doesNotThrow(() => crosshairPlugin.afterDraw(chart));
        });
    });

    /**
     * x is a coordinate, and 0 is the left edge - a real position that a
     * falsiness check would have discarded.
     */
    it("draws at the very left edge", () => {
        const chart = chartWith({active: [{element: {x: 0}}]});

        crosshairPlugin.afterDraw(chart);

        assert.ok(drew(chart), "a point at x=0 was treated as a missing coordinate");
    });
});
