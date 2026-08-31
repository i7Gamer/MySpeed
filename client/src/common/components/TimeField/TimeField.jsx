import {useLayoutEffect, useRef, useState} from "react";
import {createPortal} from "react-dom";
import {FontAwesomeIcon} from "@fortawesome/react-fontawesome";
import {faClock} from "@fortawesome/free-solid-svg-icons";
import {useClickOutside} from "@/common/hooks/useClickOutside";
import {useCoarsePointer} from "@/common/hooks/useCoarsePointer";
import {
    HOUR_OPTIONS, MINUTE_OPTIONS, maskTime, normaliseTime, partAt, partsOf, stepPart, withPart
} from "./timeValue";
import "./styles.sass";

/**
 * A time of day, drawn by whichever picker suits the pointer.
 *
 * On touch this is the plain native input and nothing else: the operating
 * system's wheel is a better time picker than anything a page can draw, and
 * replacing it would be a downgrade dressed up as consistency.
 *
 * On a mouse it is the app's own. The browser's desktop popup is a panel in the
 * OS's voice laid over a dark dialog, drawn in whatever clock the *browser's*
 * locale uses - an AM/PM column for a setting this app and its server both
 * state in 24 hours - and no stylesheet can reach any of it. The value was
 * never wrong, since a time input's DOM value is 24-hour regardless; only the
 * voice it was asked in was.
 *
 * What leaves here is `""` or `HH:mm`, which is exactly what the native input
 * emitted. windowProblem and the two config writes behind it are mirrored
 * against server/util/quietHours.js, so a partial entry goes out as "" - no
 * time at all - rather than as a third shape those would have to learn.
 *
 * @param ariaLabel the field's accessible name, from the caller: this component
 *                  has no strings of its own, and a new one is 23 locale files.
 */

/** The gap between the field and its menu, as DropdownSelect places its own. */
const GAP = 8;

const COLUMNS = [
    {part: "hour", head: "HH", options: HOUR_OPTIONS},
    {part: "minute", head: "MM", options: MINUTE_OPTIONS}
];

export const TimeField = ({value, onChange, className = "", id, ariaLabel}) => {
    const coarse = useCoarsePointer();

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
    const [draft, setDraft] = useState(value ?? "");
    const [sent, setSent] = useState(value ?? "");

    if ((value ?? "") !== sent) {
        setSent(value ?? "");
        setDraft(value ?? "");
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
            const above = field.top - GAP * 2;
            const below = window.innerHeight - field.bottom - GAP * 2;
            const dropUp = above >= menuRef.current.scrollHeight || above >= below;

            setPosition({
                top: dropUp ? undefined : field.bottom + GAP,
                bottom: dropUp ? window.innerHeight - field.top + GAP : undefined,
                left: field.left,
                minWidth: field.width,
                maxHeight: dropUp ? above : below
            });
        };

        place();

        window.addEventListener("resize", place);
        window.addEventListener("scroll", place, true);

        return () => {
            window.removeEventListener("resize", place);
            window.removeEventListener("scroll", place, true);
        };
    }, [isOpen]);

    /** The one way a value leaves: masked for the field, normalised for the caller. */
    const publish = (raw) => {
        const masked = maskTime(raw);
        const complete = normaliseTime(masked);

        setDraft(masked);
        setSent(complete);
        onChange(normaliseTime(masked));
    };

    const close = () => {
        setIsOpen(false);
        setPosition({visibility: "hidden"});
        inputRef.current?.focus();
    };

    /*
     * Escape closes the picker, and the arrows step the half the caret is in.
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
        publish(stepPart(draft, partAt(draft, event.target.selectionStart ?? 0),
            event.key === "ArrowUp" ? 1 : -1));
    };

    // Touch keeps the wheel. Below every hook, so the branch cannot change how
    // many of them run.
    if (coarse)
        return (
            <input id={id} type="time" className={className} aria-label={ariaLabel}
                   value={value ?? ""} onChange={(e) => onChange(e.target.value)}/>
        );

    const chosen = partsOf(draft);

    return (
        <div className="time-field" onKeyDown={handleKey}>
            <input
                id={id}
                ref={inputRef}
                type="text"
                // The field takes four digits and a separator, so a phone that
                // somehow reaches this branch still offers the right keyboard.
                inputMode="numeric"
                className={className}
                aria-label={ariaLabel}
                placeholder="--:--"
                maxLength={5}
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
                    {COLUMNS.map(({part, head, options}) => (
                        <div className="time-field-column" key={part}>
                            {/* The format's own tokens, not words: they read the
                                same in every language this ships in, which is
                                what keeps the picker free of new strings. */}
                            <span className="time-field-head" aria-hidden="true">{head}</span>
                            {options.map((option) => (
                                <button type="button" key={option}
                                        className={`time-field-option${chosen[part] === option ? " time-field-chosen" : ""}`}
                                        onClick={() => publish(withPart(draft, part, option))}>
                                    {option}
                                </button>
                            ))}
                        </div>
                    ))}
                </div>, document.body)}
        </div>
    );
};
