/**
 * How a line chart should draw its points for a given series length.
 *
 * The charts used a fixed radius of 3 whenever they were not the small card on
 * the overview. That is right for a few hundred points and wrong for a thousand:
 * the markers touch, merge into a band, and hide the line they are meant to
 * annotate. Since the detail view can now ask for far more points than the
 * default, the style has to follow the data rather than the layout.
 */
export const DENSE_SERIES_THRESHOLD = 400;

const COMPACT = {radius: 0, hoverRadius: 0};

// The dots go, but hovering still has to land on something - that is the whole
// reason to open the detail view at this resolution.
const DENSE = {radius: 0, hoverRadius: 4};

const NORMAL = {radius: 3, hoverRadius: 6};

export const pointStyleFor = (pointCount, {compact = false} = {}) => {
    if (compact) return COMPACT;

    return pointCount > DENSE_SERIES_THRESHOLD ? DENSE : NORMAL;
};

/**
 * Spline tension for a given series length.
 *
 * At high resolution the samples are close enough together that a curve through
 * them invents overshoot the measurement never had, which reads as detail.
 */
export const lineTensionFor = (pointCount) => pointCount > DENSE_SERIES_THRESHOLD ? 0.1 : 0.35;

// What a reading with no drawn neighbour is given so it stays on screen -
// the NORMAL radius, because it is the one dot standing in for a line.
const LONE_POINT_RADIUS = 3;

/**
 * The per-point radius for a series whose gaps are honest.
 *
 * With spanGaps off, a reading between two nulls has no line segment left -
 * so at the radius-0 densities it was literally invisible: one successful
 * test in a bad hour, gone from the chart. It gets a dot; everything else
 * keeps the density's own radius, the gap points included, which chart.js
 * skips anyway.
 */
export const lonePointRadius = ({radius}) => (context) => {
    const data = context.dataset?.data ?? [];
    const y = (entry) => (entry && typeof entry === "object" ? entry.y : entry);

    if (y(data[context.dataIndex]) == null) return radius;

    const before = context.dataIndex > 0 ? y(data[context.dataIndex - 1]) : null;
    const after = context.dataIndex < data.length - 1 ? y(data[context.dataIndex + 1]) : null;

    return before == null && after == null ? Math.max(radius, LONE_POINT_RADIUS) : radius;
};
