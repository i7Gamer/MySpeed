/**
 * What one target is graded against, and how it is coloured.
 *
 * Shared by the row list, the detail pane and the statistics, so a measurement
 * cannot change verdict between two views of it.
 */

/**
 * The thresholds a test of this target is graded against: the target's own
 * optimal values where the operator set them, the instance-wide settings
 * everywhere else. Mirrors resolveLimits in server/controller/targets.js,
 * which makes the same call for notifications and recommendations - the two
 * ends judging one measurement differently would be worse than either answer.
 *
 * Works on the viewer-facing row too, which carries the optimal* fields, and
 * on no target at all - a row whose target was deleted, or recorded before
 * targets existed, falls back to the global settings wholesale.
 */
export const resolveLimits = (target, config = {}) => ({
    ping: target?.optimalPing ?? config.ping,
    download: target?.optimalDownload ?? config.download,
    upload: target?.optimalUpload ?? config.upload
});

/**
 * The colour cycle the dots and chips draw from: the chart's own series
 * tokens, which already exist in every palette and both themes and are held
 * legible by the palette-contrast tests. Ordered so neighbouring targets get
 * the most distinguishable pair first.
 */
const TARGET_SERIES = ["download", "upload", "ping", "average", "jitter", "loaded"];

export const targetColour = (index) =>
    `var(--chart-${TARGET_SERIES[((index % TARGET_SERIES.length) + TARGET_SERIES.length) % TARGET_SERIES.length]})`;

/**
 * A target's position in the round order, which is what its colour is keyed
 * on - the list endpoint answers in that order. -1 when the id is not in the
 * list, which the callers read as "draw no dot".
 */
export const roundIndexById = (targets, id) =>
    targets.findIndex((target) => target.id === id);

// A row that names no target - one recorded before targets existed - and a row
// whose column is simply absent are the same case, and must group together
// rather than each be a category of one.
const targetOf = (test) => test?.targetId ?? null;

/**
 * The nearest earlier test measured against the same target.
 *
 * Not simply the row before, for the reason previousConnection gives for its
 * own walk: on an unfiltered list the row before is whichever target the round
 * happened to measure next, and every "since last time" figure the detail pane
 * shows is a difference between two measurements. Compared across targets
 * those differences are arithmetic on unrelated quantities - a LAN target's
 * 940 Mbit/s against an internet target's 95 reads as the line having lost
 * ninety percent overnight.
 *
 * undefined when there is no earlier test of this target in the list, which is
 * what the row past the end already answered: the pane shows no change figures
 * rather than a wrong one. The list is newest first, so earlier in time is
 * later in the array.
 */
export const previousOfTarget = (tests, index) => {
    if (!Array.isArray(tests)) return undefined;

    const target = targetOf(tests[index]);

    for (let i = index + 1; i < tests.length; i++)
        if (targetOf(tests[i]) === target) return tests[i];

    return undefined;
};

// The chip that is not a target: everything, unfiltered - and the default.
export const ALL_TARGETS = "all";

/**
 * Which target the views are narrowed to, or null for all of them.
 *
 * Null rather than the stored preference whenever the selection cannot mean
 * anything: a target that was deleted since it was chosen, an instance with
 * fewer than two targets - where the chips are not drawn, so a stale selection
 * would filter a list with no visible way to unfilter it - or a selection made
 * on another instance.
 *
 * That last one is why the node is asked for. The preference is one value in
 * one browser, and target ids are per-instance: id 3 on the node being looked
 * at is a different target from the id 3 the chip was clicked on, or no target
 * at all. Carried across, the filter re-aimed itself silently - the chip row
 * relabels itself, so the page stayed internally consistent and gave no hint
 * that most of the node's history was being hidden by a choice made elsewhere.
 */
export const selectedTargetId = (preferences, targets, node) => {
    if (targets.length < 2) return null;
    if ((preferences?.selectedTargetNode ?? null) !== (node ?? null)) return null;

    const selected = preferences?.selectedTarget;
    return targets.some((target) => target.id === selected) ? selected : null;
};

/**
 * The one target a whole page is showing, if it is showing one - which is not
 * quite the chip selection.
 *
 * An instance with a single target draws no chips, so there is nothing to
 * select and selectedTargetId answers null; but every row on that page still
 * belongs to that target, and grading the page's own summaries against the
 * instance-wide settings while every row beside them is graded against the
 * target's own optima put two contradicting verdicts on one screen - the
 * latest-test card calling a download excellent against the target's 500
 * beside an average card calling the same line short of the global 100.
 *
 * null when the page really is showing a mixture, where only the global
 * settings can judge an average across targets.
 */
export const pageTarget = (targets, preferences, node) => {
    if (targets.length === 1) return targets[0];

    const selected = selectedTargetId(preferences, targets, node);
    return selected === null ? null : targets.find((target) => target.id === selected) ?? null;
};
