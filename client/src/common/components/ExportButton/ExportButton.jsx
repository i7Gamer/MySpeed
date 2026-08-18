import { useState, useRef } from "react";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faDownload, faChevronDown, faFileLines, faCode } from "@fortawesome/free-solid-svg-icons";
import { t } from "i18next";
import { downloadRequest } from "@/common/utils/RequestUtil";
import { formatDateParam, timezoneParams } from "@/common/utils/TimeframeUtil";
import { useAlert } from "@/common/contexts/Alert";
import { useClickOutside } from "@/common/hooks/useClickOutside";
import { exportFilename } from "./filename";
import "./styles.sass";

export const ExportButton = ({ dateRange, allTime = false }) => {
    const alert = useAlert();
    const [isOpen, setIsOpen] = useState(false);
    const [exporting, setExporting] = useState(false);
    const dropdownRef = useRef(null);
    const buttonRef = useRef(null);

    useClickOutside(isOpen, [dropdownRef, buttonRef], () => setIsOpen(false));

    const handleExport = async (format) => {
        setExporting(true);
        setIsOpen(false);

        const fromParam = formatDateParam(dateRange.from);
        const toParam = formatDateParam(dateRange.to);

        try {
            const query = new URLSearchParams({
                from: fromParam, to: toParam, format, ...timezoneParams()
            });

            // Goes through RequestUtil rather than a bare fetch so the export
            // carries the password header and honours the selected node - a raw
            // fetch silently 401'd under a password and always hit the local
            // instance even while a remote node was being viewed.
            await downloadRequest(`/speedtests/export?${query}`, {}, {},
                exportFilename({allTime, from: fromParam, to: toParam, format}));
        } catch (error) {
            console.error('Export failed:', error);
            alert.openAlert(t("failed"), error.message, { buttonText: t("dialog.okay") });
        } finally {
            setExporting(false);
        }
    };

    return (
        <div className="export-button-container">
            {/* Named for a screen reader as well as for the eye: below 480px
                the label span is hidden and the button was left as a bare
                download glyph with no accessible name - the same collapse the
                start button beside it makes, and the same fix. */}
            <button
                type="button"
                className="export-button"
                ref={buttonRef}
                onClick={() => setIsOpen(!isOpen)}
                disabled={exporting}
                aria-label={t("statistics.export.button")}
                aria-expanded={isOpen}
            >
                <FontAwesomeIcon icon={faDownload} className="export-icon" />
                <span className="export-text">{t("statistics.export.button")}</span>
                <FontAwesomeIcon icon={faChevronDown} className={`chevron-icon ${isOpen ? 'open' : ''}`} />
            </button>

            {/* Buttons, like the one that opens them. The trigger above was
                already named and already said whether it was open, while the two
                formats behind it were click-only divs - so a keyboard reached
                the menu, opened it, and then had nothing to press. Each holds an
                icon and a span, which a button may contain. */}
            {isOpen && (
                <div className="export-dropdown" ref={dropdownRef}>
                    <button type="button" className="export-option" onClick={() => handleExport('csv')}>
                        <FontAwesomeIcon icon={faFileLines} />
                        <span>{t("storage.csv")}</span>
                    </button>
                    <button type="button" className="export-option" onClick={() => handleExport('json')}>
                        <FontAwesomeIcon icon={faCode} />
                        <span>{t("storage.json")}</span>
                    </button>
                </div>
            )}
        </div>
    );
};
