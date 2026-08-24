import "./styles.sass";

/**
 * The wrapping label is the toggle's whole visual - a slider span, no text -
 * so it names nothing by itself. A caller wired through FormField gets its
 * name from the external label via `id`; a standalone toggle sitting beside
 * its own text passes that text as `label`, or a screen reader announces a
 * bare unnamed checkbox.
 */
export const ToggleSwitch = ({id, checked, onChange, disabled = false, label}) => (
    <label htmlFor={id} className={`toggle-switch ${disabled ? "toggle-disabled" : ""}`}>
        <input
            id={id}
            type="checkbox"
            aria-label={label}
            checked={checked}
            onChange={(e) => onChange(e.target.checked)}
            disabled={disabled}
        />
        <span className="toggle-slider"/>
    </label>
);
