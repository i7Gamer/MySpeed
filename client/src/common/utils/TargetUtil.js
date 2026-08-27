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
 * Whether a stored chip value names a target at all.
 *
 * "What this browser last clicked" is not the same set of values as "a target
 * id": the first chip in the row is ALL_TARGETS, a string, and choosing it
 * writes that string into the very field the other chips write an id into.
 * Every reader that holds the target list filters the sentinel out by accident,
 * because no target's id equals it - storedTargetId answers without that list,
 * so it has to know the shape instead. Ids are the speedtests table's
 * autoincrement key, so a positive integer and nothing else, which also throws
 * out whatever some future version might leave in the same field.
 *
 * What the guard is worth: "all" reaching a request as target=all earns a 400
 * from the digits-only parseTargetParam in server/routes/speedtests.js, and a
 * 400 on the first list of a page load paints the dead-end "there are no tests"
 * screen over an instance with years of them.
 */
const isTargetId = (value) => Number.isInteger(value) && value > 0;

/**
 * The chip this browser last clicked, for this instance, without asking whether
 * it still names a target here.
 *
 * The node guard is not a check against the list but against the preference
 * itself - the id was written down beside the node it was chosen on - so this
 * can say "no usable choice was made here" while knowing nothing about which
 * targets exist. Null rather than undefined for the absence, because every
 * caller compares against null: the row dots ask `selectedTarget === null`, and
 * undefined would draw a dot on a filtered list.
 */
export const storedTargetId = (preferences, node) => {
    if ((preferences?.selectedTargetNode ?? null) !== (node ?? null)) return null;

    const stored = preferences?.selectedTarget;
    return isTargetId(stored) ? stored : null;
};

// What clearing the chip writes: both halves, because the node stamp means
// nothing without a choice beside it. See chipIsStale for when it is written.
export const NO_SELECTION = {selectedTarget: null, selectedTargetNode: null};

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

    const selected = storedTargetId(preferences, node);
    return targets.some((target) => target.id === selected) ? selected : null;
};

/**
 * The same question one round trip earlier: which target the next request
 * should ask for, while the list it would be checked against is still on its
 * way. `targets` is the raw state here - null means "no answer yet", an array
 * means the fetch is over, whether it answered rows, an empty instance, or an
 * error the provider has stopped expecting anything further from.
 *
 * The check above needs that list, and the list is the last thing to land: the
 * target fetch cannot start until the config has, while the overview asks for
 * its first page of tests at mount. Answering null until then was answering "no
 * filter", which is not "not yet known" - so a reader whose chip narrows both
 * pages to one target was served every target's rows first, and the query then
 * changed under the effect that had issued it and re-fired: two list requests
 * for one page view, and on the statistics two aggregations of the whole
 * history.
 *
 * Trusting the preference is by far the cheaper guess. It is right for every
 * reader whose chip still names a live target, which is the state the
 * preference is written in; where it is wrong the arriving list changes the
 * answer and the same single re-fire that happens today corrects it - and
 * chipIsStale then throws the dead chip away, so no reader pays that twice. The
 * guess is only allowed because these are page queries, which are re-asked as
 * often as the answer changes. Anything that is not re-asked reads
 * selectedTargetId instead: the export writes a file the operator keeps, and a
 * guessed filter naming a target this instance no longer has would write them
 * an empty backup.
 *
 * It is a guess only while an answer is still due, which is why the provider
 * hands the empty list rather than null once the fetch has failed. Nothing
 * retries that fetch in this session, so guessing past it would leave every
 * page narrowed by an unverified id for the rest of the session with the chip
 * row unrendered - it needs two targets and holds none - and no control on
 * screen able to clear the filter. That is precisely the state selectedTargetId
 * refuses to create.
 */
export const queryTargetId = (preferences, targets, node) => targets === null
    ? storedTargetId(preferences, node)
    : selectedTargetId(preferences, targets, node);

