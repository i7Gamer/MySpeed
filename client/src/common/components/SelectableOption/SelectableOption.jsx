import React, {useLayoutEffect, useRef} from "react";
import {FontAwesomeIcon} from "@fortawesome/react-fontawesome";
import {activateOnKey} from "./keyActivation";
import {ARROW_STEPS} from "@/common/components/SegmentedControl/radioNavigation";
import "./styles.sass";

/**
 * role="radiogroup", which is what makes the role on each option valid - a
 * radio that belongs to no group is announced as one that belongs to nothing.
 * Every list this holds is single-select: each option binds
 * active={value === option.id} against one value.
 */
export const SelectableList = ({children, className = "", ...rest}) => {
    const group = useRef(null);
    const radios = () => [...group.current.querySelectorAll('[role="radio"]')]
        .filter(option => option.closest('[role="radiogroup"]') === group.current);

    useLayoutEffect(() => {
        const options = radios();
        const selected = options.find(option => option.getAttribute("aria-checked") === "true") ?? options[0];
        for (const option of options) option.tabIndex = option === selected ? 0 : -1;
    });

    const navigate = (event) => {
        const step = ARROW_STEPS[event.key];
        if (step === undefined && event.key !== "Home" && event.key !== "End") return;
        const options = radios();
        const current = options.indexOf(event.target.closest('[role="radio"]'));
        if (current === -1) return;
        event.preventDefault();
        const next = event.key === "Home" ? 0 : event.key === "End" ? options.length - 1
            : (current + step + options.length) % options.length;
        options[next].focus();
        options[next].click();
    };

    return <div className={`selectable-list ${className}`.trim()} role="radiogroup" {...rest}
                ref={group} onKeyDown={navigate}>
        {children}
    </div>;
};


export const SelectableOption = ({
    active = false,
    onClick,
    icon,
    image,
    title,
    description,
    showRadio = true,
    className = "",
    children
}) => {
    const classes = [
        "selectable-option",
        active ? "selectable-option-active" : "",
        className
    ].filter(Boolean).join(" ");

    return (
        // A plain div with an onClick was all this was: no tab stop, no role
        // and no key handler, so every settings dialog that uses these could be
        // read from the keyboard and none of them could be answered - Tab went
        // straight past the whole list to the Save button.
        <div className={classes} onClick={onClick} onKeyDown={(e) => activateOnKey(e, onClick)}
             tabIndex={0} role="radio" aria-checked={active}>
            {icon && (
                <FontAwesomeIcon icon={icon} className="selectable-option-icon"/>
            )}
            {image && (
                <img src={image.src} alt={image.alt || ""} className="selectable-option-image"/>
            )}
            <div className="selectable-option-text">
                {children ?? (
                    <>
                        {title !== undefined && <h3>{title}</h3>}
                        {description !== undefined && <p>{description}</p>}
                    </>
                )}
            </div>
            {showRadio && (
                <div className={`selectable-option-radio${active ? " selectable-option-radio-active" : ""}`}/>
            )}
        </div>
    );
};
