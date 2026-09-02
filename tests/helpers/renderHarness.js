import { JSDOM, VirtualConsole } from "jsdom";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import i18next from "i18next";
import { initReactI18next } from "react-i18next";
import english from "../../client/public/assets/locales/en.json" with { type: "json" };

/**
 * A document for a component to run in, and the few verbs a test needs to
 * drive it.
 *
 * jsdom rather than the hand-built DOM in modalDom.js, and jsdom rather than
 * happy-dom, for one reason: the regressions this suite has actually shipped
 * were about focus - where it lands when a menu closes over the control
 * holding it, whether a hidden element can take it back - and jsdom's focus
 * model is the faithful one. It knows a disabled button is not a focusable
 * area, that a hidden element still counts as connected, and it moves
 * activeElement the way a browser does. That is the exact ground the ghosts in
 * REVIEW_1.3.5.md stood on.
 *
 * What it is not is a browser. Nothing here has a layout, so a clipped label,
 * a wrong font or an overlapping row - the visual class of bug - is invisible
 * to every test built on this, and the preview stays the only check for those.
 * Tests here are for logic, state and focus, which is why the helpers stop at
 * hooks, contexts and menus rather than pages.
 *
 * One document per process, installed at import. Components read `document`
 * and `window` as globals, React DOM reads them at module load, and a test
 * file is one process under node --test - so the world is set up once and each
 * test empties it rather than rebuilding it.
 */

// Navigation is what an <a download> click asks for, and jsdom does not
// implement it: it reports the fact through its virtual console as an error
// and carries on, which is the right outcome and the wrong noise.
const virtualConsole = new VirtualConsole();
virtualConsole.forwardTo(console, {jsdomErrors: "none"});

const dom = new JSDOM("<!doctype html><html><body></body></html>",
    {url: "http://localhost/", pretendToBeVisual: true, virtualConsole});

const {window} = dom;

// Everything a component or React DOM reaches for as a bare global. Defined
// rather than assigned, because node already owns a `navigator` and a
// `localStorage` of its own on the global, and neither of them is jsdom's.
for (const name of ["window", "document", "navigator", "localStorage", "sessionStorage",
    "HTMLElement", "HTMLInputElement", "HTMLButtonElement", "HTMLAnchorElement", "SVGElement",
    "Element", "Node", "Text", "DocumentFragment", "Event", "CustomEvent", "KeyboardEvent",
    "MouseEvent", "FocusEvent", "InputEvent", "MutationObserver", "getComputedStyle",
    "requestAnimationFrame", "cancelAnimationFrame"])
    Object.defineProperty(globalThis, name, {value: window[name], configurable: true, writable: true});

// What a browser hands an export: a URL for the blob it just built. jsdom
// implements neither, and the export's own code needs both.
window.URL.createObjectURL = () => "blob:jsdom";
window.URL.revokeObjectURL = () => undefined;

// Tells React that act() is in charge of flushing, so a state update outside
// one is a warning rather than a silent difference in timing.
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

/*
 * The real English strings, so a test can find a control by the text a reader
 * sees. Synchronous: i18next only defers init when it has a backend to wait
 * for, and this has the resources in hand. Not client/src/i18n.js, which wires
 * the language detector, the HTTP backend and the flag images - three things
 * a document with no server behind it cannot use.
 */
// Registered with react-i18next as well, for the components that translate
// through <Trans> and useTranslation rather than the bare t().
i18next.use(initReactI18next).init({
    lng: "en",
    fallbackLng: "en",
    resources: {en: {translation: english}},
    interpolation: {escapeValue: false},
    initImmediate: false
});

const mounted = new Set();

/**
 * Renders an element into the document, inside act, and hands back the
 * container and a way to take it down again.
 */
export const render = (element) => {
    const container = window.document.createElement("div");
    window.document.body.appendChild(container);

    const root = createRoot(container);
    act(() => root.render(element));

    const mount = {
        container,
        unmount: () => {
            act(() => root.unmount());
            container.remove();
            mounted.delete(mount);
        }
    };
    mounted.add(mount);

    return mount;
};

/** Takes down everything render() put up, for an afterEach. */
export const cleanup = () => {
    for (const mount of [...mounted]) mount.unmount();
    window.document.body.innerHTML = "";
};

/**
 * The events a reader produces, dispatched the way a browser would - bubbling
 * from the element, so React's root listener sees them - and inside act, so
 * the render they cause has happened by the time the call returns.
 */
export const click = (element) => act(() => {
    element.dispatchEvent(new window.MouseEvent("mousedown", {bubbles: true, cancelable: true}));
    element.dispatchEvent(new window.MouseEvent("mouseup", {bubbles: true, cancelable: true}));
    element.dispatchEvent(new window.MouseEvent("click", {bubbles: true, cancelable: true}));
});

export const keydown = (element, key) => act(() => {
    element.dispatchEvent(new window.KeyboardEvent("keydown", {key, bubbles: true, cancelable: true}));
});

export const focus = (element) => act(() => element.focus());

/**
 * Lets everything already scheduled run: resolved promises, effects, and the
 * timers that fire within the wait. For a flow that awaits a stubbed request
 * before it renders again.
 */
export const settle = (ms = 0) => act(() => new Promise((resolve) => setTimeout(resolve, ms)));

/** The element holding focus, or null for the body - what a reader is on. */
export const focused = () => {
    const active = window.document.activeElement;
    return active === window.document.body ? null : active;
};

export { act, createElement, window };
