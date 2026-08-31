import {useEffect, useState} from "react";
import {watchMediaQuery} from "@/common/contexts/Theme/mediaQuery";

/**
 * Whether the machine is pointed at with a finger.
 *
 * It decides which time picker a reader gets: touch keeps the operating
 * system's wheel, which is a better picker than anything drawn in a page, and a
 * mouse gets the app's, because the popup the browser draws there is in the
 * OS's voice and no stylesheet can reach it.
 *
 * `(pointer: coarse)` rather than a width breakpoint, which is the tempting
 * wrong answer - a tablet has a coarse pointer at desktop width and wants the
 * wheel, and a narrow desktop window has a fine pointer and wants the drawn
 * one. Width would have got both backwards.
 */
export const COARSE_QUERY = "(pointer: coarse)";

/**
 * The machine's answer, or the drawn picker where it cannot be asked.
 *
 * matchMedia is absent in a few embedded webviews - the same ones ThemeContext
 * already guards for, and the sort a wall-mounted dashboard runs. Answering
 * "coarse" there would put an unstyled native picker on a desktop; the drawn
 * one is buttons and works under a finger too, so the fallback is the one that
 * is merely not ideal rather than the one that is wrong.
 *
 * Takes the window rather than reaching for it, so it can be asked a question
 * without one.
 */
export const hasCoarsePointer = (view = typeof window === "undefined" ? undefined : window) =>
    typeof view?.matchMedia === "function" ? view.matchMedia(COARSE_QUERY).matches : false;

export const useCoarsePointer = () => {
    // Read during render, not in an effect: an effect runs after the children
    // have rendered, so the first frame would draw one picker and swap it for
    // the other - on touch, an OS wheel appearing a frame after a text field
    // the reader had already tapped.
    const [coarse, setCoarse] = useState(() => hasCoarsePointer());

    useEffect(() => {
        if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;

        // Through the shim for the reason ThemeContext uses it: Safari before 14
        // implements MediaQueryList without addEventListener, and subscribing
        // directly threw out of the effect and took the tree with it.
        return watchMediaQuery(window.matchMedia(COARSE_QUERY), (event) => setCoarse(event.matches));
    }, []);

    return coarse;
};
