import React from "react";
import {FontAwesomeIcon} from "@fortawesome/react-fontawesome";
import {activateOnKey} from "@/common/components/SelectableOption/keyActivation";
import "./styles.sass";

/**
 * A short list of choices, on one line.
 *
 * The same job as SelectableList and a different shape for it. A SelectableOption
 * is a row with a title and a sentence under it, which is right when the choice
 * needs explaining and wrong when there are two of them and the labels already
 * say everything: the preferences dialog had thirteen such rows across five
 * sections, about 55rem of content in a dialog that caps at the viewport, and
 * every new preference made it worse.
 *
 * The sentence is not lost. It moved into the explanation behind the section's
 * icon - see PreferencesInfo - which is the same control the overview already
 * puts on every metric glyph, so it is a gesture the reader has met before.
 *
 * Keyboard behaviour is SelectableOption's, imported rather than reproduced:
 * role="radio" inside a role="radiogroup", Enter and Space to choose, Tab to
 * leave. A second copy of that rule is a copy that stops matching.
 */
export const SegmentedControl = ({options, value, onChange, label, className = ""}) => (
    <div className={`segmented-control ${className}`.trim()} role="radiogroup" aria-label={label}>
        {options.map((option) => {
            const active = value === option.id;

            return (
                <div key={option.id}
                     className={`segmented-option${active ? " segmented-option-active" : ""}`}
                     role="radio" aria-checked={active} tabIndex={0}
                     onClick={() => onChange(option.id)}
                     onKeyDown={(event) => activateOnKey(event, () => onChange(option.id))}>
                    {option.adornment}
                    {option.icon && <FontAwesomeIcon icon={option.icon} className="segmented-option-icon"/>}
                    <span className="segmented-option-label">{option.label}</span>
                </div>
            );
        })}
    </div>
);

export default SegmentedControl;
