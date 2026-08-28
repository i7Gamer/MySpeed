import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { blockEnd, readSource } from "../helpers/source.js";

const source = readSource("client/src/common/contexts/Dialog/DialogContext.jsx");

/**
 * A named arrow lifted out of the component and made callable, the way
 * escapeTopmost.test.js runs the dialog's keydown handler - the open/close
 * dance is a state machine over refs, and what it does is only observable by
 * stepping it. The JSX around it is the only part node cannot parse.
 */
const lift = (named, closure, signature) => {
    const start = source.indexOf(named);
    assert.notEqual(start, -1, `${named} is gone from the dialog`);

    const body = source.slice(source.indexOf("{", source.indexOf("=>", start)));
    const names = Object.keys(closure);

    return new Function(...names, `return ${signature} => ${body.slice(0, blockEnd(body, 0) + 1)};`)(
        ...names.map((name) => closure[name]));
};

// A stand-in for a DOM element, tracking which of the fade-out classes it wears.
const element = () => {
    const held = new Set();
    return {classList: {add: (c) => held.add(c), remove: (c) => held.delete(c), has: (c) => held.has(c)}};
};

/**
 * The dialog spends 300ms fading out, and the fault is what happens if it is
 * reopened - or if a child element finishes an animation of its own - inside
 * that window.
 *
 * handleAnimationEnd finished the close on any element's `fadeOut`: a nested
 * element's own fade bubbles to it, and it never asked whether `open` had gone
 * true again. So a child animating inside the fade, or a reopen within it, ran
 * setVisible(false) and unmounted the dialog that was meant to stay.
 */
describe("the dialog's fade-out end", () => {
    const box = {name: "the dialog box"};

    const ended = ({open, isClosing = true, target}) => {
        const seen = {setVisible: [], closed: 0};
        const isClosingRef = {current: isClosing};
        const handler = lift("const handleAnimationEnd", {
            open,
            dialogRef: {current: box},
            isClosingRef,
            setVisible: (v) => seen.setVisible.push(v),
            onClose: () => seen.closed++
        }, "(e)");

        handler({animationName: "fadeOut", target});
        return {seen, isClosingRef};
    };

    it("ignores a child element's own fadeOut bubbling up", () => {
        const {seen} = ended({open: false, target: {name: "a child"}});

        assert.deepEqual(seen.setVisible, [],
            "a nested element finishing its fade unmounts the whole dialog");
        assert.equal(seen.closed, 0);
    });

    /**
     * The state every Escape, X and backdrop click produces: handleClose set
     * the closing flag and started the fade, and `open` is still true, because
     * the parent only learns of the close from the onClose this handler fires.
     * Gating the completion on `!open` therefore blocked every close a dialog
     * started for itself - it faded to invisible and stayed mounted, with the
     * transparent backdrop swallowing every click on the app.
     */
    it("finishes a close the dialog started for itself", () => {
        const {seen, isClosingRef} = ended({open: true, isClosing: true, target: box});

        assert.deepEqual(seen.setVisible, [false],
            "an internally started close never completes, because `open` is still true mid-fade");
        assert.equal(seen.closed, 1, "the parent is never told the dialog closed");
        assert.equal(isClosingRef.current, false, "the closing flag stays set after the close");
    });

    /**
     * A reopen within the fade is told apart by the closing flag, not by
     * `open`: the reopen effect has already cleared the flag and stripped the
     * hidden classes - cancelling the animation - so a fade-out end arriving
     * with the flag down belongs to a close that was called off.
     */
    it("does not tear down a dialog whose close was called off", () => {
        const {seen} = ended({open: true, isClosing: false, target: box});

        assert.deepEqual(seen.setVisible, [],
            "a cancelled close still unmounts the dialog when its fade ends");
        assert.equal(seen.closed, 0, "the reopened dialog's onClose fires as if it had closed");
    });

    it("finishes a genuine close of the dialog box itself", () => {
        const {seen, isClosingRef} = ended({open: false, target: box});

        assert.deepEqual(seen.setVisible, [false], "a real close no longer unmounts the dialog");
        assert.equal(seen.closed, 1, "a real close no longer reports itself");
        assert.equal(isClosingRef.current, false, "the closing flag is left set after a close");
    });

    it("leaves an animation that is not the fade-out alone", () => {
        const seen = {setVisible: [], closed: 0};
        const handler = lift("const handleAnimationEnd", {
            open: false,
            dialogRef: {current: box},
            isClosingRef: {current: false},
            setVisible: (v) => seen.setVisible.push(v),
            onClose: () => seen.closed++
        }, "(e)");

        handler({animationName: "fadeIn", target: box});

        assert.deepEqual(seen.setVisible, [], "the fade-in end is treated as a close");
    });
});

/**
 * And the effect that drives the box's classes has to be able to undo a close
 * it has begun. Every path in it only ever added dialog-hidden and
 * dialog-area-hidden; nothing removed them - so a reopen arriving while the
 * dialog is still visible and mid-close left it wearing both, hidden behind its
 * own fade with no way back.
 */
describe("reopening within the fade-out recovers the dialog", () => {
    const runEffect = ({open, visible, isClosing, area, dialogEl}) => {
        const seen = {setVisible: []};
        const isClosingRef = {current: isClosing};
        const effect = lift("useEffect(() =>", {
            open, visible,
            setVisible: (v) => seen.setVisible.push(v),
            isClosingRef,
            areaRef: {current: area},
            dialogRef: {current: dialogEl}
        }, "()");

        effect();
        return {seen, isClosingRef};
    };

    it("clears the closing state and un-hides both boxes on reopen", () => {
        const area = element();
        const dialogEl = element();
        area.classList.add("dialog-area-hidden");
        dialogEl.classList.add("dialog-hidden");

        const {isClosingRef} = runEffect({open: true, visible: true, isClosing: true, area, dialogEl});

        assert.equal(isClosingRef.current, false,
            "a reopen mid-fade leaves the dialog marked closing, so it can never be closed again");
        assert.equal(area.classList.has("dialog-area-hidden"), false,
            "the backdrop stays hidden after the dialog is reopened");
        assert.equal(dialogEl.classList.has("dialog-hidden"), false,
            "the dialog box stays hidden after it is reopened");
    });

    // The two states either side of the new branch, unchanged.
    it("still hides both boxes when a visible dialog closes", () => {
        const area = element();
        const dialogEl = element();

        const {isClosingRef} = runEffect({open: false, visible: true, isClosing: false, area, dialogEl});

        assert.equal(isClosingRef.current, true);
        assert.equal(area.classList.has("dialog-area-hidden"), true);
        assert.equal(dialogEl.classList.has("dialog-hidden"), true);
    });

    it("still becomes visible when a closed dialog opens", () => {
        const {seen, isClosingRef} = runEffect({
            open: true, visible: false, isClosing: false, area: element(), dialogEl: element()
        });

        assert.deepEqual(seen.setVisible, [true]);
        assert.equal(isClosingRef.current, false);
    });
});
