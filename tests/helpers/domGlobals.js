/**
 * The document the behavioural tests run in, installed as globals at import.
 *
 * Its own module, and the first thing renderHarness.js imports, because of
 * when React DOM looks: at module load it asks once whether it has a DOM -
 * `typeof window !== "undefined" && window.document` - and settles what it
 * will do about focus, selection and input events on that one answer. Static
 * imports are hoisted, so with this setup inline in the harness React DOM
 * evaluated before the globals existed, answered "no DOM", and took the
 * pre-IE9 road on every focused text field: it called attachEvent() on the
 * element, which no jsdom element has, and threw - inside a listener, on the
 * channel the harness had muted. The time picker's Escape and the input
 * alert's round trip both passed through that throw unseen until the channel
 * was recorded.
 *
 * The rest of the harness's contract - what jsdom is and is not - is on
 * renderHarness.js.
 */

import { JSDOM, VirtualConsole } from "jsdom";

/*
 * jsdom reports an exception thrown inside a DOM event listener on its own
 * error channel rather than letting it propagate through dispatchEvent - so
 * with that channel muted, a click-outside hook or an animationend handler
 * that throws passed every test it was driven through, and only a focus
 * assertion that happened to look would notice. The channel is recorded here
 * and rethrown by cleanup(), which every suite runs after each test.
 */
export const listenerErrors = [];

/**
 * jsdom raises its own capability gaps - navigation to a blob URL, layout -
 * on the same channel, tagged so. Those are what the harness knowingly does
 * without, not something a component threw, and they stay quiet.
 */
const NOT_IMPLEMENTED = "not-implemented";

const virtualConsole = new VirtualConsole();
virtualConsole.forwardTo(console, {jsdomErrors: "none"});
virtualConsole.on("jsdomError", (error) => {
    if (error?.type !== NOT_IMPLEMENTED) listenerErrors.push(error);
});

const dom = new JSDOM("<!doctype html><html><body></body></html>",
    {url: "http://localhost/", pretendToBeVisual: true, virtualConsole});

export const {window} = dom;

/**
 * The event class jsdom does not have, and React DOM checks for at load: with
 * no AnimationEvent in the window it strikes the unprefixed name from its
 * table and, finding WebkitAnimation on a style object - which jsdom's has -
 * subscribes onAnimationEnd to webkitAnimationEnd instead. Every dialog and
 * alert in this app waits for animationend before it unmounts, and the
 * tests raise that event by hand, so without this class none of them would
 * ever close. A plain Event carrying the three fields the real one does.
 */
if (!("AnimationEvent" in window)) {
    window.AnimationEvent = class AnimationEvent extends window.Event {
        constructor(type, init = {}) {
            super(type, init);
            this.animationName = init.animationName ?? "";
            this.elapsedTime = init.elapsedTime ?? 0;
            this.pseudoElement = init.pseudoElement ?? "";
        }
    };
}

/**
 * The observer jsdom does not implement, as the no-op it can honestly be here.
 *
 * useFitStages watches the toolbar to decide which of its controls still fit,
 * and constructs one in a layout effect - so a page carrying a toolbar threw
 * "ResizeObserver is not defined" the moment it mounted, before anything under
 * it rendered. A stub rather than a shim with sizes in it, because jsdom lays
 * nothing out: every box it would report is zero, and a fit decision taken from
 * that would be fiction. Nothing is ever measured, so the stages stay where
 * they start and the fitting itself remains the preview's to check.
 */
if (!("ResizeObserver" in window)) {
    window.ResizeObserver = class ResizeObserver {
        observe() {}
        unobserve() {}
        disconnect() {}
    };
}

// And the one TestArea watches its last row with, to page the next block in.
// jsdom implements neither, and only a list long enough to have a last row
// reaches it - so it went unnoticed until a test rendered a full page.
//
// Inert, like the one above: what it would do is fetch another page, and a test
// that has not asked for one should not get one. A test that wants the paging
// drives loadMoreTests itself.
if (!("IntersectionObserver" in window)) {
    window.IntersectionObserver = class IntersectionObserver {
        observe() {}
        unobserve() {}
        disconnect() {}
    };
}

// Everything a component or React DOM reaches for as a bare global. Defined
// rather than assigned, because node already owns a `navigator` and a
// `localStorage` of its own on the global, and neither of them is jsdom's.
for (const name of ["window", "document", "navigator", "localStorage", "sessionStorage",
    "HTMLElement", "HTMLInputElement", "HTMLButtonElement", "HTMLAnchorElement", "SVGElement",
    "Element", "Node", "Text", "DocumentFragment", "Event", "CustomEvent", "KeyboardEvent",
    "MouseEvent", "FocusEvent", "InputEvent", "MutationObserver", "ResizeObserver", "IntersectionObserver",
    "getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame"])
    Object.defineProperty(globalThis, name, {value: window[name], configurable: true, writable: true});

// What a browser hands an export: a URL for the blob it just built. jsdom
// implements neither, and the export's own code needs both.
window.URL.createObjectURL = () => "blob:jsdom";
window.URL.revokeObjectURL = () => undefined;
