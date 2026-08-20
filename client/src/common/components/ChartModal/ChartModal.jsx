import { useEffect, useCallback, useRef } from "react";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faXmark } from "@fortawesome/free-solid-svg-icons";
import { t } from "i18next";
import { hasOpenOverlay } from "@/common/contexts/Dialog";
import { useModalFocus } from "@/common/hooks/useModalFocus";
import "./styles.sass";

/**
 * @param isChart a plot, which wants the room *and* a tall body
 * @param wide    a panel that wants the room but is not a plot - see
 *                .modal-wide, which exists because a responsive grid cannot ask
 *                a shrink-to-fit dialog for the width it needs
 * @param label   the dialog's accessible name. This overlay is rendered inline
 *                rather than through the Dialog context, so no DialogHeader is
 *                ever there to name it - the caller says outright which chart
 *                was expanded.
 */
export const ChartModal = ({ isOpen, onClose, isChart = false, wide = false, toolbar, label, children }) => {
    const contentRef = useRef(null);

    // The same three promises every Dialog makes, from the same hook: focus
    // moves in when the modal opens, Tab stays inside while it is, and focus
    // returns to the card that opened it on close. Without them the backdrop
    // was purely visual - Tab walked the inert page underneath.
    useModalFocus(contentRef, {open: isOpen});

    /**
     * Only while this is the overlay the key belongs to.
     *
     * A metric's help button opens an alert over the expanded chart, and both
     * listeners sit on the document - where neither preventDefault nor
     * stopPropagation reaches a sibling - so one Escape was answered by both,
     * dismissing the alert and dropping the reader out of the chart underneath
     * it.
     *
     * Asked as "is anything else open" rather than "am I on top", which is the
     * question the dialogs and alerts ask each other: that rule reads document
     * order, and this backdrop is rendered inline on the page rather than
     * through their portal, so document order would not describe it. It has a
     * simpler answer available - it is opened from the page, so anything else
     * that is open is above it.
     */
    const handleEscape = useCallback((e) => {
        // defaultPrevented beside the overlay check: hasOpenOverlay sees only
        // the Dialog-context overlays, and a claimed key is how everything
        // outside that context - the date picker's popover - says it already
        // answered. Without it one Escape closed both.
        if (e.key !== "Escape" || e.defaultPrevented || hasOpenOverlay()) return;

        e.preventDefault();
        onClose();
    }, [onClose]);

    useEffect(() => {
        if (isOpen) {
            document.addEventListener("keydown", handleEscape);
            document.body.style.overflow = "hidden";
        }
        return () => {
            document.removeEventListener("keydown", handleEscape);
            document.body.style.overflow = "";
        };
    }, [isOpen, handleEscape]);

    if (!isOpen) return null;

    const handleBackdropClick = (e) => {
        if (e.target === e.currentTarget) {
            onClose();
        }
    };

    return (
        <div className="chart-modal-backdrop" onClick={handleBackdropClick}>
            {/* tabIndex so focus can be placed on the box itself when nothing
                inside is focusable, and aria-modal so the page behind the
                backdrop is announced as inert - the pair every Dialog carries. */}
            <div className={`chart-modal-content${isChart ? ' modal-chart' : ''}${wide ? ' modal-wide' : ''}`}
                 ref={contentRef} role="dialog" aria-modal="true" tabIndex={-1} aria-label={label}>
                {/* Named, because the glyph renders aria-hidden and an unnamed
                    button announces as nothing. data-overlay-dismiss keeps the
                    trap from seating focus here on open. */}
                <button type="button" className="chart-modal-close" data-overlay-dismiss
                        aria-label={t("dialog.close")} onClick={onClose}>
                    <FontAwesomeIcon icon={faXmark} />
                </button>
                <div className={`chart-modal-body${isChart ? ' modal-body-chart' : ''}`}>
                    {children}
                </div>
                {/* Below the chart rather than beside the close button: the
                    header strip is only as wide as the title leaves it, and a
                    control there collides with it on a narrow viewport. */}
                {toolbar && <div className="chart-modal-toolbar">{toolbar}</div>}
            </div>
        </div>
    );
};