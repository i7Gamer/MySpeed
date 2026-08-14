import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const CLIENT_SRC = path.resolve(fileURLToPath(import.meta.url), "..", "..", "..", "client", "src");

const read = (file) => fs.readFileSync(path.join(CLIENT_SRC, file), "utf8");

const dialogSource = read("common/contexts/Dialog/DialogContext.jsx");
const alertSource = read("common/contexts/Alert/AlertContext.jsx");
const chartSource = read("common/components/ChartModal/ChartModal.jsx");

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
const handlerIn = (source, closure, named = "const handleKeyDown") => {
    const start = source.indexOf(named);
    assert.notEqual(start, -1, "the overlay no longer answers the keyboard at all");

    const body = bodyOfArrowAt(source, start);
    const names = Object.keys(closure);

    return new Function(...names, `return (e) => ${body.slice(0, blockEnd(body, 0) + 1)};`)(
        ...names.map((name) => closure[name]));
};

/**
 * Every rule the overlays share, taken as one region of the file: from the
 * selector they are all written against down to the Dialog component itself.
 *
 * Sliced as a region rather than function by function so that a rule added
 * beside the others is evaluated with them, without the extraction here having
 * an opinion about whether it was written with a braced body.
 */
const overlayModule = (document) => {
    const from = dialogSource.indexOf(SELECTOR);
    const until = dialogSource.indexOf("export const Dialog");

    assert.notEqual(from, -1, "there is no named selector for the overlay backdrops");
    assert.ok(until > from, "the shared overlay rules no longer sit above the Dialog component");
    assert.ok(dialogSource.indexOf(RULE) > from, "the dialog publishes no rule for which overlay owns a keypress");

    const block = dialogSource.slice(from, until).replace(/export /g, "");

    return new Function("document", `${block}\nreturn {isTopmostOverlay, hasOpenOverlay};`)(document);
};

const overlayRule = (document) => overlayModule(document).isTopmostOverlay;

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

/**
 * The expanded chart answered Escape as well, and answered it always.
 *
 * With a chart expanded on the statistics page, a metric's help button opens an
 * alert over it - and one Escape was taken by both, closing the alert and the
 * chart underneath it. Nothing typed is lost, unlike the password dialog the
 * rule above was written for, but the reader is dropped out of the view they
 * were reading and has to find their way back into it.
 *
 * It cannot use isTopmostOverlay as the alerts and dialogs do. That rule reads
 * document order, which is only the paint order because every overlay it was
 * written for shares one z-index and one portal; this backdrop is rendered
 * inline on the page and sits at a higher z-index than either. What is true of
 * it instead is structural: it is opened from the page, from its single call
 * site, so nothing can ever be underneath it. Any other overlay that is open is
 * therefore above it, and the key belongs to that one.
 */
describe("Escape with an alert stacked over an expanded chart", () => {
    const expand = (overlayOpen) => {
        const closed = [];
        const press = handlerIn(chartSource, {
            onClose: () => closed.push("chart"),
            hasOpenOverlay: () => overlayOpen
        }, "const handleEscape");

        return {press, closed};
    };

    it("leaves the key to an alert opened over it", () => {
        const {press, closed} = expand(true);

        press(keyPress("Escape"));

        assert.deepEqual(closed, [],
            "the expanded chart closed along with the alert that was sitting on top of it");
    });

    it("closes when nothing is stacked over it", () => {
        const {press, closed} = expand(false);
        const event = keyPress("Escape");

        press(event);

        assert.deepEqual(closed, ["chart"]);
        assert.equal(event.defaultPrevented, true, "the key has to be claimed, as the other overlays claim it");
    });

    it("leaves every other key alone", () => {
        const {press, closed} = expand(false);

        for (const key of ["Enter", "Tab", " ", "Esc"]) press(keyPress(key));

        assert.deepEqual(closed, []);
    });

    it("asks the shared rule rather than one of its own", () => {
        assert.match(chartSource, /hasOpenOverlay.*from "@\/common\/contexts\/Dialog"/,
            "the expanded chart decides for itself what counts as an overlay above it");
    });
});

/**
 * The rule that answers it: whether there is any overlay of the stacking kind
 * open at all, rather than which of them is on top.
 */
describe("hasOpenOverlay", () => {
    const presence = (...areas) => overlayModule(documentShowing(...areas)).hasOpenOverlay;

    it("is false when nothing is open", () => {
        assert.equal(presence()(), false);
    });

    it("is true while an overlay is open", () => {
        assert.equal(presence({closing: false})(), true);
    });

    // The same 300ms fade the rule above already steps over: an overlay on its
    // way out has given up its claim on the key.
    it("is false again once the only overlay is fading out", () => {
        assert.equal(presence({closing: true})(), false,
            "a chart stays open behind an alert that has already been dismissed");
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
