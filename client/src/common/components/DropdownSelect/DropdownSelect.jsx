import {FontAwesomeIcon} from "@fortawesome/react-fontawesome";
import {faChevronDown, faPlus} from "@fortawesome/free-solid-svg-icons";
import {useState, useRef, useLayoutEffect} from "react";
import {createPortal} from "react-dom";
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

    const handleBlur = (event) => {
        if (containerRef.current?.contains(event.relatedTarget) || menuRef.current?.contains(event.relatedTarget)) return;
        setIsOpen(false);
    };

    const handleSelect = (item) => {
        onSelect(item);
        setIsOpen(false);
    };

    const switchOpen = () => {
        setPosition({visibility: "hidden"});
        setIsOpen(!isOpen);
    };

    /**
     * Escape closes the menu and hands focus back to the button that opened it.
     *
     * Without the second half, focus is left on an option that is about to be
     * unmounted and the operator is dropped back to the top of the document -
     * which is a worse place to be than the menu they were trying to leave.
     *
     * Held on the container rather than on the menu: the menu is portalled to
     * the body, but a React portal still bubbles its events through the tree it
     * was declared in, so this sees keys pressed on the button and on the
     * options alike.
     */
    const handleMenuKey = (e) => {
        if (e.key !== "Escape") return;

        e.preventDefault();
        setIsOpen(false);
        containerRef.current?.querySelector(".dropdown-select-btn")?.focus();
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
                <div className="dropdown-select-menu" ref={menuRef} style={position}>
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
