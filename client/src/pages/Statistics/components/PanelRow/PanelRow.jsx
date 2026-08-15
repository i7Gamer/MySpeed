import {FontAwesomeIcon} from "@fortawesome/react-fontawesome";
import "./styles.sass";

/**
 * One measurement on a statistics panel: what it is on the left, what it reads
 * on the right.
 *
 * The four panels drew this row four times over, and two of them drew it
 * backwards - the overview card put the icon first and the value last, the other
 * three put the text first and the icon last. The value came out at 1.1rem on
 * three of them and at an unstated h2 default, 1.5rem, on the fourth, so the
 * same kind of figure was a third larger on one card than on the card beside it.
 * Four copies of one layout is the split that keeps widening: every figure added
 * to any of them since had to pick a side.
 *
 * @param icon        the glyph for the measurement
 * @param title       what it is, in a word or two
 * @param description what qualifies it - a second reading, a spread, the target
 *                    it is measured against. Nodes rather than a string: some
 *                    rows stack two of these and one draws a bar under them
 * @param value       what it reads. Nodes too - the cards that compare against a
 *                    previous window hang a delta off the figure
 * @param level       the grade the reading earns. The glyph wears it, which is
 *                    how a verdict is stated everywhere in this interface - the
 *                    overview rows, the node cards and the detail pane all read
 *                    that way, and a value that was itself coloured was the one
 *                    thing the statistics panels did differently. The row
 *                    publishes it as well, so any part of the row can be opted
 *                    into showing it; see the graded-value mixin
 */
export const PanelRow = ({icon, title, description, value, level}) => (
    <div className="panel-row" data-grade={level || undefined}>
        <div className="panel-row-info">
            <FontAwesomeIcon icon={icon} className={"panel-row-icon" + (level ? " icon-" + level : "")}/>
            <div className="panel-row-text">
                <h2 className="panel-row-title">{title}</h2>
                {/* Only when there is one. Drawn regardless, the wrapper leaves
                    an empty line under the title, and an empty line where a
                    figure belongs reads as a measurement that went missing
                    rather than as one that was never taken. */}
                {description && <div className="panel-row-description">{description}</div>}
            </div>
        </div>
        <div className="panel-row-value">{value}</div>
    </div>
);

export default PanelRow;
