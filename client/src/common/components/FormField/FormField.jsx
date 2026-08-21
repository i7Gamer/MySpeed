import {useId} from "react";
import ToggleSwitch from "@/common/components/ToggleSwitch";
import "./styles.sass";

export const FormField = ({
    id,
    label,
    type = "text",
    value,
    onChange,
    placeholder,
    error = false,
    disabled = false,
    min,
    max,
    decimals = false
}) => {
    const generatedId = useId();
    const inputId = id || generatedId;

    return (
        <div className="form-field">
            <label htmlFor={inputId} className={error ? "form-field-error" : ""}>{label}</label>

            {type === "text" && (
                <input
                    id={inputId}
                    type="text"
                    className={`form-field-input ${error ? "input-error" : ""}`}
                    value={value}
                    onChange={(e) => onChange(e.target.value)}
                    placeholder={placeholder}
                    disabled={disabled}
                />
            )}

            {type === "number" && (
                <input
                    id={inputId}
                    type="number"
                    className={`form-field-input ${error ? "input-error" : ""}`}
                    value={value ?? ""}
                    onChange={(e) => onChange(e.target.value === "" ? "" : Number(e.target.value))}
                    placeholder={placeholder}
                    disabled={disabled}
                    min={min}
                    max={max}
                    // Without this the browser's own validation applies the default
                    // step of 1 and refuses a fraction before the value ever
                    // reaches the field's own check - a threshold of 12.5 Mbit
                    // would simply not be typeable.
                    step={decimals ? "any" : undefined}
                />
            )}

            {type === "textarea" && (
                <textarea
                    id={inputId}
                    className={`form-field-input form-field-textarea ${error ? "input-error" : ""}`}
                    value={value}
                    onChange={(e) => onChange(e.target.value)}
                    placeholder={placeholder}
                    disabled={disabled}
                />
            )}

            {type === "boolean" && (
                <ToggleSwitch
                    id={inputId}
                    checked={value}
                    onChange={onChange}
                    disabled={disabled}
                />
            )}
        </div>
    );
};
