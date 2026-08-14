/**
 * The stored preference values.
 *
 * Kept apart from the provider so a plain utility can read them without pulling
 * a React component - and its whole JSX dependency - along with it. FormatUtil
 * needed exactly that, which is why it had no tests.
 */
export const TIME_FORMAT_24H = "24h";
export const TIME_FORMAT_12H = "12h";

export const SPEED_UNIT_MBPS = "mbps";
export const SPEED_UNIT_MBYTES = "mbytes";

/**
 * Whether a reading states its grade twice - on its glyph and on the figure
 * itself.
 *
 * Stamped on the document rather than passed to a component, because it answers
 * for every view at once: the overview rows, the node cards, the statistics
 * panels and the detail pane all publish the grade on the row and let their
 * parts read it. The stylesheets do the rest - see the graded-value mixin.
 */
export const GRADE_VALUES_ATTRIBUTE = "data-grade-values";
export const GRADE_VALUES_ON = "on";
export const GRADE_VALUES_OFF = "off";
