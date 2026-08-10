/**
 * The pure arithmetic of paging the tests list.
 *
 * These judgements lived inline in the context, two of them inside its
 * setSpeedtests updaters - which React may run twice under StrictMode, so the
 * setCursor/setHasMore calls they carried fired twice too. Out here they are
 * updaters' inputs instead of their side effects, and each rule is testable
 * on its own.
 */

/**
 * Where the next page starts: the last row's `created` and id, because that
 * pair is what the list is ordered by. Null when there is no row to point at.
 */
export const cursorOf = (tests) => {
    const last = tests[tests.length - 1];
    return last ? {created: last.created, id: last.id} : null;
};

/**
 * One fetched page folded into the list.
 *
 * The cursor advances to the fetched page's end even when every row on it was
 * already known - the overlap a refresh can leave. It used to move only with
 * additions, so a fully-known page kept the old cursor while hasMore stayed
 * true, and "load more" fetched the same page forever.
 *
 * The list keeps its identity when nothing was added, so a no-op page does not
 * re-render every row.
 */
export const applyPage = (current, fetched, pageSize) => {
    const known = new Set(current.map((test) => test.id));
    const additions = fetched.filter((test) => !known.has(test.id));

    return {
        tests: additions.length > 0 ? [...current, ...additions] : current,
        cursor: cursorOf(fetched),
        hasMore: fetched.length === pageSize
    };
};

/**
 * One row deleted from the list.
 *
 * `exhausted` says the list emptied, which is the caller's cue to stop paging;
 * an id that was not in the list leaves the identity alone.
 */
export const removeTest = (current, id) => {
    const tests = current.filter((test) => test.id !== id);
    if (tests.length === current.length) return {tests: current, cursor: cursorOf(current), exhausted: false};

    return {
        tests,
        cursor: cursorOf(tests),
        exhausted: tests.length === 0
    };
};
