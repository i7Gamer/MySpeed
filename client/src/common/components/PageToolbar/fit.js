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
 * measured instead, and the answer falls out of the measurement: when the
 * status bar drops, the top line grows and the labels come back by themselves.
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

/**
 * Whether the controls have broken onto more than one line.
 *
 * Read off their top edges rather than by adding up widths: the row is a flex
 * container that already knows how to lay itself out, and the sum of the
 * natural widths is not something a laid-out row can be asked for - the picker
 * grows to fill whatever line it lands on, so its rendered width says nothing
 * about what it wanted.
 *
 * A control that is not on screen is null and is not counted. The start button
 * renders nothing at all for a read-only visitor, which used to need a rule of
 * its own in the stylesheet; here it is simply one fewer thing to fit.
 */
export const controlsWrapped = (tops) =>
    new Set(tops.filter((top) => typeof top === "number")).size > 1;

/**
 * The next stage to try, or null when there is nothing narrower left.
 *
 * The caller walks these in order, applying each and measuring, and stops at
 * the first that holds one line - so the labels are kept for as long as there
 * is room for them and given up one at a time.
 */
export const nextStage = (stage) => TOOLBAR_STAGES[TOOLBAR_STAGES.indexOf(stage) + 1] ?? null;
