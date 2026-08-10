import {useEffect, useRef} from "react";

/**
 * Whether a click landed outside every one of the given elements.
 *
 * Null entries are refs that have nothing mounted, which cannot contain a
 * click. Exported on its own so the judgement is testable without a DOM.
 */
export const clickLandsOutside = (target, elements) =>
    elements.every((element) => !element || !element.contains(target));

/**
 * Calls `onOutside` for any mousedown that lands outside the given refs.
 *
 * Four popovers used to register their own document-level listener, each with
 * a slightly different version of this rule - and the dropdown's walked
 * event.composedPath() by fixed depth to find its opener, which breaks the
 * moment a wrapper element appears in between. `ignore` covers that opener
 * case: a predicate on the event target for clicks that must not count as
 * outside even though no ref holds them.
 *
 * `active` gates the listener entirely, so a closed popover costs nothing.
 * Everything else is read through a ref, which keeps the listener stable
 * across renders without asking callers to memoise their arguments.
 */
export const useClickOutside = (active, refs, onOutside, {ignore} = {}) => {
    const latest = useRef({refs, onOutside, ignore});
    latest.current = {refs, onOutside, ignore};

    useEffect(() => {
        if (!active) return;

        const onMouseDown = (event) => {
            const {refs, onOutside, ignore} = latest.current;

            if (ignore?.(event.target)) return;
            if (clickLandsOutside(event.target, refs.map((ref) => ref.current))) onOutside(event);
        };

        document.addEventListener("mousedown", onMouseDown);
        return () => document.removeEventListener("mousedown", onMouseDown);
    }, [active]);
};
