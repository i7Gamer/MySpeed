import {useEffect, useRef} from "react";

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
 * The close control, which is never what an overlay should open on.
 *
 * Marked rather than recognised by class, so the rule says what it means and
 * does not follow the styling around.
 */
const DISMISS = "data-overlay-dismiss";

/**
 * What should take focus when an overlay opens, or null to leave it alone.
 *
 * Null when focus is already inside: the input variant of an alert autoFocuses
 * its field, and moving that to a button would put the caret nowhere.
 *
 * Never the close control, and that is the whole of why this is a function
 * rather than `focusableWithin(...)[0]`. The header comes first in both
 * overlays, so the first focusable in document order is the X - and seating
 * focus there is how an alert came to answer Enter by cancelling a
 * confirmation, since the document handler declines a key aimed at a button
 * inside the alert and the browser then clicks whatever holds focus. On a
 * Dialog it is milder and still wrong: Enter closes a settings dialog the
 * moment it opens, and a keyboard reader has to Tab past the dismiss button to
 * reach the first field.
 *
 * `preferred` is for the caller that knows better still - the alert names its
 * primary button. The X is taken only when it is the sole control there.
 */
export const initialFocusTarget = (container, preferred, active) => {
    if (container?.contains?.(active)) return null;
    if (preferred) return preferred;

    const focusable = focusableWithin(container);

    return focusable.find((element) => element.getAttribute?.(DISMISS) === null)
        ?? focusable[0] ?? container ?? null;
};

/** Every overlay's backdrop, of either kind - see isTopmostOverlay. */
const OVERLAY_AREA = ".dialog-area";

/**
 * Whether focus leaving the dialog is an escape, or something to allow.
 *
 * The Tab trap is a listener on the dialog, so it hears only keys pressed inside
 * it - which is enough while focus stays in, and focus can leave without
 * pressing anything. A mousedown on the backdrop blurs to the body, and so does
 * a control that unmounts itself. On a dialog whose backdrop click is a no-op -
 * the welcome wizard, which is also the only one with no Escape - that state was
 * permanent: the trap went inert and Tab walked the page behind a backdrop
 * advertising aria-modal.
 *
 * An overlay opened over this one is not an escape. Pulling focus back out of a
 * stacked alert would fight the alert for it.
 */
export const focusEscaped = (container, next) => {
    if (!next) return true;
    if (container?.contains?.(next)) return false;

    return !next.closest?.(OVERLAY_AREA);
};

/**
 * Moves focus into an overlay, keeps it there, and gives it back on close.
 *
 * Neither overlay did any of the three. Opening a settings dialog from the
 * header gear left focus on the gear: Tab walked the whole page underneath
 * before reaching the dialog, and closing it dropped focus to the top of the
 * document rather than to the control that had opened it.
 *
 * Being open and holding focus are two states, and only an alert is ever in one
 * without the other. So they are two effects:
 *
 *   - `open` owns the restore. Keying it on the other one handed focus back to
 *     the page the moment a second alert stacked over the first - under two
 *     backdrops, scrolling the page to reach it - and the alert above then
 *     recorded that page control as its own place to return to.
 *   - `holdsFocus` owns the seating and the trap. An alert that is stacked over
 *     has given up its turn; when the one above closes it takes its turn back,
 *     and returns focus to the control it was last on rather than to its first.
 *
 * Focus already inside is left alone: the input variant of an alert autoFocuses
 * its field, and moving that to a button would put the caret nowhere.
 */
export const useModalFocus = (dialogRef, {open, holdsFocus = open, initialFocus, restoreTo} = {}) => {
    const lastInside = useRef(null);

    useEffect(() => {
        if (!open) return;

        /*
         * Given rather than read, where the caller knows it.
         *
         * This runs as a passive effect, which is after React has already
         * applied autoFocus - so for an alert that opens on an input, reading
         * document.activeElement here answers with the alert's own field, and
         * restoring it later focuses an element that no longer exists. The alert
         * records the control it was opened from instead, at the moment it was
         * asked for.
         */
        const returnTo = restoreTo ?? document.activeElement;

        return () => {
            // Only if it is still on screen: the control that opened the overlay
            // may have been unmounted by whatever the overlay did.
            if (returnTo?.isConnected) returnTo.focus?.();
        };
        // restoreTo is read once, when the overlay opens.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [open]);

    useEffect(() => {
        const dialog = open && holdsFocus ? dialogRef.current : null;
        if (!dialog) return;

        // Where the reader was, if they have been here before - which is the
        // case an alert stacked over this one and then closed again.
        const seat = () => initialFocusTarget(dialog,
            lastInside.current?.isConnected ? lastInside.current : initialFocus?.current,
            document.activeElement)?.focus?.();

        seat();

        const onKeyDown = (event) => {
            if (event.key !== "Tab") return;

            const target = nextFocus(dialog, event, document.activeElement);
            if (!target) return;

            event.preventDefault();
            target.focus?.();
        };

        const onFocusIn = (event) => {
            if (dialog.contains(event.target)) lastInside.current = event.target;
        };

        let recovery;
        const onFocusOut = (event) => {
            if (!focusEscaped(dialog, event.relatedTarget)) return;

            // On the next turn, not now: focus is still settling during
            // focusout, and the element it is leaving for is only sometimes the
            // relatedTarget. Re-checked then, so a dialog that is closing - or
            // one focus has already come back to - is left alone.
            recovery = setTimeout(() => {
                if (dialog.isConnected && !dialog.contains(document.activeElement)) seat();
            }, 0);
        };

        dialog.addEventListener("keydown", onKeyDown);
        dialog.addEventListener("focusin", onFocusIn);
        dialog.addEventListener("focusout", onFocusOut);

        return () => {
            clearTimeout(recovery);
            dialog.removeEventListener("keydown", onKeyDown);
            dialog.removeEventListener("focusin", onFocusIn);
            dialog.removeEventListener("focusout", onFocusOut);
        };
        // initialFocus is read when the overlay takes its turn; listing it would
        // re-seat focus on every render that rebuilt the ref object.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [dialogRef, open, holdsFocus]);
};
