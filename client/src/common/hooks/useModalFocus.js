import {useEffect} from "react";

/**
 * What the browser's own Tab visits, as a selector.
 *
 * `[tabindex="-1"]` is excluded here rather than filtered below because it is
 * the one the dialog itself wears: it exists so focus can be *placed* on the
 * dialog, not so Tab can reach it.
 */
const FOCUSABLE_SELECTOR = [
    "a[href]", "button", "input", "select", "textarea", "[tabindex]"
].map((selector) => `${selector}:not([tabindex="-1"])`).join(", ");

/**
 * The controls inside `container` that a Tab would actually visit.
 *
 * Exported apart from the hook so the judgement is testable without a DOM - the
 * same split useClickOutside makes. A disabled control is skipped by the
 * browser's own Tab, and one hidden from assistive technology is not something
 * to wrap onto; counting either would send focus somewhere it never lands.
 */
export const focusableWithin = (container) =>
    [...(container?.querySelectorAll?.(FOCUSABLE_SELECTOR) ?? [])]
        .filter((element) => !element.disabled && element.getAttribute?.("aria-hidden") !== "true");

/**
 * Where Tab should put focus, or null to leave the key to the browser.
 *
 * Null is the case that matters most: a Tab in the middle of a dialog is the
 * browser's own to answer, and claiming it would mean re-implementing tab order
 * rather than closing it into a loop.
 *
 * Focus that is on none of the controls is focus that has left the dialog - or
 * has never been in it, which is exactly the state an overlay opens in when the
 * control that opened it keeps focus behind the backdrop.
 */
export const nextFocus = (container, {shiftKey} = {}, active) => {
    const focusable = focusableWithin(container);
    if (focusable.length === 0) return container ?? null;

    const first = focusable[0];
    const last = focusable[focusable.length - 1];

    if (!focusable.includes(active)) return shiftKey ? last : first;
    if (shiftKey && active === first) return last;
    if (!shiftKey && active === last) return first;

    return null;
};

/**
 * Moves focus into an overlay, keeps it there, and gives it back on close.
 *
 * Neither overlay did any of the three. Opening a settings dialog from the
 * header gear left focus on the gear: Tab walked the whole page underneath
 * before reaching the dialog, and closing it dropped focus to the top of the
 * document rather than to the control that had opened it.
 *
 * The listener sits on the dialog rather than on the document, so the overlay on
 * top is whichever one holds focus and no isTopmostOverlay question arises -
 * unlike Escape, which the document has to arbitrate because it is pressed at
 * the page level. An overlay stacked over another records the focus it found
 * inside that one, so closing the alert hands the dialog back its own control.
 *
 * Focus already inside is left alone: the input variant of an alert autoFocuses
 * its field, and moving that to the first button would put the caret nowhere.
 */
export const useModalFocus = (dialogRef, active) => {
    useEffect(() => {
        const dialog = active ? dialogRef.current : null;
        if (!dialog) return;

        const restoreTo = document.activeElement;

        if (!dialog.contains(document.activeElement))
            (focusableWithin(dialog)[0] ?? dialog).focus?.();

        const onKeyDown = (event) => {
            if (event.key !== "Tab") return;

            const target = nextFocus(dialog, event, document.activeElement);
            if (!target) return;

            event.preventDefault();
            target.focus?.();
        };

        dialog.addEventListener("keydown", onKeyDown);

        return () => {
            dialog.removeEventListener("keydown", onKeyDown);
            // Only if it is still on screen: the control that opened the overlay
            // may have been unmounted by whatever the overlay did.
            if (restoreTo?.isConnected) restoreTo.focus?.();
        };
    }, [dialogRef, active]);
};
