import {useRef, useState} from "react";
import {FontAwesomeIcon} from "@fortawesome/react-fontawesome";
import {faCheck, faChevronDown, faClockRotateLeft} from "@fortawesome/free-solid-svg-icons";
import {t} from "i18next";
import {useClickOutside} from "@/common/hooks/useClickOutside";
import {COMPARE_CHOICES} from "@/common/utils/TimeframeUtil";
import "./styles.sass";

/**
 * How far back the statistics compare: the period immediately before the
 * selected range, or the same span some whole number of months earlier.
 *
 * A menu of its own rather than a <select>, and that is not a preference. This
 * sits one row under the toolbar, beside the export button it is meant to read
 * as a sibling of - and a native select's open list is drawn by the browser in
 * its own chrome, which no stylesheet can reach. Closed it could be made to
 * match; opened it was the one control on the page in the operating system's
 * voice rather than the app's.
 *
 * The structure is the export button's, deliberately: the same trigger with a
 * turning chevron, the same click-outside and Escape, the same menu box - which
 * both draw from the mixins in common/styles/_menu.sass, so there is one home
 * for what they look like.
 *
 * @param value  the chosen offset id, one of COMPARE_CHOICES
 * @param onChange called with the id the reader picked
 */
export const CompareSelect = ({value, onChange}) => {
    const [isOpen, setIsOpen] = useState(false);
    const buttonRef = useRef(null);
    const menuRef = useRef(null);

    useClickOutside(isOpen, [menuRef, buttonRef], () => setIsOpen(false));

    /*
     * Escape closes the menu and hands focus back to what opened it.
     *
     * On the container rather than the window, the rule every overlay here
     * keeps: a listener on the window is always mounted, and claiming a key
     * nothing was pressed against is how one menu came to swallow the press
     * that dismisses the dialog around it.
     */
    const handleKey = (e) => {
        if (!isOpen || e.key !== "Escape") return;

        e.preventDefault();
        setIsOpen(false);
        buttonRef.current?.focus();
    };

    const choose = (choice) => {
        setIsOpen(false);
        buttonRef.current?.focus();
        onChange(choice);
    };

    return (
        <div className="compare-select" onKeyDown={handleKey}>
            {/* The label is the trigger's own name, so it carries no
                aria-label of its own: the button says what is chosen, and the
                words beside it say what that is a choice about. */}
            <span className="compare-select-label" id="compare-select-label">
                {t("statistics.compare.label")}
            </span>

            {/* The button and its menu, boxed together and alone.
                The menu asks for the width of whatever it hangs from, and with
                the label inside that box it was asking for the label too - a
                hundred pixels of empty gutter beside six short options, from a
                floor nothing in the menu had set. Same shape as
                .export-button-container, for the same reason. */}
            <div className="compare-select-anchor">
                <button
                    type="button"
                    className="compare-select-trigger"
                    ref={buttonRef}
                    onClick={() => setIsOpen(!isOpen)}
                    aria-expanded={isOpen}
                    aria-labelledby="compare-select-label compare-select-value"
                >
                    <FontAwesomeIcon icon={faClockRotateLeft} className="compare-select-icon"/>
                    <span id="compare-select-value">{t(`statistics.compare.choice.${value}`)}</span>
                    <FontAwesomeIcon icon={faChevronDown}
                                     className={`compare-select-chevron${isOpen ? " open" : ""}`}/>
                </button>

                {/* Buttons, like the one that opens them - a keyboard that can
                    reach the menu has to have something to press once it is
                    there. The chosen one is marked rather than merely styled: a
                    colour alone is not a statement anything but an eye can read. */}
                {isOpen && (
                    <div className="compare-select-menu" ref={menuRef} role="listbox">
                        {COMPARE_CHOICES.map((choice) => (
                            <button type="button" key={choice} role="option"
                                    aria-selected={choice === value}
                                    className={`compare-select-option${choice === value ? " chosen" : ""}`}
                                    onClick={() => choose(choice)}>
                                <FontAwesomeIcon icon={faCheck}
                                                 className={choice === value ? "" : "compare-select-unchosen"}/>
                                <span>{t(`statistics.compare.choice.${choice}`)}</span>
                            </button>
                        ))}
                    </div>
                )}
            </div>
        </div>
    );
};

export default CompareSelect;
