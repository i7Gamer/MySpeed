import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readSource, withoutJsComments } from "../helpers/source.js";

// Comments stripped for the dropdown: the handler's own comment narrates the
// keyup and event.code history, and the pins below must read the code alone.
const dropdownSource = withoutJsComments(
    readSource("client/src/common/components/Dropdown/DropdownComponent.jsx"));
const dialogSource = readSource("client/src/common/contexts/Dialog/DialogContext.jsx");
const alertSource = readSource("client/src/common/contexts/Alert/AlertContext.jsx");
const chartSource = readSource("client/src/common/components/ChartModal/ChartModal.jsx");
const pickerSource = readSource("client/src/common/components/DateRangePicker/DateRangePicker.jsx");

/**
 * Every overlay answers Escape on keydown; the settings menu was the one
 * listener on keyup. The press a dialog had answered - and preventDefault()ed -
 * therefore still closed this menu on its release, the release being a fresh
 * event with nothing prevented on it. And event.code names the physical key,
 * so a keyboard with Escape remapped onto another key said "CapsLock" there
 * and the menu would not close at all.
 */
describe("DropdownComponent keyboard event consistency", () => {
    it("listens on keydown, like every other overlay", () => {
        assert.match(dropdownSource, /document\.addEventListener\("keydown",\s*onPress\)/,
            "the menu no longer hears the same event the overlays answer");
        assert.doesNotMatch(dropdownSource, /document\.addEventListener\("keyup"/,
            "keyup is back, and with it the double dismissal under an open dialog");
    });

    it("checks event.key rather than the physical event.code", () => {
        assert.match(dropdownSource, /event\.key !== "Escape"/,
            "the menu stopped asking for the logical key");
        assert.doesNotMatch(dropdownSource, /event\.code/,
            "event.code is back, and a remapped Escape stops closing the menu");
    });

    /**
     * The two guards the shared keydown needs, and why one is not enough:
     * document listeners run in registration order, and the menu's listener is
     * registered on mount while a dialog's arrives only once it opens - so on
     * a shared press the menu runs first, before the dialog has had its turn
     * to prevent anything. hasOpenOverlay is what answers for that ordering;
     * defaultPrevented answers for any overlay that did get there first.
     */
    it("defers to open overlays and consumes the key it answers", () => {
        assert.match(dropdownSource, /event\.defaultPrevented/,
            "a key an overlay already answered is answered again");
        assert.match(dropdownSource, /hasOpenOverlay\(\)/,
            "the menu no longer asks whether a dialog is open above it");
        assert.match(dropdownSource, /event\.preventDefault\(\)/,
            "the menu closes without claiming the key, so an overlay behind it hears the same press");
    });
});

describe("the overlays the menu has to agree with", () => {
    it("DialogContext, AlertContext, ChartModal, and DateRangePicker all listen on keydown", () => {
        assert.match(dialogSource, /document\.addEventListener\("keydown"/);
        assert.match(dialogSource, /e\.key === "Escape"/);
        assert.match(dialogSource, /e\.preventDefault\(\)/);
        assert.match(dialogSource, /e\.defaultPrevented/);

        assert.match(alertSource, /document\.addEventListener\("keydown"/);
        assert.match(alertSource, /e\.key === "Escape"/);
        assert.match(alertSource, /e\.preventDefault\(\)/);
        assert.match(alertSource, /e\.defaultPrevented/);

        assert.match(chartSource, /document\.addEventListener\("keydown"/);
        assert.match(chartSource, /e\.key !== "Escape"/);
        assert.match(chartSource, /e\.preventDefault\(\)/);

        assert.match(pickerSource, /document\.addEventListener\("keydown"/);
        assert.match(pickerSource, /event\.key !== "Escape"/);
        assert.match(pickerSource, /event\.preventDefault\(\)/);
    });
});

/**
 * The mismatch the keydown handler removed, kept as a demonstration: a dialog
 * answers the press and prevents its default, but the release is a separate
 * event object - preventDefault on the keydown marks nothing on the keyup - so
 * a menu listening on keyup closed behind every dialog that closed above it.
 */
describe("proof of the event mismatch the keydown handler removed", () => {
    const createEvent = (type, key, code, defaultPrevented = false) => {
        let prevented = defaultPrevented;
        return {
            type,
            key,
            code,
            get defaultPrevented() {
                return prevented;
            },
            preventDefault() {
                prevented = true;
            }
        };
    };

    it("demonstrates how keydown (dialog) beside keyup (menu) double-dismissed", () => {
        let dialogClosed = false;
        let dropdownClosed = false;

        // The DialogContext handler, as it still is (on keydown).
        const dialogKeyDownHandler = (e) => {
            if (e.defaultPrevented) return;
            if (e.key === "Escape") {
                e.preventDefault();
                dialogClosed = true;
            }
        };

        // The menu handler as it used to be (on keyup).
        const formerDropdownKeyUpHandler = (e) => {
            if (e.code === "Escape") {
                dropdownClosed = true;
            }
        };

        // The user presses Escape: the browser dispatches keydown.
        const keyDownEvent = createEvent("keydown", "Escape", "Escape", false);
        dialogKeyDownHandler(keyDownEvent);

        assert.equal(dialogClosed, true, "the dialog closed on keydown");
        assert.equal(keyDownEvent.defaultPrevented, true, "the dialog called preventDefault on keydown");
        assert.equal(dropdownClosed, false, "the menu did not close on keydown");

        // The user releases Escape: the browser dispatches keyup, a fresh
        // event object on which nothing is prevented.
        const keyUpEvent = createEvent("keyup", "Escape", "Escape", false);
        formerDropdownKeyUpHandler(keyUpEvent);

        assert.equal(dropdownClosed, true,
            "the menu closed on keyup despite the dialog consuming the press - the mismatch");
    });

    it("demonstrates event.code failing on remapped or non-standard keyboards", () => {
        let dropdownClosed = false;
        const formerDropdownHandler = (e) => {
            if (e.code === "Escape") {
                dropdownClosed = true;
            }
        };

        // A remapped Escape (e.g. CapsLock mapped to Escape, or a virtual key).
        const remappedEvent = createEvent("keyup", "Escape", "CapsLock", false);
        formerDropdownHandler(remappedEvent);

        assert.equal(dropdownClosed, false,
            "event.code === 'Escape' failed to recognise a remapped Escape key");
    });
});

/** The handler shape the menu now carries, exercised as behaviour. */
describe("the standardized handler on keydown and event.key", () => {
    const createEvent = (type, key, code, defaultPrevented = false) => {
        let prevented = defaultPrevented;
        return {
            type,
            key,
            code,
            get defaultPrevented() {
                return prevented;
            },
            preventDefault() {
                prevented = true;
            }
        };
    };

    const createStandardizedHandler = (isOpen, switchDropdown, hasOpenOverlay = () => false) => {
        return (event) => {
            if (!isOpen) return;
            if (event.key !== "Escape" || event.defaultPrevented || hasOpenOverlay()) return;
            event.preventDefault();
            switchDropdown();
        };
    };

    it("prevents double dismissal when a dialog is open above the menu", () => {
        let dialogClosed = false;
        let dropdownClosed = false;

        const dialogKeyDownHandler = (e) => {
            if (e.defaultPrevented) return;
            if (e.key === "Escape") {
                e.preventDefault();
                dialogClosed = true;
            }
        };

        const dropdownKeyDownHandler = createStandardizedHandler(true, () => {
            dropdownClosed = true;
        }, () => true /* an overlay is open */);

        const keyDownEvent = createEvent("keydown", "Escape", "Escape", false);

        // The menu's listener was registered first and hears the press first.
        dropdownKeyDownHandler(keyDownEvent);
        dialogKeyDownHandler(keyDownEvent);

        assert.equal(dialogClosed, true, "the dialog closed");
        assert.equal(dropdownClosed, false, "the menu stayed open while the dialog took the key");
    });

    it("closes the menu on keydown when no overlay is open", () => {
        let dropdownClosed = false;
        const dropdownKeyDownHandler = createStandardizedHandler(true, () => {
            dropdownClosed = true;
        }, () => false /* no overlay */);

        const keyDownEvent = createEvent("keydown", "Escape", "Escape", false);
        dropdownKeyDownHandler(keyDownEvent);

        assert.equal(dropdownClosed, true, "the menu closed on keydown");
        assert.equal(keyDownEvent.defaultPrevented, true, "the menu claimed the key it answered");
    });

    it("works with remapped keys via event.key", () => {
        let dropdownClosed = false;
        const dropdownKeyDownHandler = createStandardizedHandler(true, () => {
            dropdownClosed = true;
        }, () => false);

        const remappedEvent = createEvent("keydown", "Escape", "CapsLock", false);
        dropdownKeyDownHandler(remappedEvent);

        assert.equal(dropdownClosed, true, "the handler closed with a remapped Escape");
    });

    it("ignores non-Escape keys", () => {
        for (const key of ["Enter", "Tab", "ArrowDown", " ", "a"]) {
            let dropdownClosed = false;
            const dropdownKeyDownHandler = createStandardizedHandler(true, () => {
                dropdownClosed = true;
            }, () => false);

            const event = createEvent("keydown", key, key, false);
            dropdownKeyDownHandler(event);

            assert.equal(dropdownClosed, false, `key "${key}" closed the menu`);
            assert.equal(event.defaultPrevented, false, `key "${key}" was swallowed`);
        }
    });

    it("ignores every key while the menu is closed", () => {
        let dropdownClosed = false;
        const dropdownKeyDownHandler = createStandardizedHandler(false, () => {
            dropdownClosed = true;
        }, () => false);

        const event = createEvent("keydown", "Escape", "Escape", false);
        dropdownKeyDownHandler(event);

        assert.equal(dropdownClosed, false, "a closed menu answered Escape");
        assert.equal(event.defaultPrevented, false, "a closed menu swallowed a key meant for the page");
    });
});
