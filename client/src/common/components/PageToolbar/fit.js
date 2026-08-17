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
 *
 * The bar's own drop was the last figure left, at 900px, and it was wrong in
 * both directions for the same reason the label figures were. A read-only
 * visitor gets no start button - the component renders nothing rather than
 * offering a control that would answer 401 - and /status withholds the schedule
 * from them, so their bar is one short line beside two controls and was being
 * stacked some 400px before the row ran out. The other way: a custom range
 * prints two dates in a 300px trigger, and at 950px the bar was squeezed
 * instead of stacked. It is a stage of the walk now, like the rest.
 */

/**
 * The stages the toolbar can be drawn at, widest first.
 *
 * The bar stacks first, because it is the one step that costs no information:
 * every control and every label survives it, and the bar reads exactly as it
 * did with a whole row to itself. It also hands the top line its full width
 * back, so a stage that gave up a word before it would be paying for room it
 * was about to be given.
 *
 * Then the words. The export goes before the start button because it is the
 * secondary action - the start button is what these pages are for, and a bare
 * gauge does not say "start a test". That is the order the two media queries
 * had, kept.
 *
 * Cumulative rather than exclusive: everything after "wrap" stacks the bar too,
 * so the ladder only ever takes things away.
 */
export const TOOLBAR_STAGES = ["none", "wrap", "export", "all"];

/** The controls that share the row, in the order they are drawn. */
export const TOOLBAR_CONTROLS = [".date-range-picker", ".start-test", ".export-button-container"];