/**
 * Whether the stored chip has stopped meaning anything on the instance in hand,
 * and should be thrown away rather than left to be guessed from again.
 *
 * Nothing has ever cleared this preference: deleting a target leaves every
 * browser's chip naming it, and dropping to a single target leaves a chip that
 * is no longer drawn. Both were inert while the value was only ever read beside
 * the list that vetoes it. queryTargetId reads it without that list, so a dead
 * chip stops being inert - it narrows the first request of every load to a
 * target the page is about to stop filtering by, which costs exactly the second
 * request that change exists to remove and hides a deleted target's rows from
 * the first paint. Clearing it makes that a one-off rather than a permanent
 * tax.
 *
 * `targetsNode` is which instance the list in hand was fetched from, and it is
 * the whole difference between this reader of these values and every other one.
 * The others answer a render and are corrected by the next; this one writes
 * localStorage, and what it throws away does not come back. Switching instances
 * neither remounts the provider nor empties the list during render - the reset
 * is an effect - so there is a commit holding the destination node beside the
 * targets of the node just left. Asked there without this guard, a chip chosen
 * on the destination, naming a target that instance still has, is measured
 * against a list that never contained it and deleted; and a source instance
 * holding fewer than two targets deletes it whatever it named, since
 * selectedTargetId answers null for any chip on a list that short. The node
 * guard inside storedTargetId cannot catch this: it checks which node the
 * preference was written on, and says nothing about where the list came from.
 *
 * Only ever on a list that has actually arrived, so a fetch still in flight or
 * one that failed is never read as proof that a target is gone, and only for a
 * choice made on the node in hand - storedTargetId's node guard - so another
 * instance's selection is not collected as collateral.
 */
export const chipIsStale = (preferences, targets, node, targetsNode) =>
    targets !== null
    && (targetsNode ?? null) === (node ?? null)
    && storedTargetId(preferences, node) !== null
    && selectedTargetId(preferences, targets, node) === null;

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
 *
 * `presentTargetIds` is what the page's own data says about that, because one
 * target being configured is not every row being that target's. A deleted
 * target's rows stay in the table - the history is the history - and a restored
 * history export comes back with no target at all, since the file carries the
 * target's name and no id worth anything on another instance. Nothing narrows a
 * single-target page's query, so both kinds are inside every figure on it, and
 * the sole target's optima then judge rows that were never measured against
 * them: a deleted WAN target's 500 Mbit/s average read as half of a LAN
 * target's 940.
 *
 * The rule this keeps is that no figure is graded against optima that were
 * never its rows' - not that every figure on a page shares one basis, which on
 * a genuinely mixed page cannot be true. The latest-test card goes on grading
 * its one row by that row's own target, which is the right basis for that row,
 * so on a mixed page it can read differently from an aggregate only the global
 * settings could judge: two populations each graded honestly, rather than one
 * population graded twice. What is gone is the verdict neither of them earned.
 *
 * No evidence keeps the shortcut rather than taking it away. A parent proxies
 * these pages to nodes that may be older than the field and there is no second
 * question to ask them, and the first render of a page happens before its
 * payload has landed - so "not told" has to mean what the page did before, or
 * every ordinary dashboard would draw itself graded one way and re-grade the
 * other a moment later. It is also right for every instance the migration
 * produced: one target, and every row backfilled to it. Only evidence takes
 * the shortcut away.
 */
export const pageTarget = (targets, preferences, node, presentTargetIds = undefined) => {
    const selected = selectedTargetId(preferences, targets, node);
    // A chip narrows the page's query to its target, so the rows behind the
    // figures are that target's by construction and need nothing to vouch for
    // them - the filter is the evidence.
    if (selected !== null) return targets.find((target) => target.id === selected) ?? null;

    if (targets.length !== 1) return null;
    if (!Array.isArray(presentTargetIds)) return targets[0];

    // An empty range answers an empty set, which passes: there is nothing on
    // the page for the sole target's optima to judge wrongly, and the cards
    // would otherwise change what they grade against as a range empties.
    return presentTargetIds.every((id) => id === targets[0].id) ? targets[0] : null;
};
