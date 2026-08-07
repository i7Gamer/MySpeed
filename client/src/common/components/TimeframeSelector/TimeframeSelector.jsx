import "./styles.sass";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faCheck, faClockRotateLeft } from "@fortawesome/free-solid-svg-icons";
import { useContext, useEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { t } from "i18next";
import Tooltip from "@/common/components/Tooltip";
import { PreferencesContext } from "@/common/contexts/Preferences";
import {
    DEFAULT_TIMEFRAME,
    TIMEFRAMES,
    parseRangeParams,
    serializeRange
} from "@/common/utils/TimeframeUtil";

const STATISTICS_PATH = "/statistics";

/**
 * One-click timeframe switch in the header, mirroring how the gauge icon starts
 * a speedtest. Selecting a preset always lands on the statistics page, so it
 * works from the overview too rather than only where the charts already are.
 */
export const TimeframeSelector = () => {
    const navigate = useNavigate();
    const location = useLocation();
    const [preferences, updatePreferences] = useContext(PreferencesContext);
    const [isOpen, setIsOpen] = useState(false);
    const containerRef = useRef(null);

    // The URL wins while it describes a range; elsewhere fall back to the stored
    // preference so the icon still shows what the next click would select.
    const activeTimeframe = parseRangeParams(new URLSearchParams(location.search))?.timeframe
        ?? preferences.defaultTimeframe ?? DEFAULT_TIMEFRAME;

    useEffect(() => {
        if (!isOpen) return;

        const handleClickOutside = (event) => {
            if (containerRef.current && !containerRef.current.contains(event.target)) setIsOpen(false);
        };

        const handleEscape = (event) => {
            if (event.key === "Escape") setIsOpen(false);
        };

        document.addEventListener("mousedown", handleClickOutside);
        document.addEventListener("keydown", handleEscape);
        return () => {
            document.removeEventListener("mousedown", handleClickOutside);
            document.removeEventListener("keydown", handleEscape);
        };
    }, [isOpen]);

    const selectTimeframe = (id) => {
        setIsOpen(false);
        updatePreferences({defaultTimeframe: id});
        navigate(`${STATISTICS_PATH}?${new URLSearchParams(serializeRange(id))}`);
    };

    return (
        <div className="timeframe-selector" ref={containerRef}>
            <Tooltip content={t("calendar.select_range")} position="bottom">
                <FontAwesomeIcon icon={faClockRotateLeft}
                                 className="header-icon"
                                 onClick={() => setIsOpen(open => !open)}/>
            </Tooltip>

            {isOpen && (
                <div className="timeframe-menu">
                    {TIMEFRAMES.map((frame) => (
                        <button
                            key={frame.id}
                            type="button"
                            className={`timeframe-menu-item${activeTimeframe === frame.id ? " item-active" : ""}`}
                            onClick={() => selectTimeframe(frame.id)}
                        >
                            <span>{t(frame.labelKey)}</span>
                            {activeTimeframe === frame.id && <FontAwesomeIcon icon={faCheck} className="item-check"/>}
                        </button>
                    ))}
                </div>
            )}
        </div>
    );
};
