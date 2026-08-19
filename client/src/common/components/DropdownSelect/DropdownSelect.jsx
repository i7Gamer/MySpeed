import {FontAwesomeIcon} from "@fortawesome/react-fontawesome";
import {faChevronDown, faPlus} from "@fortawesome/free-solid-svg-icons";
import {useState, useRef, useLayoutEffect} from "react";
import {createPortal} from "react-dom";
import {nextFocus} from "@/common/hooks/useModalFocus";
import "./styles.sass";

const GAP = 8;

export const DropdownSelect = ({
    items,
    onSelect,
    buttonText,
    buttonIcon = faPlus,
    disabled = false
}) => {
    const [isOpen, setIsOpen] = useState(false);
    const [position, setPosition] = useState({visibility: "hidden"});
    const containerRef = useRef(null);
    const menuRef = useRef(null);

    useLayoutEffect(() => {
        if (!isOpen) return;

        const place = () => {
            const button = containerRef.current.getBoundingClientRect();
            const above = button.top - GAP * 2;
            const below = window.innerHeight - button.bottom - GAP * 2;
            const dropUp = above >= menuRef.current.scrollHeight || above >= below;

            setPosition({
                top: dropUp ? undefined : button.bottom + GAP,
                bottom: dropUp ? window.innerHeight - button.top + GAP : undefined,
                right: window.innerWidth - button.right,
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
    }, [isOpen, items]);

    /*
     * Focus the first option, because Tab cannot get here.
     *
     * This menu is portalled to the body, so inside a dialog it is a sibling of
     * the backdrop rather than a descendant of the dialog - and the modal focus
     * trap reads the DOM by containment, so it wraps Tab within the dialog and
     * never reaches these. Placing focus is what a menu does anyway, and it is
     * the only way in: this is the sole route to adding an integration, and
     * without it a keyboard could open the menu and then had nothing to press.
     *
     * Its own effect, keyed on `isOpen` alone. The one above also depends on
     * `items`, because a different set of options is a different height to place
     * - and that array is built inline by the dialog above, so it is a new one
     * on every render of that dialog. Seating focus from the same effect would
     * borrow that dependency and drag focus back to the first option out of
     * whichever one the reader had moved to.
     */
    useLayoutEffect(() => {
        if (!isOpen) return;

        menuRef.current?.querySelector("button")?.focus();
    }, [isOpen]);

    const handleBlur = (event) => {
        if (containerRef.current?.contains(event.relatedTarget) || menuRef.current?.contains(event.relatedTarget)) return;
        setIsOpen(false);
    };

    const handleSelect = (item) => {
        onSelect(item);
        setIsOpen(false);
        // The option this was called from is about to be unmounted, so without
        // this focus lands on the document - the same thing Escape below has
        // always had to answer for. Written out rather than shared with it,
        // because each handler is lifted out and run on its own by the tests.
        containerRef.current?.querySelector(".dropdown-select-btn")?.focus();
    };

    const switchOpen = () => {
        setPosition({visibility: "hidden"});
        setIsOpen(!isOpen);
    };

    /**
     * Escape closes the menu and hands focus back to the button that opened it,
     * and Tab stays among the options rather than walking out of the dialog.
     *
     * Without the second half of the Escape branch, focus is left on an option
     * that is about to be unmounted and the operator is dropped back to the top
     * of the document - which is a worse place to be than the menu they were
     * trying to leave.
     *
     * Tab is the same problem from the other end. The menu is portalled to the
     * body, so it is a sibling of the backdrop and not a descendant of the
     * dialog, and the modal trap is a keydown listener on the dialog: it never
     * hears a key pressed in here. A Tab off the last option therefore went
     * wherever document order said, which is past the end of the menu and back
     * onto the page underneath - and the blur that followed closed the menu, so
     * the reader was left on a control behind a backdrop still announcing
     * aria-modal. Answered here because the trap works by containment and this
     * menu is deliberately not contained; Escape remains the way out, and it
     * lands on the button inside the dialog, where the trap picks focus up
     * again.
     *
     * nextFocus is the trap's own rule, so a Tab in the middle of the menu is
     * still the browser's to answer and only the two ends are claimed.
     *
     * Held on the container rather than on the menu: the menu is portalled to
     * the body, but a React portal still bubbles its events through the tree it
     * was declared in, so this sees keys pressed on the button and on the
     * options alike.
     */
    const handleMenuKey = (e) => {
        /*
         * Nothing at all while the menu is closed.
         *
         * This handler sits on the container, which is mounted whether or not
         * the menu is - so with focus on the trigger it claimed Escape and
         * closed a menu that was already closed. Dialog's own Escape declines a
         * key whose default has been prevented, which is what stops a stacked
         * alert taking the dialog under it down as well, so what this actually
         * swallowed was the one key that dismisses the dialog: on the create
         * button, inside the only dialog that draws one, Escape did nothing.
         */
        if (!isOpen) return;

        if (e.key === "Escape") {
            e.preventDefault();
            setIsOpen(false);
            containerRef.current?.querySelector(".dropdown-select-btn")?.focus();
            return;
        }

        if (e.key !== "Tab") return;

        /*
         * Only a Tab this menu has an option to answer with.
         *
         * A closed menu leaves its ref null, so nextFocus answers null and the
         * key is the trigger's own - which belongs to the dialog around it. A
         * menu holding nothing answers with the container instead, because that
         * is what a dialog wants: it has a tabIndex to be focused by. This does
         * not, so claiming the key there would swallow it against an element
         * that cannot take focus and Tab would do nothing at all.
         */
        const target = nextFocus(menuRef.current, e, document.activeElement);
        if (!target || target === menuRef.current) return;

        e.preventDefault();
        target.focus?.();
    };

    if (disabled) return null;

    return (
        <div className="dropdown-select-container" ref={containerRef} onBlur={handleBlur}
             onKeyDown={handleMenuKey} tabIndex={-1}>
            <button type="button" className="dropdown-select-btn" onClick={switchOpen}>
                <FontAwesomeIcon icon={buttonIcon}/>
                <span>{buttonText}</span>
                <FontAwesomeIcon icon={faChevronDown} className={`dropdown-select-chevron ${isOpen ? "rotated" : ""}`}/>
            </button>

            {isOpen && createPortal(
                <div className="dropdown-select-menu" ref={menuRef} style={position} data-overlay-portal>
                    {/* Buttons, not focusable divs: tabIndex={0} put focus on
                        an option and then nothing answered Enter or Space
                        there, and this menu is the only way to add an
                        integration at all. */}
                    {items.map((item, index) => (
                        <button type="button" key={item.key || index} className="dropdown-select-item"
                                onClick={() => handleSelect(item)}>
                            {item.icon && <FontAwesomeIcon icon={item.icon}/>}
                            <span>{item.label}</span>
                        </button>
                    ))}
                </div>, document.body)}
        </div>
    );
};
