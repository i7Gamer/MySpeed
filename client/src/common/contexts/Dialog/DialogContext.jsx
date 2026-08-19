import React, {createContext, useCallback, useContext, useEffect, useId, useRef, useState} from "react";
import {createPortal} from "react-dom";
import {FontAwesomeIcon} from "@fortawesome/react-fontawesome";
import {faClose} from "@fortawesome/free-solid-svg-icons";
import {t} from "i18next";
import {useModalFocus} from "@/common/hooks/useModalFocus";
import "./styles.sass";

/**
 * The id the dialog points `aria-labelledby` at, handed to whoever draws the
 * heading.
 *
 * The two halves are written apart - Dialog owns the box, DialogHeader owns the
 * title, and consumers compose them - so the only way to name the dialog after
 * its own heading is for the id to travel between them. Generated per dialog
 * rather than fixed, because two of these can be mounted at once and a repeated
 * id names the wrong one.
 */
const DialogLabelContext = createContext(undefined);

/**
 * Every overlay in the app - a Dialog, and every alert - paints this same
 * backdrop at the same z-index, so the one the user sees on top is simply the
 * last one in the document. One that is fading out has given up its turn.
 */
const OVERLAY_AREA_SELECTOR = ".dialog-area:not(.dialog-area-hidden)";

/**
 * Whether `area` is the backdrop of the overlay currently on top.
 *
 * Both overlay systems listen for Escape on the document, and neither
 * preventDefault nor stopPropagation reaches a sibling listener on the same
 * node: one key was answered by all of them. That went unnoticed while every
 * alert was opened over a page, but the "remove password" confirmation is
 * opened over a Dialog, and escaping out of it faded out the password dialog
 * underneath as well - discarding the password typed into it.
 *
 * Asking the document keeps no bookkeeping that could fall out of sync, and it
 * answers with what the user actually sees on top rather than with whichever
 * listener happened to be registered last.
 */
export const isTopmostOverlay = (area) => {
    const areas = document.querySelectorAll(OVERLAY_AREA_SELECTOR);
    return areas.length > 0 && areas[areas.length - 1] === area;
};

/**
 * Whether any overlay of the stacking kind is open at all.
 *
 * For an overlay that cannot ask the question above. isTopmostOverlay compares
 * document order, which stands in for paint order only because every overlay it
 * was written for shares one z-index and one portal - so an overlay rendered
 * inline on the page, at a z-index of its own, would be judged by where it
 * happens to sit in the markup rather than by what the user sees.
 *
 * The expanded chart is the case, and it can answer a weaker question instead:
 * it is opened from the page, so nothing is ever underneath it, and anything
 * else that is open is therefore on top. A backdrop that is fading out is
 * excluded here as it is above - it has given up its turn.
 */
export const hasOpenOverlay = () => document.querySelectorAll(OVERLAY_AREA_SELECTOR).length > 0;

/**
 * @param label a name for a dialog that draws no DialogHeader. Every other one
 *              is named after its own heading, by id - but an aria-labelledby
 *              pointing at an element nobody rendered resolves to nothing, and
 *              an empty name is worse than no role at all, so the one dialog
 *              with a banner instead of a header says its name outright.
 */
export const Dialog = ({open, onClose, className, disableClose, label, children}) => {
    const areaRef = useRef();
    const dialogRef = useRef();
    const [visible, setVisible] = useState(false);
    const isClosingRef = useRef(false);
    const labelId = useId();

    // A Dialog is never stacked under another Dialog, so open and focused are
    // the same state for it - unlike an alert, which can be either.
    useModalFocus(dialogRef, {open: visible});

    useEffect(() => {
        if (open && !visible) {
            setVisible(true);
            isClosingRef.current = false;
        } else if (!open && visible && !isClosingRef.current) {
            isClosingRef.current = true;
            areaRef.current?.classList.add("dialog-area-hidden");
            dialogRef.current?.classList.add("dialog-hidden");
        }
    }, [open, visible]);

    const handleClose = useCallback(() => {
        if (disableClose || isClosingRef.current) return;
        isClosingRef.current = true;
        areaRef.current?.classList.add("dialog-area-hidden");
        dialogRef.current?.classList.add("dialog-hidden");
    }, [disableClose]);

    const forceClose = useCallback(() => {
        if (isClosingRef.current) return;
        isClosingRef.current = true;
        areaRef.current?.classList.add("dialog-area-hidden");
        dialogRef.current?.classList.add("dialog-hidden");
    }, []);

    const handleAnimationEnd = (e) => {
        if (e.animationName === "fadeOut") {
            setVisible(false);
            isClosingRef.current = false;
            onClose?.();
        }
    };

    const handleBackdropClick = (e) => {
        if (e.target === areaRef.current) handleClose();
    };

    useEffect(() => {
        if (!visible) return;
        const handleKeyDown = (e) => {
            // A key another overlay has already answered is not answered twice.
            // The backdrop rule alone is not enough: an alert hides its own
            // backdrop from inside the keypress that closes it, so a listener
            // running later in that same event finds itself on top and closes as
            // well - which is the bug, back again, whenever the alert's listener
            // happens to be registered first. preventDefault reaches no sibling
            // listener, but what it sets is readable by one.
            if (e.defaultPrevented) return;

            if (e.key === "Escape" && !disableClose && isTopmostOverlay(areaRef.current)) {
                e.preventDefault();
                handleClose();
            }
        };
        document.addEventListener("keydown", handleKeyDown);
        return () => document.removeEventListener("keydown", handleKeyDown);
    }, [visible, disableClose, handleClose]);

    if (!visible) return null;

    return createPortal(
        <div className="dialog-area" ref={areaRef} onClick={handleBackdropClick}>
            {/* tabIndex so focus can be placed on the box itself, which is where
                it goes when nothing inside is focusable - and aria-modal so the
                page behind the backdrop is announced as inert, which it already
                behaves as. */}
            <div className={`dialog${className ? ` ${className}` : ""}`} ref={dialogRef}
                 role="dialog" aria-modal="true" tabIndex={-1}
                 aria-label={label} aria-labelledby={label ? undefined : labelId}
                 onAnimationEnd={handleAnimationEnd}>
                <DialogLabelContext.Provider value={labelId}>
                    {typeof children === "function" ? children({close: handleClose, forceClose}) : children}
                </DialogLabelContext.Provider>
            </div>
        </div>,
        document.body
    );
};

export const DialogHeader = ({children, onClose, disableClose}) => (
    <div className="dialog-header">
        <h4 className="dialog-text" id={useContext(DialogLabelContext)}>{children}</h4>
        {/* A button, not the glyph on its own. FontAwesome renders its svg
            aria-hidden and an svg is not in the tab order, so the close control
            announced as nothing and could not be reached - a reader was never
            told it existed and had to know to press Escape. */}
        {!disableClose && (
            <button type="button" className="dialog-icon-button" data-overlay-dismiss aria-label={t("dialog.close")} onClick={onClose}>
                <FontAwesomeIcon icon={faClose} className="dialog-text dialog-icon"/>
            </button>
        )}
    </div>
);

export const DialogBody = ({children}) => <div className="dialog-main">{children}</div>;

export const DialogFooter = ({children}) => <div className="dialog-buttons">{children}</div>;
