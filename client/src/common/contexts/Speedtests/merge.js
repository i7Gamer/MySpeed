/**
 * Merges a poll of the newest speedtests into the list already on screen.
 *
 * The refresh used to keep anything whose `id` was greater than the first
 * entry's. That reads as "newer" only while ids happen to ascend with time,
 * which an import does not guarantee: the history export is ordered by `created`
 * descending and the import inserts in that order, so a restored instance ends
 * up with id 1 on its *newest* test. Every poll then classified almost the whole
 * page as new, prepended it again, and the list grew without bound - with
 * duplicate React keys, which loses the state of every row below.
 *
 * Ordering therefore follows `created`, the column the list is actually sorted
 * by, and identity follows the id. Both writes guarantee `created` is an
 * ISO-8601 UTC string, so a lexicographic comparison is chronological.
 */
export const mergeNewTests = (previous, incoming) => {
    if (!Array.isArray(incoming) || incoming.length === 0) return previous;
    if (previous.length === 0) return incoming;

    const known = new Set(previous.map((test) => test.id));
    const newestCreated = previous[0].created;

    const additions = incoming.filter((test) =>
        !known.has(test.id) && test.created > newestCreated);

    // Returning `previous` unchanged matters: a new array identity would
    // re-render every row on every poll.
    if (additions.length === 0) return previous;

    return [...additions, ...previous];
};

/**
 * What a refresh should do with the page it just fetched.
 *
 * The refresh asks the very same query the list was built from, so the answer
 * is authoritative about what that query now returns - which is more than a
 * handful of rows to prepend. Read as the latter, two things went wrong.
 *
 * An empty answer was taken as "nothing to do" and returned before touching
 * state, so clearing the history reported success over a list still showing
 * every row the server had just deleted - and deleting one of those ghosts then
 * failed with a red toast.
 *
 * And a page that overlapped nothing was prepended anyway, landing a full page
 * directly on top of a much older row. Everything between became unreachable:
 * the cursor sits at the bottom of the list and only ever pages further back.
 *
 * `replaced` tells the caller the list was swapped rather than grown, which
 * means the cursor it was holding pointed into a result set that is now gone.
 */
export const applyRefresh = (previous, incoming) => {
    if (!Array.isArray(incoming)) return {tests: previous, replaced: false};

    if (incoming.length === 0)
        return previous.length === 0
            ? {tests: previous, replaced: false}
            : {tests: incoming, replaced: true};

    // Sharing no row with what is on screen means this is not an addition to
    // it. That covers a list emptied and refilled, an import that rewrote the
    // history, and a gap too wide for one page to bridge.
    const known = new Set(previous.map((test) => test.id));
    if (!incoming.some((test) => known.has(test.id))) return {tests: incoming, replaced: true};

    return {tests: mergeNewTests(previous, incoming), replaced: false};
};
