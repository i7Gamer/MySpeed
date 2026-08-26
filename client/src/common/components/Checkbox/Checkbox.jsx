import "./styles.sass";

/**
 * A checkbox drawn by the stylesheet rather than by the operating system.
 *
 * The one this replaces was a bare input with `accent-color` on it, which is
 * the browser's own box with a tint: a different shape on every platform, no
 * hover state, and nothing of the palette beyond the one colour. It is the
 * provider card's selection control with corners - see styles.sass.
 *
 * The input is still the input. It is made transparent and laid over the box,
 * so the click target, the keyboard, the label's `for` and every screen reader
 * keep working; only the paint is ours. `label` names it, for the same reason
 * ToggleSwitch takes one: the visible words are in a sibling element, so
 * without it the box is announced as an unnamed checkbox.
 */
export const Checkbox = ({id, checked, onChange, disabled = false, label}) => (
    <span className={`checkbox ${disabled ? "checkbox-disabled" : ""}`}>
        <input
            id={id}
            type="checkbox"
            aria-label={label}
            checked={checked}
            onChange={(e) => onChange(e.target.checked)}
            disabled={disabled}
        />
        <span className="checkbox-box" aria-hidden="true">
            {/* Stroked rather than a ✓, which would land on whatever glyph the
                reader's font has for it - and can be drawn on, which a
                character cannot. */}
            <svg viewBox="0 0 24 24" focusable="false">
                <path className="checkbox-tick" d="M5 12.5l4.5 4.5L19 7.5"/>
            </svg>
        </span>
    </span>
);
