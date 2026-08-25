import React from "react";
import {FontAwesomeIcon} from "@fortawesome/react-fontawesome";
import {activateOnKey} from "./keyActivation";
import "./styles.sass";

/**
 * role="radiogroup", which is what makes the role on each option valid - a
 * radio that belongs to no group is announced as one that belongs to nothing.
 * Every list this holds is single-select: each option binds
 * active={value === option.id} against one value.
 */
export const SelectableList = ({children, className = "", ...rest}) => (
    <div className={`selectable-list ${className}`.trim()} role="radiogroup" {...rest}>
        {children}
    </div>
);


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