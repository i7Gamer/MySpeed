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
