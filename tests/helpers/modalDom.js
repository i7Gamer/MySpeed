import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/**
 * Enough of a DOM and of React to run useModalFocus as written.
 *
 * The hook's judgement is exported in pieces and tested without any of this -
 * see modalFocus.test.js. What cannot be reached that way is the part where its
 * bugs actually lived: two effects, what their cleanups do and in which order
 * React runs them, and a recovery scheduled from a focusout. Every regression
 * this hook has had was in that seam and none of them was reachable from the
 * pure helpers.
 *
 * There is no jsdom here and no renderer, and adding either for one hook is a
 * dependency the repository does not otherwise want. So the DOM is the handful
 * of methods the hook actually calls, and React is its two hooks with the deps
 * comparison and the cleanup ordering the real one guarantees.
 */

const CLIENT_SRC = path.resolve(fileURLToPath(import.meta.url), "..", "..", "..", "client", "src");
const HOOK = path.join(CLIENT_SRC, "common", "hooks", "useModalFocus.js");

/**
 * The focusable selector, matched by hand.
 *
 * Only the compound forms the hook builds - a tag, an optional attribute, and
 * the `:not([tabindex="-1"])` every one of them carries.
 */
const parseSelector = (selector) => selector.split(",").map((part) => {
    const text = part.trim();
    const head = text.replace(/:not\([^)]*\)/g, "");
    const match = head.match(/^([a-z]*)(?:\[([a-z-]+)])?$/i);

    return {
        tag: (match?.[1] || "").toUpperCase(),
        attribute: match?.[2] || null,
        skipsNegativeTabindex: /:not\(\[tabindex="-1"]\)/.test(text)
    };
});

let activeElement = null;

class Element {
    constructor(tag, attributes = {}) {
        this.tagName = String(tag).toUpperCase();
        this.attributes = {...attributes};
        this.children = [];
        this.parent = null;
        this.listeners = {};
        this.isConnected = false;
        this.focusCount = 0;
    }

    get name() { return this.attributes.name ?? this.tagName.toLowerCase(); }
    get disabled() { return this.attributes.disabled === true; }

    append(...children) {
        for (const child of children) {
            child.parent = this;
            this.children.push(child);
            child.setConnected(this.isConnected);
        }
        return this;
    }

    remove() {
        // Read before detaching, because contains() walks upwards.
        const heldFocus = this.contains(activeElement);

        if (this.parent) this.parent.children = this.parent.children.filter((c) => c !== this);
        this.parent = null;
        this.setConnected(false);

        // A browser moves focus to the body when the focused element leaves the
        // document. Leaving activeElement pointing at a detached node is a state
        // no browser produces, and it is the one that hides the `isConnected`
        // half of the recovery's re-check: with focus still apparently inside a
        // dialog that has gone, neither conjunct ever decides anything.
        if (heldFocus) activeElement = body;
    }

    setConnected(connected) {
        this.isConnected = connected;
        this.children.forEach((child) => child.setConnected(connected));
    }

    getAttribute(name) {
        return name in this.attributes ? String(this.attributes[name]) : null;
    }

    /** Pre-order, which is document order - the order Tab follows. */
    get descendants() {
        const found = [];
        const walk = (element) => element.children.forEach((child) => {
            found.push(child);
            walk(child);
        });
        walk(this);
        return found;
    }

    contains(node) {
        let current = node;
        while (current) {
            if (current === this) return true;
            current = current.parent;
        }
        return false;
    }

    /**
     * The two shapes the hook asks for: an overlay's backdrop by class, and a
     * portalled popover by attribute.
     */
    closest(selector) {
        const attribute = selector.match(/^\[([a-z-]+)]$/)?.[1];
        const wanted = selector.replace(/^\./, "");

        let current = this;
        while (current) {
            if (attribute) {
                if (current.getAttribute(attribute) !== null) return current;
            } else if (String(current.attributes.class || "").split(/\s+/).includes(wanted)) return current;

            current = current.parent;
        }
        return null;
    }

    querySelectorAll(selector) {
        const parts = parseSelector(selector);

        return this.descendants.filter((element) => parts.some((part) => {
            if (part.tag && element.tagName !== part.tag) return false;
            if (part.attribute && element.getAttribute(part.attribute) === null) return false;
            if (!part.tag && !part.attribute) return false;
            if (part.skipsNegativeTabindex && element.getAttribute("tabindex") === "-1") return false;
            return true;
        }));
    }

    focus() {
        this.focusCount++;
        if (activeElement === this) return;

        const previous = activeElement;
        activeElement = this;
        if (previous) previous.dispatch("focusout", {relatedTarget: this});
        this.dispatch("focusin", {relatedTarget: previous});
    }

    /** What a mousedown on the backdrop does, and what unmounting a focused control does. */
    blurToBody() {
        const previous = activeElement;
        activeElement = body;
        if (previous) previous.dispatch("focusout", {relatedTarget: null});
    }

    /**
     * One event object for the whole propagation, as a browser dispatches it.
     *
     * Handing each listener its own copy makes preventDefault unobservable: it
     * sets a flag on something thrown away the moment the listener returns. A
     * trap that claimed every Tab - the state where a reader can never move off
     * the control the dialog opened on - was indistinguishable from one that
     * claimed none, because both leave focus where it was.
     */
    dispatch(type, init = {}) {
        const event = {
            ...init,
            type,
            target: this,
            currentTarget: null,
            defaultPrevented: false,
            preventDefault() { this.defaultPrevented = true; }
        };

        let current = this;
        while (current) {
            event.currentTarget = current;
            (current.listeners[type] || []).slice().forEach((listener) => listener(event));
            current = current.parent;
        }

        return event;
    }

