import {useContext, useLayoutEffect, useMemo, useRef, useState} from "react";
import {createPortal} from "react-dom";
import {FontAwesomeIcon} from "@fortawesome/react-fontawesome";
import {faClock} from "@fortawesome/free-solid-svg-icons";
import {useClickOutside} from "@/common/hooks/useClickOutside";
import {useCoarsePointer} from "@/common/hooks/useCoarsePointer";
import {PreferencesContext, TIME_FORMAT_12H} from "@/common/contexts/Preferences";
import {
    MERIDIEM_OPTIONS, MINUTE_OPTIONS, browserUses12h, chosenParts, displayTime, hourOptions,
    maskTime, normaliseTime, partAt, stepPart, withPart
} from "./timeValue";
import "./styles.sass";

/**
 * A time of day, on the clock the reader chose, drawn by whichever picker can
 * actually show it.
 *
 * Three things decide what appears here, in this order:
 *
 * 1. `preferences.timeFormat`, which already decides every other time in the
 *    app through FormatUtil - the status bar, the chart axes, the next-test
 *    line. This field used to ask the browser instead, which is a different
 *    question with a different answer: an en-US machine drew an AM/PM picker
 *    for somebody who had chosen 24 hours two dialogs away.
 *
 * 2. Whether the operating system's own picker can show that clock. A native
 *    `<input type="time">` takes its format from the browser's UI locale and
 *    from nothing else - `lang` on the element, on an ancestor and on the
 *    document were all measured and all ignored - so it is used only where it
 *    already agrees, and cannot be corrected where it does not.
 *
 * 3. The pointer. Where the native control agrees, touch keeps it: the OS wheel
 *    is a better time picker than anything a page can draw, and replacing it
 *    would be a downgrade dressed up as consistency. A mouse gets the drawn one
 *    regardless, because the browser's *desktop* popup is a panel in the OS's
 *    voice laid over a dark dialog that no stylesheet can reach.
 *
 * What leaves here is `""` or 24-hour `HH:mm` in every combination of those,
 * which is what the configuration stores and what a native time input's DOM
 * value always was - the data was never wrong, only the voice it was asked in.
 * windowProblem and the two config writes behind it are mirrored against
 * server/util/quietHours.js, so a partial entry goes out as "" rather than as a
 * third shape those would have to learn.
 *
 * @param ariaLabel the field's accessible name, from the caller: this component
 *                  has no strings of its own, and a new one is 23 locale files.
 */

/** The gap between the field and its menu, as DropdownSelect places its own. */
const GAP = 8;

/**
 * How tall the menu is allowed to get, whatever room it is offered.
 *
 * Twenty-four hours at one row each is some 620px, and the room "available"
 * above a field near the bottom of a tall window is all of that - so the menu
 * grew to its full height and covered the dialog it belongs to, which is a
 * picker that hides what it is picking for. The columns scroll instead; this is
 * the height at which they start.
 */
const MAX_MENU_HEIGHT = 240;

