import React, {useEffect, useRef, useState, useCallback} from "react";
import {FontAwesomeIcon} from "@fortawesome/react-fontawesome";
import {useClickOutside} from "@/common/hooks/useClickOutside";
import "./styles.sass";

export const ContextMenu = ({items, position, onClose}) => {
    const menuRef = useRef(null);
    const [focusedIndex, setFocusedIndex] = useState(-1);
    const [adjustedPosition, setAdjustedPosition] = useState(position);

    const actionableItems = items.map((item, index) => ({...item, originalIndex: index}))
        .filter(item => !item.divider);

    const handleItemClick = useCallback((item) => {
        item.onClick();
        onClose();
    }, [onClose]);

    useClickOutside(true, [menuRef], onClose);

    useEffect(() => {
        const handleKeyDown = (event) => {
            switch (event.key) {
                case "Escape":
                    event.preventDefault();
                    onClose();
                    break;
                case "ArrowDown":
                    event.preventDefault();
                    setFocusedIndex(prev => {
                        const next = prev + 1;
                        return next >= actionableItems.length ? 0 : next;
                    });
                    break;
                case "ArrowUp":
                    event.preventDefault();
                    setFocusedIndex(prev => {
                        const next = prev - 1;
                        return next < 0 ? actionableItems.length - 1 : next;
                    });
                    break;
                case "Enter":
                case " ":
                    event.preventDefault();
                    if (focusedIndex >= 0 && focusedIndex < actionableItems.length) {
                        handleItemClick(actionableItems[focusedIndex]);
                    }
                    break;
                case "Tab":
                    event.preventDefault();
                    onClose();
                    break;
                default:
                    break;
            }
        };

        document.addEventListener("keydown", handleKeyDown);

        return () => document.removeEventListener("keydown", handleKeyDown);
    }, [onClose, focusedIndex, actionableItems, handleItemClick]);

    useEffect(() => {
        if (menuRef.current && position) {
            const rect = menuRef.current.getBoundingClientRect();
            const viewportWidth = window.innerWidth;
            const viewportHeight = window.innerHeight;

            let adjustedX = position.x;
            let adjustedY = position.y;

            if (position.x + rect.width > viewportWidth) {
                adjustedX = viewportWidth - rect.width - 10;
            }

            if (position.y + rect.height > viewportHeight) {
                adjustedY = viewportHeight - rect.height - 10;
            }

            setAdjustedPosition({x: adjustedX, y: adjustedY});
        }
    }, [position]);

    /**
     * Focus goes into the menu when it opens, and back to what raised it when it
     * closes.
     *
     * It took focus and never gave it back, so dismissing dropped the reader on
     * <body>: the next Tab restarted at the top of the document, and after an
     * Escape there was nothing to say where they now were. The card is still
     * there to return to - unlike the export menu beside it, which records the
     * debt instead because the same commit disables the button it would focus.
     *
     * Only when the menu still holds focus, though. A click outside closes this
     * too, and there focus belongs to whatever was clicked; pulling it back
     * would take it off the control the reader had just chosen. The body is
     * included because a menu item that ran and removed itself leaves focus
     * there, and that is the case with nowhere else for it to go.
     */
    useEffect(() => {
        const raisedFrom = document.activeElement;
        const menu = menuRef.current;

        menu?.focus();
        setFocusedIndex(0);

        return () => {
            const holder = document.activeElement;

            if (menu?.contains(holder) || holder === document.body || !holder) raisedFrom?.focus?.();
        };
    }, []);

    if (!position) return null;

    return (
        <div
            ref={menuRef}
            className="context-menu"
            style={{left: adjustedPosition.x, top: adjustedPosition.y}}
            role="menu"
            aria-label="Context menu"
            tabIndex={-1}
        >
            {items.map((item, index) => {
                if (item.divider) {
                    return <div key={index} className="context-menu-divider" role="separator"/>;
                }

                const actionableIndex = actionableItems.findIndex(ai => ai.originalIndex === index);
                const isFocused = actionableIndex === focusedIndex;

                return (
                    <div
                        key={index}
                        className={`context-menu-item${item.danger ? " context-menu-danger" : ""}${isFocused ? " context-menu-focused" : ""}`}
                        onClick={() => handleItemClick(item)}
                        onMouseEnter={() => setFocusedIndex(actionableIndex)}
                        role="menuitem"
                        aria-label={item.label}
                        tabIndex={-1}
                    >
                        {item.icon && <FontAwesomeIcon icon={item.icon}/>}
                        <span>{item.label}</span>
                    </div>
                );
            })}
        </div>
    );
};