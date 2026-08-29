import {NOT_MEASURED, printableFigure} from "@/common/utils/FormatUtil";

/**
 * A figure beside its styled unit, or the statement that there is none.
 *
 * The JSX twin of formatWithUnit, for the one shape the string form cannot
 * serve: a value whose unit needs a span of its own for the stylesheet to
 * shrink. Both build on the ONE exported predicate - printableFigure - so
 * the two forms cannot drift: whatever the string form would refuse, the
 * failure placeholder in either spelling, junk and an absent column
 * included, renders as the same N/A here with no unit span beside it.
 * Before this, the views printing through the string form said N/A while
 * the two gluing their value to a span printed "-1 ms" for the same row.
 *
 * It prints FIGURES: coercion belongs to the formatter each caller chose
 * (the call sites feed it formatWhole, wholeSpeed, formatLatency and
 * convertSpeed output), so a text reading handed raw renders N/A on
 * purpose, loudly, rather than printing a column nothing coerced.
 *
 * The unit class arrives in braces on purpose: the raw-render scan forbids a
 * value interpolated beside a quoted unit-bearing class, and this component is
 * the one place that adjacency is legitimate - unquoted, it stays out of the
 * scan's sight instead of needing an exemption from it.
 */
export const FigureWithUnit = ({value, unit, unitClass}) =>
    !printableFigure(value) ? NOT_MEASURED
        : <>{value}<span className={unitClass}>{unit}</span></>;

export default FigureWithUnit;
