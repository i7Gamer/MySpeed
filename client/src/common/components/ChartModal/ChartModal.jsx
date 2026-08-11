import { useEffect, useCallback } from "react";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faXmark } from "@fortawesome/free-solid-svg-icons";
import "./styles.sass";

/**
 * @param isChart a plot, which wants the room *and* a tall body
 * @param wide    a panel that wants the room but is not a plot - see
 *                .modal-wide, which exists because a responsive grid cannot ask
 *                a shrink-to-fit dialog for the width it needs
 */
export const ChartModal = ({ isOpen, onClose, isChart = false, wide = false, toolbar, children }) => {
    const handleEscape = useCallback((e) => {
        if (e.key === "Escape") {
            onClose();
        }
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
            <div className={`chart-modal-content${isChart ? ' modal-chart' : ''}${wide ? ' modal-wide' : ''}`}>
                <button className="chart-modal-close" onClick={onClose}>
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