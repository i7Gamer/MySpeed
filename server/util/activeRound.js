/**
 * The speedtest round in flight, so the shutdown can wait for it.
 *
 * The shutdown already waits for the CLI child (util/speedtest.js) before it
 * closes the database. The child's exit is not the end of the round: the row,
 * the baseline keys and the recommendations are all written *after* the child
 * has gone, through the handle that close takes away - and on a quiet shutdown
 * the close landed in the middle of them. The round's only state used to be a
 * boolean latch, which says that something is running and nothing about when
 * it will be done.
 *
 * A leaf module rather than a corner of tasks/speedtest.js: index.js needs to
 * ask, and this is testable without a database or a child.
 */

/**
 * How long the shutdown waits for the round after the child has gone.
 *
 * What is left of a round by then is database writes and a notification, so
 * this is generous. Sized with util/speedtest.js's SHUTDOWN_EXIT_WAIT to stay
 * inside shutdown.js's SHUTDOWN_GRACE_MS with room for the close itself: the
 * two waits run in sequence before it, and the deadline that outranks them
 * all exits without closing the handle at all - so a child that cannot die
 * and a round that cannot end must still leave the close its own time.
 */
export const SHUTDOWN_ROUND_WAIT = 1500;

let activeRound = null;

/**
 * Remembers the round as the one in flight until it settles, however it
 * settles. Hands the promise back, so the caller awaits the same one.
 *
 * A round that ended forgets only itself: rounds do not overlap (the latch in
 * tasks/speedtest.js sees to that), but a tracker that cleared whatever was
 * there would be one refactor away from forgetting a newer round.
 */
export const trackRound = (round) => {
    activeRound = round;

    const forget = () => {
        if (activeRound === round) activeRound = null;
    };
    round.then(forget, forget);

    return round;
};

export const hasActiveRound = () => activeRound !== null;

/**
 * Resolves once the round in flight has settled, or at the deadline.
 *
 * Answers true when the round is over and false when the wait gave up - the
 * caller proceeds either way, this only decides when. A rejected round counts
 * as over: its failure is the round's own to handle, not the shutdown's.
 */
export const waitForActiveRound = (timeoutMs = SHUTDOWN_ROUND_WAIT) =>
    new Promise((resolve) => {
        if (activeRound === null) return resolve(true);

        const timer = setTimeout(() => resolve(false), timeoutMs);
        timer.unref?.();

        const done = () => {
            clearTimeout(timer);
            resolve(true);
        };
        activeRound.then(done, done);
    });
