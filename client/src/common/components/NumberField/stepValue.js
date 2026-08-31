/**
 * What one press of the app's stepper does to a number field.
 *
 * Its own module because it is the whole of the stepper's behaviour and none of
 * it wants a DOM. Strings in and strings out: the native input hands its
 * callers `e.target.value`, every field here is written against that, and a
 * version that answered numbers would have collapsed "" and 0 into one value.
 */

/** How many decimals a number is written to, from the number itself. */
const decimals = (n) => {
    const written = String(n);
    const point = written.indexOf(".");

    return point === -1 ? 0 : written.length - point - 1;
};

/**
 * The sum, written to as many decimals as its inputs had.
 *
 * Floating point is the whole reason: 0.1 + 0.2 is 0.30000000000000004 and
 * 1.1 - 0.2 is 0.9000000000000001, and a field steps by showing its value, so
 * the reader would simply see that. Rounded to whichever of the two is finer,
 * rather than to the step's own precision - a typed 2.25 stepped by 0.5 is
 * 2.75, and rounding to the step's one decimal would quietly eat the 0.05 the
 * reader put there.
 */
const exact = (value, step) => Number((value + step).toFixed(Math.max(decimals(value), decimals(step))));

/** The field's value as a number, or null where there is not one to move. */
const current = (value) => {
    const parsed = parseFloat(value);

    return Number.isFinite(parsed) ? parsed : null;
};

/**
 * The floor a press starts an empty field from.
 *
 * Either direction lands here: there is no value to add a step to, so the press
 * means "give me the first legal one". Adding to nothing is NaN, which a number
 * input renders as the empty field it started from - a button that visibly does
 * nothing.
 */
const floor = ({min}) => min ?? 0;

/**
 * The value after one press, as the string the field will show.
 *
 * @param value      what the field holds now
 * @param direction  1 for the up button, -1 for the down button
 * @param bounds     the field's own min, max and step
 */
export const stepValue = (value, direction, {min, max, step = 1} = {}) => {
    const from = current(value);

    if (from === null) return String(floor({min}));

    const next = exact(from, direction * step);
    const clamped = Math.min(max ?? Infinity, Math.max(min ?? -Infinity, next));

    return String(clamped);
};

/**
 * Whether a press in this direction would change nothing, and so whether the
 * button should be dead.
 *
 * An empty field is never at a bound: a press moves it to the floor, and
 * disabling the button there would leave no way to start the field from the
 * stepper at all.
 */
export const atBound = (value, direction, {min, max} = {}) => {
    const from = current(value);

    if (from === null) return false;

    return direction > 0 ? max !== undefined && from >= max : min !== undefined && from <= min;
};
