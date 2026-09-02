import {useId} from "react";
import ToggleSwitch from "@/common/components/ToggleSwitch";
import NumberField from "@/common/components/NumberField";
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
    decimals = false,
    options = []
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
                    value={value ?? ""}
                    onChange={(e) => onChange(e.target.value)}
                    placeholder={placeholder}
                    disabled={disabled}
                />
            )}

            {type === "number" && (
                // Through NumberField rather than an input of its own, so there
                // is one number field in the client to fix. It hands back the
                // raw string every input does; the conversion below is this
                // form's own contract, since the integration forms store typed
                // values.
                <NumberField
                    id={inputId}
                    className={`form-field-input ${error ? "input-error" : ""}`}
                    value={value ?? ""}
                    onChange={(next) => onChange(next === "" ? "" : Number(next))}
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
                    value={value ?? ""}
                    onChange={(e) => onChange(e.target.value)}
                    placeholder={placeholder}
                    disabled={disabled}
                />
            )}

            {type === "select" && (
                // A native select rather than the dropdown menu the dialog's
                // add button uses: that one is a command menu, this is a
                // value. The blank first entry is "none", which the server
                // reads as its default, and it wears the placeholder so the
                // default has a name.
                //
                // Falling back to the label, because a field definition that
                // names no placeholder drew that entry empty: a nameless first
                // option in an open list, announced as nothing at all and
                // indistinguishable from a rendering fault. The label is the
                // one name every field has, and it is the same fallback
                // IntegrationDialog's getPlaceholder already makes for the
                // other three types.
                <span className="select-wrap">
                    <select
                        id={inputId}
                        className={`form-field-input select-field ${error ? "input-error" : ""}`}
                        value={value ?? ""}
                        onChange={(e) => onChange(e.target.value)}
                        disabled={disabled}
                    >
                        <option value="">{placeholder ?? label}</option>
                        {options.map((option) => (
                            <option key={option.value} value={option.value}>{option.label}</option>
                        ))}
                        {/* A stored value the list no longer offers - a locale
                            dropped in an upgrade - is shown as itself rather
                            than as a blank control that is still sent on save. */}
                        {value && !options.some((option) => option.value === value) && (
                            <option value={value}>{value}</option>
                        )}
                    </select>
                </span>
            )}

            {type === "boolean" && (
                <ToggleSwitch
                    id={inputId}
                    checked={value ?? false}
                    onChange={onChange}
                    disabled={disabled}
                />
            )}
        </div>
    );
};
