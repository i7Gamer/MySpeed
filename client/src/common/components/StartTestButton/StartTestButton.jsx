import {useContext} from "react";
import {FontAwesomeIcon} from "@fortawesome/react-fontawesome";
import {faGaugeHigh} from "@fortawesome/free-solid-svg-icons";
import {t} from "i18next";
import {StatusContext} from "@/common/contexts/Status";
import {ConfigContext} from "@/common/contexts/Config";
import {SpeedtestContext} from "@/common/contexts/Speedtests";
import {useAlert} from "@/common/contexts/Alert";
import {
    startBlockedReason, START_BLOCKED_RUNNING, START_BLOCKED_VIEW_MODE
} from "@/common/utils/StatusUtil";
import {startSpeedtest} from "@/common/utils/RunUtil";
import "./styles.sass";

/**
 * The overview's start control, lifted out of the status bar.
 *
 * It was the tallest thing in that bar and the only reason the bar needed to be
 * card-sized; standing on its own it sets the height of the toolbar row instead
 * and lets the bar shrink to the single line of text it actually holds.
 *
 * The decision about whether a test may be started stays in startBlockedReason,
 * shared with the header gauge - the server enforces all of it independently,
 * and two controls for one action that decide separately are how they end up
 * disagreeing.
 */
export const StartTestButton = () => {
    const [status, updateStatus, setRunning] = useContext(StatusContext);
    const [config] = useContext(ConfigContext);
    const {updateTests} = useContext(SpeedtestContext);
    const alert = useAlert();

    if (Object.entries(config).length === 0) return <></>;

    const blocked = startBlockedReason(status, config);

    // A read-only visitor could not start one, so they are not offered a
    // control that would only answer 401.
    if (blocked === START_BLOCKED_VIEW_MODE) return <></>;

    // Whether starting is allowed is decided here, where `disabled` is derived
    // from the same snapshot - passing it on only invited the two to disagree.
    const start = () => startSpeedtest({updateStatus, setRunning, updateTests, alert});

    // Named once, and read both by the eye and by a screen reader. Below 366px
    // the row cannot hold three labelled controls and the span is hidden, which
    // left the button as a bare gauge glyph with no accessible name at all -
    // the aria-label is what keeps the control announced at every width.
    const label = t(blocked === START_BLOCKED_RUNNING ? "status.running_button" : "status.start");

    return (
        <button className="start-test" onClick={start} disabled={blocked !== null} aria-label={label}>
            <FontAwesomeIcon icon={faGaugeHigh}/>
            <span>{label}</span>
        </button>
    );
};

export default StartTestButton;
