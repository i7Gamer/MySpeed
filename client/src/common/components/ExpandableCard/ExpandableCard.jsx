import {FontAwesomeIcon} from "@fortawesome/react-fontawesome";
import {faChevronDown, faChevronUp} from "@fortawesome/free-solid-svg-icons";
import {useState} from "react";
import {clickable} from "@/common/utils/Clickable";
import "./styles.sass";

export const ExpandableCard = ({
    icon,
    title,
    subtitle,
    statusDot,
    actions,
    children,
    defaultExpanded = false,
    error = false,
    success = false
}) => {
    const [expanded, setExpanded] = useState(defaultExpanded);

    return (
        <div className={`expandable-card ${error ? "card-error" : ""} ${success ? "card-success" : ""}`}>
            {/* The header is the disclosure control, in the same shape as every
                other clickable card - and it publishes its state, because a
                card that opens with nothing announced reads as a button that
                did nothing. The nested-control guard in clickable() is what
                keeps Enter on a card action from toggling the panel; the
                actions' own clicks already stop their propagation. */}
            <div className="expandable-card-header" aria-expanded={expanded}
                 {...clickable(() => setExpanded(!expanded))}>
                <div className="expandable-card-info">
                    {icon && (
                        <div className="expandable-card-icon">
                            <FontAwesomeIcon icon={icon}/>
                        </div>
                    )}
                    <div className="expandable-card-details">
                        <h3>{title}</h3>
                        {(subtitle || statusDot) && (
                            <div className="expandable-card-status">
                                {statusDot && <span className={`status-dot ${statusDot}`}/>}
                                {subtitle && <span className="status-text">{subtitle}</span>}
                            </div>
                        )}
                    </div>
                </div>
                <div className="expandable-card-actions">
                    {actions}
                    {/* The picture of the header's state, not a second control:
                        its click still bubbles to the header, but it takes no
                        focus and says nothing - the header announces the state
                        it merely draws. */}
                    <button type="button" className="card-action-btn expand-btn"
                            tabIndex={-1} aria-hidden="true">
                        <FontAwesomeIcon icon={expanded ? faChevronUp : faChevronDown}/>
                    </button>
                </div>
            </div>

            {expanded && (
                <div className="expandable-card-body">
                    {children}
                </div>
            )}
        </div>
    );
};
