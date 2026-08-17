/**
 * Whether a keypress chose a selectable option, having chosen it.
 *
 * Space is what a radio actually answers to and Enter is the one people try, so
 * both do. Nothing else is touched - Tab in particular has to keep moving
 * through the list, or a focusable row becomes a trap - and the key is claimed
 * only when it was acted on, so an unhandled one still reaches the dialog's own
 * Escape and Enter handlers.
 *
 * In a plain module rather than beside the component: the test runner does not
 * compile JSX, so a rule living in the .jsx file could only be asserted on as
 * text. The filename deliberately does not differ from its neighbour's by case
 * alone - a lowercase twin of a component file resolves on Linux and not on
 * Windows, and takes the vite build down with an error that names neither.
 */
export const activateOnKey = (event, onClick) => {
    if (event.key !== "Enter" && event.key !== " ") return false;

    // Or Space scrolls the dialog out from under the option it just selected.
    event.preventDefault();
    onClick?.();
    return true;
};
