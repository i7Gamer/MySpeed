import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readSource, withoutJsComments } from "../helpers/source.js";

const dropdownSource = readSource("client/src/common/components/Dropdown/DropdownComponent.jsx");
const dialogSource = readSource("client/src/common/contexts/Dialog/DialogContext.jsx");
const alertSource = readSource("client/src/common/contexts/Alert/AlertContext.jsx");
const chartSource = readSource("client/src/common/components/ChartModal/ChartModal.jsx");
const pickerSource = readSource("client/src/common/components/DateRangePicker/DateRangePicker.jsx");

describe("DropdownComponent keyboard event inconsistency verification", () => {
    it("verifies DropdownComponent listens to keyup instead of keydown", () => {
        assert.match(dropdownSource, /document\.addEventListener\("keyup",\s*onPress\)/,
            "DropdownComponent must be listening to keyup");
        assert.doesNotMatch(dropdownSource, /document\.addEventListener\("keydown"/,
            "DropdownComponent does not yet listen to keydown");
    });

    it("verifies DropdownComponent checks event.code === 'Escape' instead of event.key", () => {
        assert.match(dropdownSource, /event\.code === "Escape"/,
            "DropdownComponent checks event.code rather than event.key");
        assert.doesNotMatch(dropdownSource, /event\.key === "Escape"/,
            "DropdownComponent does not yet use event.key");
    });

    it("verifies DialogContext, AlertContext, ChartModal, and DateRangePicker listen to keydown with event.key === 'Escape'", () => {
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

    it("verifies DropdownComponent lacks preventDefault and defaultPrevented checks", () => {
        const effectSlice = dropdownSource.slice(
            dropdownSource.indexOf("useEffect(() => {"),
            dropdownSource.indexOf("[isOpen, switchDropdown]);")
        );
        assert.doesNotMatch(effectSlice, /preventDefault/,
            "DropdownComponent does not call preventDefault()");
        assert.doesNotMatch(effectSlice, /defaultPrevented/,
            "DropdownComponent does not inspect defaultPrevented");
    });
});

describe("Proof of event mismatch when modal is open over dropdown", () => {
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

    it("demonstrates how keydown (dialog) and keyup (dropdown) cause double dismissal", () => {
        let dialogClosed = false;
        let dropdownClosed = false;

        // Current DialogContext handler (on keydown)
        const dialogKeyDownHandler = (e) => {
            if (e.defaultPrevented) return;
            if (e.key === "Escape") {
                e.preventDefault();
                dialogClosed = true;
            }
        };

        // Current DropdownComponent handler (on keyup)
        const dropdownKeyUpHandler = (e) => {
            if (e.code === "Escape") {
                dropdownClosed = true;
            }
        };

        // User presses Escape: browser dispatches keydown
        const keyDownEvent = createEvent("keydown", "Escape", "Escape", false);
        dialogKeyDownHandler(keyDownEvent);

        assert.equal(dialogClosed, true, "Dialog closed on keydown");
        assert.equal(keyDownEvent.defaultPrevented, true, "Dialog called preventDefault on keydown");
        assert.equal(dropdownClosed, false, "Dropdown did not close on keydown");

        // User releases Escape: browser dispatches keyup (fresh Event object in DOM)
        const keyUpEvent = createEvent("keyup", "Escape", "Escape", false);
        dropdownKeyUpHandler(keyUpEvent);

        assert.equal(dropdownClosed, true,
            "Dropdown closed on keyup despite dialog consuming the Escape press! Mismatch proved.");
    });

    it("demonstrates event.code failure on remapped or non-standard keyboards", () => {
        let dropdownClosed = false;
        const currentDropdownHandler = (e) => {
            if (e.code === "Escape") {
                dropdownClosed = true;
            }
        };

        // A remapped Escape (e.g. CapsLock mapped to Escape or virtual key)
        const remappedEvent = createEvent("keyup", "Escape", "CapsLock", false);
        currentDropdownHandler(remappedEvent);

        assert.equal(dropdownClosed, false,
            "event.code === 'Escape' failed to recognize remapped Escape key");
    });
});

describe("Standardized Dropdown handler on keydown and event.key === 'Escape'", () => {
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

    it("prevents double dismissal when a dialog is open above dropdown", () => {
        let dialogClosed = false;
        let dropdownClosed = false;

        const dialogKeyDownHandler = (e) => {
            if (e.defaultPrevented) return;
            if (e.key === "Escape") {
                e.preventDefault();
                dialogClosed = true;
            }
        };

        // Standardized dropdown handler
        const dropdownKeyDownHandler = createStandardizedHandler(true, () => {
            dropdownClosed = true;
        }, () => true /* overlay is open */);

        const keyDownEvent = createEvent("keydown", "Escape", "Escape", false);

        // Dialog hears keydown first
        dialogKeyDownHandler(keyDownEvent);
        // Dropdown hears keydown
        dropdownKeyDownHandler(keyDownEvent);

        assert.equal(dialogClosed, true, "Dialog closed");
        assert.equal(dropdownClosed, false, "Dropdown remained open when dialog consumed Escape");
    });

    it("closes dropdown on keydown when no overlay is open", () => {
        let dropdownClosed = false;
        const dropdownKeyDownHandler = createStandardizedHandler(true, () => {
            dropdownClosed = true;
        }, () => false /* no overlay */);

        const keyDownEvent = createEvent("keydown", "Escape", "Escape", false);
        dropdownKeyDownHandler(keyDownEvent);

        assert.equal(dropdownClosed, true, "Dropdown closed on keydown");
        assert.equal(keyDownEvent.defaultPrevented, true, "Dropdown prevented default");
    });

    it("works correctly with remapped keys via event.key === 'Escape'", () => {
        let dropdownClosed = false;
        const dropdownKeyDownHandler = createStandardizedHandler(true, () => {
            dropdownClosed = true;
        }, () => false);

        const remappedEvent = createEvent("keydown", "Escape", "CapsLock", false);
        dropdownKeyDownHandler(remappedEvent);

        assert.equal(dropdownClosed, true, "Standardized handler closed with remapped Escape");
    });

    it("ignores non-Escape keys", () => {
        for (const key of ["Enter", "Tab", "ArrowDown", " ", "a"]) {
            let dropdownClosed = false;
            const dropdownKeyDownHandler = createStandardizedHandler(true, () => {
                dropdownClosed = true;
            }, () => false);

            const event = createEvent("keydown", key, key, false);
            dropdownKeyDownHandler(event);

            assert.equal(dropdownClosed, false, `Key "${key}" did not close dropdown`);
            assert.equal(event.defaultPrevented, false, `Key "${key}" did not prevent default`);
        }
    });
});
