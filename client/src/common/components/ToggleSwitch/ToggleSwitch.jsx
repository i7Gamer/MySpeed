import "./styles.sass";

export const ToggleSwitch = ({id, checked, onChange, disabled = false}) => (
    <label htmlFor={id} className={`toggle-switch ${disabled ? "toggle-disabled" : ""}`}>
        <input
            id={id}
            type="checkbox"
            checked={checked}
            onChange={(e) => onChange(e.target.checked)}
            disabled={disabled}
        />
        <span className="toggle-slider"/>
    </label>
);
