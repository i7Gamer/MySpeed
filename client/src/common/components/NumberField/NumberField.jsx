import {FontAwesomeIcon} from "@fortawesome/react-fontawesome";
import {faMinus, faPlus} from "@fortawesome/free-solid-svg-icons";
import {atBound, stepValue} from "./stepValue";
import "./styles.sass";

/**
 * A number field, with the app's own stepper where one is worth offering.
 *
 * The browser's spin buttons are off everywhere now (see default.sass): they
 * are drawn outside the palette, in a hit area sized for a mouse and nothing
 * else. This is what replaces them where a step is actually useful - the pause
 * dialog's half-hour increments - and the plain field everywhere the step would
 * have been noise, which is most places. Stepping 1000 Mbps by 1 is not a
 * feature anybody wanted.
 *
 * Opt-in rather than automatic, so adopting the component somewhere does not
 * silently change how that field looks.
 */

/**
 * The step to move by, which is not always the one the input is given.
 *
 * FormField hands its decimal fields `step="any"` so the browser's own
 * validation stops refusing fractions. That is a valid attribute and not a
 * number; the arithmetic falls back to 1 rather than to NaN.
 */
const stepSize = (step) => (Number.isFinite(Number(step)) ? Number(step) : 1);

export const NumberField = ({
    value,
    onChange,
    stepper = false,
    min,
    max,
    step,
    className = "",
    placeholder,
    disabled = false,
    id
}) => {
    const bounds = {min, max, step: stepSize(step)};

    const field = (
        <input
            id={id}
            type="number"
            // Without this a phone offers the full keyboard for a field that
            // only takes digits and a separator.
            inputMode="decimal"
            className={className}
            value={value ?? ""}
            onChange={(e) => onChange(e.target.value)}
            placeholder={placeholder}
            disabled={disabled}
            min={min}
            max={max}
            step={step}
        />
    );

    if (!stepper) return field;

    /*
     * The buttons are a pointer affordance and nothing more.
     *
     * A number input is already exposed as a spinbutton, already answers the
     * arrow keys, and already announces its own bounds - so two extra tab stops
     * per field would be a third way to reach one value, and a worse one. They
     * are hidden from the accessibility tree and skipped by the tab order
     * instead, which also keeps this component free of new strings: a reachable
     * button needs a name, and a name is a key in twenty-three locale files.
     */
    const press = (direction) => (
        <button
            type="button"
            className={`number-field-step number-field-step-${direction > 0 ? "up" : "down"}`}
            // A mousedown on a button blurs the field, and a caller that checks
            // its value on blur would fire that on every press of its own
            // stepper.
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => onChange(stepValue(value ?? "", direction, bounds))}
            disabled={disabled || atBound(value ?? "", direction, bounds)}
            aria-hidden="true"
            tabIndex={-1}
        >
            <FontAwesomeIcon icon={direction > 0 ? faPlus : faMinus}/>
        </button>
    );

    return (
        <div className="number-field">
            {press(-1)}
            {field}
            {press(1)}
        </div>
    );
};
