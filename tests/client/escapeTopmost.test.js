import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const CLIENT_SRC = path.resolve(fileURLToPath(import.meta.url), "..", "..", "..", "client", "src");

const read = (file) => fs.readFileSync(path.join(CLIENT_SRC, file), "utf8");

const dialogSource = read("common/contexts/Dialog/DialogContext.jsx");
const alertSource = read("common/contexts/Alert/AlertContext.jsx");

const SELECTOR = "const OVERLAY_AREA_SELECTOR";
const RULE = "export const isTopmostOverlay";

// The index of the } that closes the block opened at `from`.
const blockEnd = (source, from) => {
    let depth = 0;

    for (let index = from; index < source.length; index++) {
        if (source[index] === "{") depth++;
        else if (source[index] === "}" && --depth === 0) return index;
    }

    assert.fail("a block is never closed");
};

const bodyOfArrowAt = (source, start) =>
    source.slice(source.indexOf("{", source.indexOf("=>", start)));

/**
 * The two keydown handlers and the rule they consult, taken out of the component
 * files and run.
 *
 * They are plain JavaScript - the JSX around them is what node cannot parse -
 * so the alternative is asserting on the shape of their source, which passes
 * for any spelling that happens to contain the right words. What was wrong here
 * is what two handlers did with one event, and that is only observable by
 * handing them one. Same approach as overviewRow.test.js.
 */
const handlerIn = (source, closure) => {
    const start = source.indexOf("const handleKeyDown");
    assert.notEqual(start, -1, "the overlay no longer answers the keyboard at all");

    const body = bodyOfArrowAt(source, start);
    const names = Object.keys(closure);

    return new Function(...names, `return (e) => ${body.slice(0, blockEnd(body, 0) + 1)};`)(
        ...names.map((name) => closure[name]));
};

const overlayRule = (document) => {
    const from = dialogSource.indexOf(SELECTOR);
    const rule = dialogSource.indexOf(RULE);

    assert.notEqual(from, -1, "there is no named selector for the overlay backdrops");
    assert.ok(rule > from, "the dialog publishes no rule for which overlay owns a keypress");

    const body = bodyOfArrowAt(dialogSource, rule);
    const block = dialogSource.slice(from, dialogSource.indexOf(body) + blockEnd(body, 0) + 1);

    return new Function("document", `${block.replace("export ", "")};\nreturn isTopmostOverlay;`)(document);
};

/**
 * Stands in for the document the overlays share: the .dialog-area backdrops in
 * the order they were opened, which - they all sit at one z-index - is the
 * order they are painted in. A backdrop that is fading out carries
 * dialog-area-hidden, so a rule that asks for it is answered without them.
 */
const documentShowing = (...areas) => ({
    querySelectorAll: (selector) => {
        assert.match(selector, /\.dialog-area/, "the rule counts something other than overlay backdrops");

        const skipsClosing = selector.includes(":not(.dialog-area-hidden)");
        return areas.filter((area) => !(skipsClosing && area.closing));
    }
});

/**
 * Opens the named overlays in the order given and hands back a handler per
 * overlay, the backdrops they are attached to, and what closed.
 *
 * "dialog" is a Dialog - the password dialog, say - and "alert" is one of the
 * alerts opened on top of it, which is what the removal confirmation is.
 */
const open = (...kinds) => {
    const closed = [];
    const areas = Object.fromEntries(kinds.map((kind) => [kind, {closing: false}]));
    const isTopmostOverlay = overlayRule(documentShowing(...kinds.map((kind) => areas[kind])));

    const press = Object.fromEntries(kinds.map((kind) => {
        const area = areas[kind];
        const areaRef = {current: area};

        // Closing hides the backdrop from inside the very keypress that closed
        // it: AlertRenderer.close and Dialog.handleClose both add
        // dialog-area-hidden synchronously. A stub that only recorded the close
        // left the backdrop standing, which let the overlay beneath still look
        // covered - and hid the fact that the rule held only while the listeners
        // ran in one particular order.
        const recordClose = (name) => () => {
            area.closing = true;
            closed.push(name);
        };

        return [kind, kind === "dialog"
            ? handlerIn(dialogSource, {
                isTopmostOverlay, areaRef, disableClose: false, handleClose: recordClose("dialog")
            })
            : handlerIn(alertSource, {
                isTopmostOverlay, areaRef, alert: {}, close: recordClose("alert"),
                handleSubmit: () => closed.push("submitted")
            })];
    }));

    return {press, areas, closed};
};

