/**
 * The dashed vertical line drawn through the hovered point.
 *
 * Both reads used to be unguarded, and both are reachable as undefined:
 * `tooltip._active` is Chart.js internal state that outlives a dataset swap by
 * a frame or two, so an entry can still point at an element that has gone, and
 * `scales.y` only exists on a chart that has an axis by that name. afterDraw
 * runs inside Chart.js's own render loop, so a throw here is not contained - it
 * takes the frame with it and the chart stops repainting. Changing the range
 * while the pointer is over the chart is the ordinary way to arrive at that.
 *
 * Lives apart from Statistics.jsx so it can be exercised against a stubbed
 * canvas rather than a rendered chart.
 */
const CROSSHAIR_COLOUR = 'hsla(215, 20%, 65%, 0.6)';
const DASH_PATTERN = [5, 5];
const LINE_WIDTH = 1;

export const crosshairPlugin = {
    id: 'crosshair',
    afterDraw: (chart) => {
        if (!chart?.tooltip?._active?.length) return;

        // Compared against undefined rather than tested for truthiness: x is a
        // coordinate, and 0 is the left edge of the canvas - a real position.
        const x = chart.tooltip._active[0]?.element?.x;
        const yScale = chart.scales?.y;

        if (x === undefined || !yScale) return;

        const ctx = chart.ctx;

        ctx.save();
        ctx.beginPath();
        ctx.setLineDash(DASH_PATTERN);
        ctx.moveTo(x, yScale.top);
        ctx.lineTo(x, yScale.bottom);
        ctx.lineWidth = LINE_WIDTH;
        ctx.strokeStyle = CROSSHAIR_COLOUR;
        ctx.stroke();
        ctx.restore();
    }
};
