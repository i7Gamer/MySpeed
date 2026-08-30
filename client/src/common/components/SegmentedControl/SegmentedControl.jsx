import React, {useRef} from "react";
import {FontAwesomeIcon} from "@fortawesome/react-fontawesome";
import {activateOnKey} from "@/common/components/SelectableOption/keyActivation";
import {ARROW_STEPS, nextIndex} from "./radioNavigation";
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
 * Activation is SelectableOption's - Enter and Space through activateOnKey, a
 * second copy of that rule is a copy that stops matching - but the focus shape
 * is a radiogroup's own: one tab stop on the chosen option and arrows to move,
 * because every option a tab stop of its own is a list, whatever the roles
 * claim. A screen reader announced "radio, 1 of 3", ArrowRight did nothing,
 * and Tab walked every option instead of leaving the group.
 */
export const SegmentedControl = ({options, value, onChange, label, className = ""}) => {
    const optionRefs = useRef([]);

    // A value that matches no option - a stale preference, a removed choice -
    // must not leave the group with no tab stop at all; the first option
    // holds it then.
    const hasActive = options.some((option) => option.id === value);

    const move = (event, delta) => {
        event.preventDefault();

        const next = nextIndex(options, value, delta);
        if (next === -1) return;

        // Chosen as it is focused, the way native radios move: an arrow in a
        // radiogroup both moves and selects.
        onChange(options[next].id);
        optionRefs.current[next]?.focus();
    };

    const handleKey = (event, option) => {
        const step = ARROW_STEPS[event.key];
        if (step !== undefined) return move(event, step);

        activateOnKey(event, () => onChange(option.id));
    };

    return (
        <div className={`segmented-control ${className}`.trim()} role="radiogroup" aria-label={label}>
            {options.map((option, index) => {
                const active = value === option.id;

                return (
                    <div key={option.id}
                         ref={(node) => { optionRefs.current[index] = node; }}
                         className={`segmented-option${active ? " segmented-option-active" : ""}`}
                         role="radio" aria-checked={active}
                         tabIndex={active || (!hasActive && index === 0) ? 0 : -1}
                         onClick={() => onChange(option.id)}
                         onKeyDown={(event) => handleKey(event, option)}>
                        {option.adornment}
                        {option.icon && <FontAwesomeIcon icon={option.icon} className="segmented-option-icon"/>}
                        <span className="segmented-option-label">{option.label}</span>
                    </div>
                );
            })}
        </div>
    );
};

export default SegmentedControl;
