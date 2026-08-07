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
