import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { blockEnd, readSource } from "../helpers/source.js";

const alertSource = readSource("client/src/common/contexts/Alert/AlertContext.jsx");

/**
 * The alert's keydown handler, taken out of the component file and run.
 *
 * Same extraction as escapeTopmost.test.js, and for the same reason: the
 * handler is plain JavaScript, only the JSX around it is what node cannot
 * parse. What was wrong here is what the handler does with one event, and that
 * is only observable by handing it one - asserting on the shape of the source
 * would pass for any spelling containing the right words.
 */
const handlerWith = (closure) => {
    const start = alertSource.indexOf("const handleKeyDown");
    assert.notEqual(start, -1, "the alert no longer answers the keyboard at all");

    const body = alertSource.slice(alertSource.indexOf("{", alertSource.indexOf("=>", start)));
    const names = Object.keys(closure);

    return new Function(...names, `return (e) => ${body.slice(0, blockEnd(body, 0) + 1)};`)(
        ...names.map((name) => closure[name]));
};

/**
 * An alert that is the only overlay open, so the key is unambiguously its own.
 *
 * `closed` records what the keypress reached: "submitted" is the confirm action
 * running, "closed" is the alert being dismissed without it.
 *
 * `inside` is what makes this a model of the bug rather than of the symptom.
 * The handler's question is not "is a button focused" but "is the focused
 * button one of mine" - the alert's own Cancel must keep the key, and the page
 * button that opened the alert must not, because the browser turns an unclaimed
 * Enter on it into a second click. A stub whose areaRef carries no `contains`
 * cannot tell those two apart, so it passes for either rule.
 */
const openAlert = ({disableClose = false, inside = []} = {}) => {
    const closed = [];
    const areaRef = {current: {contains: (node) => inside.includes(node)}};

    const press = handlerWith({
        isTopmostOverlay: () => true,
        areaRef,
        alert: {disableClose},
        close: () => closed.push("closed"),
        handleSubmit: () => closed.push("submitted")
    });

    return {press, closed};
};

/**
 * A keypress as it reaches a listener on the document.
 *
 * `target` is the element the key was pressed on - the focused one - which is
 * what bubbles the event up to the document listener. A press with nothing
 * focused targets the body.
 */
const keyPress = (key, target = {tagName: "BODY"}) => ({
    key,
    target,
    defaultPrevented: false,
    preventDefault() {
        this.defaultPrevented = true;
    }
});

// The alert's own Cancel, and the page button that opened the alert. Two
// objects rather than one, because which of them is focused is the whole
// question - see openAlert.
const cancelButton = {tagName: "BUTTON"};
const triggerButton = {tagName: "BUTTON"};
const textInput = {tagName: "INPUT"};

const withCancelFocused = () => openAlert({inside: [cancelButton]});

/**
 * Enter ran the confirm action whatever had focus.
 *
 * The handler sits on the document and claimed every Enter, so tabbing to
 * Cancel and pressing it ran the very action Cancel refuses. Worse than the two
 * simply both firing: preventDefault() suppresses the browser's click on the
 * focused button, so the cancel never happened at all - the keypress was
 * converted into a confirm. On the destructive confirmations - "delete all
 * tests", "remove the password" - that is the whole of the damage.
 */
describe("Enter while one of the alert's own buttons has focus", () => {
    it("leaves the key to the focused button rather than submitting", () => {
        const {press, closed} = withCancelFocused();

        press(keyPress("Enter", cancelButton));

        assert.deepEqual(closed, [],
            "Enter on the focused Cancel button ran the confirm action instead");
    });

    it("does not claim the key, so the browser still clicks that button", () => {
        const {press} = withCancelFocused();
        const event = keyPress("Enter", cancelButton);

        press(event);

        assert.equal(event.defaultPrevented, false,
            "the click that would have cancelled was suppressed, so Cancel did nothing at all");
    });
});

/**
 * The other half of the same rule, and the regression the first one caused.
 *
 * Only the input alert autofocuses, so an alert opened by a click leaves focus
 * on the button that opened it - which is outside the alert entirely. Handing
 * that button the key means not claiming it, and an unclaimed Enter on a
 * focused button is a click: the trigger fires again and pushes a second copy
 * of the very alert being answered. Enter then never dismisses it, and a held
 * key stacks them.
 */
describe("Enter while a button outside the alert has focus", () => {
    it("submits rather than letting the trigger re-open the alert", () => {
        const {press, closed} = withCancelFocused();

        press(keyPress("Enter", triggerButton));

        assert.deepEqual(closed, ["submitted"],
            "the alert ignored the key, so the browser re-clicked the button that opened it");
    });

    it("claims the key, so no second click reaches the trigger", () => {
        const {press} = withCancelFocused();
        const event = keyPress("Enter", triggerButton);

        press(event);

        assert.equal(event.defaultPrevented, true,
            "the browser was left free to turn this Enter into another click on the trigger");
    });

    // The backdrop is mounted a tick after the alert opens, and Escape already
    // guards against a press that lands in between.
    it("submits when the alert has no mounted area to ask about yet", () => {
        const {closed} = openAlert();
        closed.length = 0;

        const arealess = handlerWith({
            isTopmostOverlay: () => true,
            areaRef: {current: null},
            alert: {disableClose: false},
            close: () => closed.push("closed"),
            handleSubmit: () => closed.push("submitted")
        });

        arealess(keyPress("Enter", triggerButton));

        assert.deepEqual(closed, ["submitted"]);
    });
});

/**
 * The other half: the shortcut is what makes an alert usable from the keyboard
 * without tabbing to OK, and it has to keep working everywhere a button is not
 * the thing being typed into.
 */
describe("Enter with no button focused", () => {
    it("still submits when nothing in particular has focus", () => {
        const {press, closed} = openAlert();

        press(keyPress("Enter"));

        assert.deepEqual(closed, ["submitted"]);
    });

    it("still submits from the text field an input alert focuses on open", () => {
        const {press, closed} = openAlert();

        press(keyPress("Enter", textInput));

        assert.deepEqual(closed, ["submitted"]);
    });

    it("claims the key when it does act on it", () => {
        const {press} = openAlert();
        const event = keyPress("Enter");

        press(event);

        assert.equal(event.defaultPrevented, true);
    });

    // A press that arrives before the backdrop is mounted, as the Escape rule
    // already guards against.
    it("ignores a target that carries no tag name at all", () => {
        const {press, closed} = openAlert();

        press(keyPress("Enter", undefined));

        assert.deepEqual(closed, ["submitted"]);
    });
});

/**
 * Escape is unaffected: it closes rather than submits, so a focused button
 * changes nothing about who should answer it.
 */
describe("Escape is left as it was", () => {
    it("closes the alert even from a focused button", () => {
        const {press, closed} = withCancelFocused();

        press(keyPress("Escape", cancelButton));

        assert.deepEqual(closed, ["closed"]);
    });

    it("stays refused while the alert disables closing", () => {
        const {press, closed} = openAlert({disableClose: true});

        press(keyPress("Escape"));

        assert.deepEqual(closed, []);
    });
});
