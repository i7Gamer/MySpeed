/**
 * The comparison card's figures: per-target rows for the table, and the
 * per-target series the overlay draws.
 *
 * Everything here reads a per-target statistics payload - the same wire the
 * page's own summary travels, so the same doctrine: averages through the
 * shared reader, because a proxied older node can spell any of them as text;
 * the counts strict, because they are array lengths on the server and a text
 * count is a producer that changed shape (the failed row's documented
 * convention, kept so two surfaces cannot disagree about one payload).
 *
 * A target keeps its row whatever its payload did - but a fetch that FAILED
 * and a range the target measured nothing in are different findings, and the
 * repo separates unmeasured from unreadable everywhere else: the row carries
 * `unavailable` so the cell can say "couldn't load" instead of wearing the
 * clean N/A of a line that answered honestly with nothing. Only the overlay
 * drops such a target, since a series with no points draws nothing anyway.
 */
import {hasPreviousData} from "@/common/components/Delta/deltas";
import {failureRate, readableFigure} from "@/common/utils/TestUtil";

/**
 * The four figures a row states, read the one way.
 *
 * The window a row is compared against arrives in the same shape as the row's
 * own, so both go through this: reading the two sides two different ways is
 * how one ends up coercing what the other refuses, and an arrow drawn between
 * a coerced figure and a refused one is a change nobody measured.
 *
 * Averages through the shared reader, because a proxied older node can spell
 * any of them as text; the count strict, because counts are array lengths on
 * the server and a text spelling is a producer that changed shape - the
 * failed row's own convention, which degrades to no rate rather than coercing.
 */
const comparableFigures = (summary) => ({
    download: readableFigure(summary?.download?.avg),
    upload: readableFigure(summary?.upload?.avg),
    ping: readableFigure(summary?.ping?.avg),
    failureRate: failureRate(summary?.tests?.total, summary?.tests?.failed)
});

/**
 * One row per target, in the list's own order - the order the chips draw in,
 * so a row's dot and its chip resolve the same colour from the same index.
 * The index deliberately does not wrap here: the cycle is the colour lookup's
 * business (targetSeriesToken), and a summary that wrapped it would lie to
 * anything else keyed on position.
 */
export const targetSummaries = (targets, statsById) => targets.map((target, colourIndex) => {
    const stats = statsById?.[target.id];

    /*
     * The page's own gate, asked per row: a previous window nobody tested in
     * has no figures to compare against, and its zeros must not colour a
     * row. Per row rather than per page, because the page's gate answers for
     * whatever slice it is showing and this table answers for every target
     * at once - each one narrowed to its own line, so a target added on
     * Wednesday compares against nothing while its neighbours compare.
     */
    const previous = hasPreviousData(stats?.previous) ? stats.previous : null;

    return {
        id: target.id,
        name: target.name,
        colourIndex,
        // Null is the fetch's own sentinel for "asked and failed"; a payload
        // that simply is not there yet is not a failure to report.
        unavailable: stats === null,
        ...comparableFigures(stats),
        // Null, never a half-populated object: each cell's delta refuses a
        // missing operand on its own, so this only has to be safe to read
        // through `?.`.
        previous: previous && comparableFigures(previous)
    };
});

/**
 * The union of every target's bucket instants, sorted, as the label strings
 * they arrived in.
 *
 * This feeds ONLY the axis - its span, its tick step and the single-day
 * decision. The datasets keep their own labels: the x axis is linear epoch
 * milliseconds, so series with disjoint instants share it natively, and
 * stretching every series onto this union would fill each one with nulls at
 * every OTHER target's instants - a line shredded into dashes by the
 * spanGaps-off honesty the charts keep on purpose.
 *
 * A label that names no instant is dropped: the axis maths would ignore it
 * anyway, and unlike a chart's own series there is no tooltip here that
 * looks anything up by its index.
 */
export const mergedTimeline = (seriesList) => {
    const labels = new Set();

    for (const series of Array.isArray(seriesList) ? seriesList : [])
        for (const label of Array.isArray(series?.labels) ? series.labels : [])
            if (Number.isFinite(new Date(label).getTime())) labels.add(label);

    return [...labels].sort((a, b) => new Date(a) - new Date(b));
};

/**
 * The series the overlay draws for one metric: a target's own labels and its
 * own values, colour-indexed by LIST position - a series that skipped a
 * payload-less neighbour must not take that neighbour's colour with it.
 */
export const overlaySeries = (targets, statsById, metric) => targets.flatMap((target, colourIndex) => {
    const stats = statsById?.[target.id];
    const labels = stats?.labels;
    const values = stats?.data?.[metric];

    if (!Array.isArray(labels) || !Array.isArray(values)) return [];

    return [{id: target.id, name: target.name, colourIndex, labels, values}];
});