const keyPress = (key) => ({
    key,
    defaultPrevented: false,
    preventDefault() {
        this.defaultPrevented = true;
    }
});

/**
 * One Escape closed two overlays.
 *
 * Both systems install their own keydown listener on the document, and neither
 * preventDefault nor stopPropagation reaches a sibling listener on the same
 * node - so both answered the same key. That went unnoticed while every alert
 * was opened over a page; the "remove password" confirmation is the first one
 * opened over a Dialog. Escaping out of it aborted the removal *and* faded out
 * the password dialog beneath, discarding the password typed into it and the
 * access level chosen.
 *
 * Which listener is registered first decides nothing here, so neither test does.
 */
describe("Escape with a confirmation stacked over a dialog", () => {
    for (const order of [["dialog", "alert"], ["alert", "dialog"]]) {
        it(`closes only the confirmation, ${order[0]} hearing the key first`, () => {
            const {press, closed} = open("dialog", "alert");
            const event = keyPress("Escape");

            for (const kind of order) press[kind](event);

            assert.deepEqual(closed, ["alert"],
                "the dialog under the confirmation went with it, and took the typed password with it");
        });
    }

    it("leaves Enter to the confirmation as well", () => {
        const {press, closed} = open("dialog", "alert");
        const event = keyPress("Enter");

        press.dialog(event);
        press.alert(event);

        assert.deepEqual(closed, ["submitted"]);
    });

    // The confirmation spends 300ms fading out. It has given up its turn by
    // then: a second Escape is aimed at the dialog it uncovers.
    it("hands Escape back to the dialog once the confirmation is fading out", () => {
        const {press, areas, closed} = open("dialog", "alert");
        areas.alert.closing = true;

        press.dialog(keyPress("Escape"));

        assert.deepEqual(closed, ["dialog"]);
    });
});

// The other two thirds of the behaviour: an overlay that is on its own is on
// top, and answers exactly as it did before.
describe("Escape with a single overlay", () => {
    it("closes a dialog that nothing is stacked over", () => {
        const {press, closed} = open("dialog");
        const event = keyPress("Escape");

        press.dialog(event);

        assert.deepEqual(closed, ["dialog"]);
        assert.equal(event.defaultPrevented, true, "the key has to be claimed, or the browser also acts on it");
    });

    it("closes an alert that nothing is stacked over", () => {
        const {press, closed} = open("alert");
        const event = keyPress("Escape");

        press.alert(event);

        assert.deepEqual(closed, ["alert"]);
        assert.equal(event.defaultPrevented, true);
    });

    it("still submits a lone alert on Enter", () => {
        const {press, closed} = open("alert");

        press.alert(keyPress("Enter"));

        assert.deepEqual(closed, ["submitted"]);
    });
});

describe("the rule the overlays share", () => {
    it("is read from one place, so the two cannot drift apart", () => {
        assert.match(alertSource, /isTopmostOverlay.*\}? from "@\/common\/contexts\/Dialog"/,
            "the alerts judge who is on top by a rule of their own");
    });

    // Registration order, mount order and a counter all need something kept in
    // sync; the document is already the answer.
    it("names the topmost overlay by where it sits in the document", () => {
        const first = {closing: false};
        const second = {closing: false};
        const isTopmostOverlay = overlayRule(documentShowing(first, second));

        assert.equal(isTopmostOverlay(second), true);
        assert.equal(isTopmostOverlay(first), false);
    });

    it("says no for an overlay that is not in the document at all", () => {
        const isTopmostOverlay = overlayRule(documentShowing());

        assert.equal(isTopmostOverlay(undefined), false, "a keypress before the backdrop is mounted closed it");
        assert.equal(isTopmostOverlay({}), false);
    });
});
