/**
 * The toast element's class list, computed from state alone.
 *
 * close() used to reach past React and add `toast-hidden` to the live DOM node,
 * while the same element's className was also being computed from state on
 * every render. React diffs a prop against the value it last rendered, not
 * against the DOM - so when the next toast arrived before the moveOut animation
 * had finished, the className it computed was identical to the one React
 * believed was already there, React skipped the write, and the hand-added
 * `toast-hidden` survived. The toast fired, the timer ran, the state was
 * correct, and nothing appeared on screen.
 *
 * One writer, so there is nothing for the two to disagree about.
 */
export const TOAST_HIDDEN = "toast-hidden";

export const toastClassName = (toast, visible) => {
    const classes = ["toast-notification"];

    if (!toast || !visible) classes.push(TOAST_HIDDEN);

    // Only when there is one: the old expression appended `" toast-" +
    // toast?.color` unconditionally, so an empty element carried a
    // `toast-undefined` that matches no rule in the stylesheet.
    if (toast?.color) classes.push(`toast-${toast.color}`);

    return classes.join(" ");
};
