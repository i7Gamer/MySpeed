/**
 * How the toolbar decides to give up its labels.
 *
 * It used to be two viewport media queries - 480px for the export's label,
 * 368px for the start button's - measured with a preset selected, where the
 * range trigger reads "All time" and is 126px wide. A custom range says its two
 * dates instead and is 300px, so the row ran out 220px before the viewport
 * reached either figure: measured, the controls broke onto separate lines at
 * 660px and kept both labels until 480.
 *
 * A viewport cannot answer the question being asked, which is whether these
 * particular controls fit this particular row - and that depends on the
 * selected range, on the translation, and on whether the status bar has already
 * dropped to a line of its own and handed its width back. So the row is
 * measured instead - useFitStages walks the stages below, applying each and
 * keeping the first that holds one line - and the answer falls out of the
 * measurement: when the status bar drops, the top line grows and the labels
 * come back by themselves.
 */

/**
 * The stages the toolbar can be drawn at, widest first.
 *
 * The export goes first because it is the secondary action - the start button
 * is what these pages are for, and a bare gauge does not say "start a test".
 * That is the order the two media queries had, kept.
 */
export const TOOLBAR_STAGES = ["none", "export", "all"];

/** The controls that share the row, in the order they are drawn. */
export const TOOLBAR_CONTROLS = [".date-range-picker", ".start-test", ".export-button-container"];
