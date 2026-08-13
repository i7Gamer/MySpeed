import {t} from "i18next";
import {FontAwesomeIcon} from "@fortawesome/react-fontawesome";
import {faLock} from "@fortawesome/free-solid-svg-icons";
import {lockedNoticeKeys} from "@/common/utils/AuthOutcome";
import "./styles.sass";

/**
 * What is behind the credential prompt once it is dismissed.
 *
 * There used to be nothing, which is why the prompt refused to close: the
 * config stays {} while the server refuses, so the dashboard underneath renders
 * an empty shell. An unclosable box is fine while the question is answerable -
 * and stops being fine the moment it is not. An instance with no password asks
 * for a token printed in its log, and an operator away from that log had a
 * modal they could neither answer nor leave.
 *
 * This is the page that makes closing safe: the same explanation, without the
 * trap, and a button that opens the prompt again.
 */
export const LockedNotice = ({type, onRetry}) => {
    const {title, description, hint, action} = lockedNoticeKeys(type);

    return (
        <div className="locked-notice">
            <div className="locked-card">
                <FontAwesomeIcon icon={faLock} className="locked-icon"/>
                <h1>{t(title)}</h1>
                <p className="locked-description">{t(description)}</p>
                {hint && <p className="locked-hint">{t(hint)}</p>}
                <button className="dialog-btn locked-action" onClick={onRetry}>{t(action)}</button>
            </div>
        </div>
    );
};