    /** Returns the event, so a test can ask whether the key was claimed. */
    press(key, init = {}) {
        return this.dispatch("keydown", {key, ...init});
    }

    addEventListener(type, listener) { (this.listeners[type] ||= []).push(listener); }

    removeEventListener(type, listener) {
        this.listeners[type] = (this.listeners[type] || []).filter((l) => l !== listener);
    }
}

export const body = new Element("body", {class: "body"});
body.isConnected = true;
activeElement = body;

globalThis.document = {
    get activeElement() { return activeElement; },
    body
};

export const element = (tag, attributes) => new Element(tag, attributes);
export const activeName = () => (activeElement ? activeElement.name : String(activeElement));
export const active = () => activeElement;
export const mount = (node) => { body.append(node); return node; };

/**
 * Lets a real timer run. The hook schedules its recovery with setTimeout(…, 0)
 * and the cleanup clears it, so nothing here is faked - waiting a turn is what
 * tells the two apart.
 */
export const settle = () => new Promise((resolve) => setTimeout(resolve, 1));

/** Each scenario gets an empty page: a left-over overlay keeps live listeners. */
export const resetWorld = () => {
    body.children.slice().forEach((child) => child.remove());
    activeElement = body;
};

/* ------------------------------------------------------------------- react  */

let rendering = null;
let pendingEffects = [];

globalThis.__modalFocusReact = {
    useRef(initial) {
        const slots = rendering.slots;
        if (rendering.cursor >= slots.length) slots.push({current: initial});
        return slots[rendering.cursor++];
    },
    useEffect(effect, deps) { pendingEffects.push({effect, deps}); }
};

/**
 * The hook, loaded with its react import swapped for the shim above.
 *
 * Rewritten rather than resolved through a stub package, so the file under test
 * is the file on disk and nothing about the import graph is arranged for the
 * test. The replacement is asserted, so a hook that stops importing these two
 * fails here rather than silently testing something else.
 */
const load = async () => {
    const source = fs.readFileSync(HOOK, "utf8");
    const patched = source.replace(
        /^import \{useEffect, useRef} from "react";$/m,
        "const {useEffect, useRef} = globalThis.__modalFocusReact;"
    );

    if (patched === source) throw new Error("useModalFocus no longer imports useEffect and useRef from react");

    /*
     * A directory of its own, removed when the run ends.
     *
     * A fixed name under a world-writable /tmp is a file another user can
     * pre-create as a symlink, and writeFileSync follows one - so on a shared
     * runner this wrote the patched module through to whatever it pointed at.
     * mkdtemp creates with 0700 and a name nothing can predict. It also stops
     * the leak: one module per run was left behind for ever, and this machine
     * had eighty-two of them.
     */
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "myspeed-modal-focus-"));
    const file = path.join(directory, "useModalFocus.mjs");

    fs.writeFileSync(file, patched);
    process.on("exit", () => fs.rmSync(directory, {recursive: true, force: true}));

    return import(pathToFileURL(file).href);
};

export const {useModalFocus} = await load();

/**
 * One mounted component, with React's commit rules: an effect re-runs only when
 * its dependencies change, and on a re-render every cleanup runs before any
 * effect does.
 */
export class Component {
    constructor() { this.committed = []; this.slots = []; this.cursor = 0; }

    render(runHook) {
        rendering = this;
        this.cursor = 0;
        pendingEffects = [];
        runHook();

        const next = [];
        const cleanups = [];
        const creates = [];

        pendingEffects.forEach((entry, index) => {
            const previous = this.committed[index];
            const changed = !previous || !previous.deps || !entry.deps
                || previous.deps.length !== entry.deps.length
                || entry.deps.some((dep, position) => dep !== previous.deps[position]);

            if (!changed) { next[index] = previous; return; }

            if (previous?.cleanup) cleanups.push(previous.cleanup);
            next[index] = {deps: entry.deps, cleanup: null};
            creates.push({entry, index});
        });

        cleanups.forEach((cleanup) => cleanup());
        creates.forEach(({entry, index}) => { next[index].cleanup = entry.effect() || null; });

        this.committed = next;
        return this;
    }

    /** React runs an unmounting component's cleanups in the order they were declared. */
    unmount() {
        this.committed.forEach((entry) => entry?.cleanup?.());
        this.committed = [];
    }
}

/** An overlay shaped like the real ones: the close control first, then content. */
export const overlay = ({dismiss = true, fields = ["field"], buttons = ["ok"]} = {}) => {
    const area = element("div", {class: "dialog-area", name: "area"});
    const dialog = element("div", {class: "dialog", tabindex: "-1", name: "dialog"});
    const header = element("div", {class: "dialog-header"});

    if (dismiss) header.append(element("button", {name: "closeX", "data-overlay-dismiss": ""}));

    const main = element("div", {});
    fields.forEach((field) => main.append(element("input", {name: field})));

    const footer = element("div", {});
    buttons.forEach((button) => footer.append(element("button", {name: button})));

    dialog.append(header, main, footer);
    area.append(dialog);

    return {area, dialog, get: (name) => dialog.descendants.find((d) => d.attributes.name === name)};
};
