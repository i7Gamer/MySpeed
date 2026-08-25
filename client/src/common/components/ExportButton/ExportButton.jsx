import { useCallback, useEffect, useState, useRef } from "react";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faDownload, faChevronDown, faFileLines, faCode } from "@fortawesome/free-solid-svg-icons";
import { t } from "i18next";
import { downloadRequest } from "@/common/utils/RequestUtil";
import { formatDateParam, timezoneParams } from "@/common/utils/TimeframeUtil";
import { useAlert } from "@/common/contexts/Alert";
import { useClickOutside } from "@/common/hooks/useClickOutside";
import { exportFilename } from "./filename";
import "./styles.sass";
import {EXPORT_FORMATS} from "@/common/utils/InvariantText";

export const ExportButton = ({ dateRange, allTime = false }) => {
    const alert = useAlert();
    const [isOpen, setIsOpen] = useState(false);
    const [exporting, setExporting] = useState(false);
    const dropdownRef = useRef(null);
    const buttonRef = useRef(null);

    useClickOutside(isOpen, [dropdownRef, buttonRef], () => setIsOpen(false));

    // Whether the menu took focus off the page on its way out, and the trigger
    // is therefore owed it back. A ref rather than state: paying the debt is not
    // something to render, and recording it must not schedule a render of its
    // own in the middle of an export.
    const owedFocus = useRef(false);

    /**
     * Focus back on the trigger, once the trigger is a control that can hold it.
     *
     * Not in handleExport, though that is where the debt is taken on. The same
     * call disables this button for the length of the export, and a disabled
     * element is not a focusable area: the browser's focus fixup rule takes
     * focus off it in the very commit that would have placed it there. Focusing
     * and disabling together is exactly as good as never focusing at all.
     */
    const returnFocusToTrigger = useCallback(() => {
        if (!owedFocus.current) return;

        owedFocus.current = false;
        buttonRef.current?.focus();
    }, []);

    // The export ending is what re-enables the button, so it is also the first
    // moment there is anything to give focus back to.
    useEffect(() => {
        if (!exporting) returnFocusToTrigger();
    }, [exporting, returnFocusToTrigger]);

    /**
     * Escape dismisses the menu and hands focus back to the trigger.
     *
     * What every other menu in the app already does - the settings menu, the
     * context menu, the date picker, the create menu - and the only one this had
     * nothing for. A reader who opened it and wanted neither format could only
     * Tab past both or reach for the pointer.
     *
     * Reachable because the two formats answer a keyboard now: before, opening
     * the menu was as far as anyone got without one.
     *
     * Nothing at all while the menu is closed. The handler is on the container,
     * which is always mounted, and claiming a key nothing was pressed against is
     * how the create menu came to swallow the one that dismisses the dialog
     * around it.
     */
    const handleMenuKey = (e) => {
        if (!isOpen || e.key !== "Escape") return;

        e.preventDefault();
        setIsOpen(false);
        buttonRef.current?.focus();
    };

    const handleExport = async (format) => {
        /*
         * Read before the menu closes, because closing unmounts the control
         * this was called from.
         *
         * The two formats are real buttons now, which is what lets a keyboard
         * choose one at all - and the button holding focus is exactly what
         * setIsOpen(false) takes off the page. A pointer never noticed, having
         * nothing focused to lose; a keyboard is left on <body>, so the next Tab
         * restarts at the top of the document. The trigger is what a menu owes
         * its focus back to.
         *
         * Only when the menu holds it: a click outside closes this too, and
         * there focus belongs to whatever was clicked.
         */
        if (dropdownRef.current?.contains(document.activeElement)) owedFocus.current = true;

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
        <div className="export-button-container" onKeyDown={handleMenuKey}>
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
                        <span>{EXPORT_FORMATS.csv}</span>
                    </button>
                    <button type="button" className="export-option" onClick={() => handleExport('json')}>
                        <FontAwesomeIcon icon={faCode} />
                        <span>{EXPORT_FORMATS.json}</span>
                    </button>
                </div>
            )}
        </div>
    );
};