export const TimeField = ({value, onChange, className = "", id, ariaLabel}) => {
    const coarse = useCoarsePointer();
    const [preferences] = useContext(PreferencesContext);
    const use12h = preferences?.timeFormat === TIME_FORMAT_12H;

    // Asked once. The browser's UI locale does not change inside a session, and
    // the answer costs an Intl formatter.
    const nativeAgrees = useMemo(() => browserUses12h() === use12h, [use12h]);

    /*
     * What the field shows, which is not always what the caller holds.
     *
     * A half-typed "04:3" is no time, so the caller has already been told "" -
     * and re-seeding the field from that would delete the characters as they
     * were typed. So the draft is kept here and the caller's value is adopted
     * only when it differs from what was last sent out, which is what an
     * external change looks like: the dialog opening, or a refused save putting
     * the stored window back.
     */
    const [draft, setDraft] = useState(() => displayTime(value, use12h));
    const [sent, setSent] = useState(value ?? "");
    // Flipping the preference with the dialog open re-letters the field: the
    // stored value has not moved, so it is the display that has to catch up.
    const [shownAs, setShownAs] = useState(use12h);

    if ((value ?? "") !== sent || use12h !== shownAs) {
        setSent(value ?? "");
        setShownAs(use12h);
        setDraft(displayTime(value, use12h));
    }

    const [isOpen, setIsOpen] = useState(false);
    const [position, setPosition] = useState({visibility: "hidden"});
    const inputRef = useRef(null);
    const menuRef = useRef(null);

    useClickOutside(isOpen, [inputRef, menuRef], () => setIsOpen(false));

    /*
     * Placed against the viewport, and flipped where there is no room below.
     *
     * The same arrangement DropdownSelect uses, and for the same two reasons:
     * the dialog's body is `overflow-y: auto`, so a menu positioned inside it is
     * clipped by it, and the dialog carries a backdrop-filter, which makes it
     * the containing block for anything fixed within it. Hence the portal, and
     * hence measuring here rather than trusting CSS.
     */
    useLayoutEffect(() => {
        if (!isOpen) return;

        const place = () => {
            const field = inputRef.current.getBoundingClientRect();
            const above = Math.min(MAX_MENU_HEIGHT, field.top - GAP * 2);
            const below = Math.min(MAX_MENU_HEIGHT, window.innerHeight - field.bottom - GAP * 2);
            const dropUp = above > below;

            setPosition({
                top: dropUp ? undefined : field.bottom + GAP,
                bottom: dropUp ? window.innerHeight - field.top + GAP : undefined,
                left: field.left,
                minWidth: field.width,
                maxHeight: dropUp ? above : below
            });
        };

        place();

        // The hour already set, brought into view: the column opens at midnight
        // otherwise, and a window starting at 23:00 would show none of itself.
        menuRef.current?.querySelector(".time-field-chosen")
            ?.scrollIntoView({block: "center"});

        window.addEventListener("resize", place);
        window.addEventListener("scroll", place, true);

        return () => {
            window.removeEventListener("resize", place);
            window.removeEventListener("scroll", place, true);
        };
    }, [isOpen]);

    /** Typed text: masked for the field, normalised for the caller. */
    const publish = (raw) => {
        const masked = maskTime(raw, use12h);

        setDraft(masked);
        setSent(normaliseTime(masked, use12h));
        onChange(normaliseTime(masked, use12h));
    };

    /** A whole time, arrived at by a press rather than by typing. */
    const commit = (stored) => {
        setDraft(displayTime(stored, use12h));
        setSent(stored);
        onChange(stored);
    };

    const close = () => {
        setIsOpen(false);
        setPosition({visibility: "hidden"});
        inputRef.current?.focus();
    };

    /*
     * Escape closes the picker, and the arrows step the part the caret is in.
     *
     * On the container rather than the window, the rule every overlay here
     * keeps - a listener on the window is always mounted, and claiming a key
     * nothing was pressed against is how one menu came to swallow the press
     * that dismisses the dialog around it. event.key and not event.code, so a
     * keyboard with Escape remapped still closes it.
     */
    const handleKey = (event) => {
        if (event.key === "Escape") {
            if (!isOpen) return;

            event.preventDefault();
            close();
            return;
        }

        if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;

        event.preventDefault();
        commit(stepPart(normaliseTime(draft, use12h), partAt(draft, event.target.selectionStart ?? 0),
            event.key === "ArrowUp" ? 1 : -1, use12h));
    };

    const columns = [
        // The format's own tokens as headings, not words: they read the same in
        // every language this ships in, which is what keeps the picker free of
        // new strings.
        {part: "hour", head: "HH", options: hourOptions(use12h)},
        {part: "minute", head: "MM", options: MINUTE_OPTIONS},
        ...(use12h ? [{part: "meridiem", head: "AM/PM", options: MERIDIEM_OPTIONS}] : [])
    ];

    // The OS wheel, where it already speaks the reader's clock. Below every
    // hook, so the branch cannot change how many of them run.
    if (coarse && nativeAgrees)
        return (
            <input id={id} type="time" className={className} aria-label={ariaLabel}
                   value={value ?? ""} onChange={(e) => onChange(e.target.value)}/>
        );

    /*
     * Touch, where the native time input would show the wrong clock.
     *
     * Still native controls, and deliberately: a <select> opens the platform's
     * own picker - the wheel on iOS, the modal list on Android - which is the
     * thing worth keeping about the native input on a phone. What it does not
     * inherit is the format, because these options are ours, so this is 24-hour
     * whenever the reader asked for 24-hour. That is the whole trick: the
     * browser decides the clock of an <input type="time"> and nothing can
     * overrule it, but nobody decides the contents of a <select> except us.
     *
     * The cost is the typing, which a select has none of - so the minutes are
     * the same five-minute steps the drawn picker offers by clicking, rather
     * than a different answer per device to "what can I pick".
     */
    if (coarse) {
        const parts = chosenParts(value, use12h);
        const set = (part, next) =>
            onChange(next === "" ? "" : withPart(normaliseTime(value), part, next, use12h));

        return (
            <div className="time-field-native">
                {columns.map(({part, head, options}) => (
                    <span className="select-wrap" key={part}>
                        {/* Named by the field plus the format token it holds:
                            three comboboxes all called "From" would be one
                            name for three different questions, and HH/MM are
                            not words that need translating. */}
                        <select id={part === "hour" ? id : undefined}
                                className={`${className} select-field`}
                                aria-label={`${ariaLabel} ${head}`}
                                value={parts[part]}
                                onChange={(e) => set(part, e.target.value)}>
                            <option value="">--</option>
                            {options.map((option) => <option key={option} value={option}>{option}</option>)}
                        </select>
                    </span>
                ))}
            </div>
        );
    }

    const chosen = chosenParts(normaliseTime(draft, use12h), use12h);

    return (
        <div className="time-field" onKeyDown={handleKey}>
            <input
                id={id}
                ref={inputRef}
                type="text"
                // Digits and a separator, so a phone reaching this branch -
                // which it does whenever its own clock disagrees with the
                // reader's - still offers the right keyboard.
                inputMode="numeric"
                className={className}
                aria-label={ariaLabel}
                placeholder={use12h ? "--:-- --" : "--:--"}
                maxLength={use12h ? 8 : 5}
                value={draft}
                onChange={(e) => publish(e.target.value)}
            />

            <button type="button" className="time-field-trigger"
                    aria-label={ariaLabel} aria-haspopup="dialog" aria-expanded={isOpen}
                    // A mousedown here blurs the field, and the toggle below
                    // would then be fighting a focus that had already moved.
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => (isOpen ? close() : setIsOpen(true))}>
                <FontAwesomeIcon icon={faClock}/>
            </button>

            {isOpen && createPortal(
                // Read as part of the overlay that owns it: the focus trap asks
                // by containment, and a portal is outside the dialog it belongs
                // to. See OVERLAY_PORTAL in useModalFocus.
                <div className="time-field-menu" ref={menuRef} style={position} data-overlay-portal>
                    {columns.map(({part, head, options}) => (
                        <div className="time-field-column" key={part}>
                            <span className="time-field-head" aria-hidden="true">{head}</span>
                            {options.map((option) => (
                                <button type="button" key={option}
                                        className={`time-field-option${chosen[part] === option ? " time-field-chosen" : ""}`}
                                        onClick={() => commit(withPart(normaliseTime(draft, use12h), part, option, use12h))}>
                                    {option}
                                </button>
                            ))}
                        </div>
                    ))}
                </div>, document.body)}
        </div>
    );
};
