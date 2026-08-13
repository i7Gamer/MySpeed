/**
 * A metric icon that opens its explanation.
 *
 * A button rather than a click handler on the svg, so it can be tabbed to and
 * activated with the keyboard - Enter and Space come free with the element.
 * `type="button"` because it sits inside no form but browsers default to
 * submit, and the label is what a screen reader announces in place of an icon
 * that means nothing to it.
 *
 * Shared rather than owned by the overview row, which is where it started: the
 * detail pane draws the same glyphs for the same measurements, and a second
 * copy of a control this small is a copy that quietly stops matching.
 */
export const HelpButton = ({label, onOpen, className = "", children}) => (
    <button type="button" className={`help-button help-icon ${className}`.trim()}
            aria-label={label} title={label} onClick={onOpen}>
        {children}
    </button>
);

export default HelpButton;
