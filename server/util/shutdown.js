/**
 * How long anything still in flight gets before the process leaves anyway.
 *
 * Comfortably inside docker's own ten second grace period, so a shutdown that
 * cannot finish cleanly still ends as an exit rather than a SIGKILL.
 */
export const SHUTDOWN_GRACE_MS = 5000;

export const SHUTDOWN_SUCCESS_EXIT_CODE = 0;
export const SHUTDOWN_INCOMPLETE_EXIT_CODE = 1;
const INCOMPLETE_CLEANUP_MESSAGE = "Server shutdown cleanup was incomplete";

/**
 * The bounded waits resolve true on completion and false on timeout. Keep
 * their child -> round -> database order, including attempting the close after
 * a wait times out, but never report that incomplete sequence as successful.
 * Database-close rejection is also part of the shutdown failure contract.
 */
export const runServerCleanup = async ({waitForProcessExit, waitForRound, closeDatabase}) => {
    const processExited = await waitForProcessExit();
    const roundCompleted = await waitForRound();
    await closeDatabase();
    if (processExited !== true || roundCompleted !== true) {
        throw new Error(INCOMPLETE_CLEANUP_MESSAGE);
    }
};

/**
 * Ends the process on a signal, closing what it holds open first.
 *
 * Nothing handled SIGTERM at all, and the runtime is PID 1:
 * docker-entrypoint.sh execs, and there is no tini and no --init. The kernel
 * discards a signal whose disposition is still the default, which it is because
 * node and bun only install a watcher once JS registers a listener - so every
 * `docker stop`, `docker restart` and image upgrade blocked for the full grace
 * period and exited 137. Registering the handler is what makes the signal
 * deliverable; this is what makes it mean something.
 *
 * Everything is injected so the sequencing is testable without signalling a
 * real process.
 *
 * @param listeners  the HTTP/HTTPS servers to close
 * @param onStop     stops the timers and anything else holding the loop open
 * @param onCleanup  closes what is still open once nothing is listening; may
 *                   be asynchronous, and the deadline below outranks it
 * @param exit       process.exit
 * @param setTimer   setTimeout
 * @param log        console.log
 */
export const createShutdown = ({
    listeners = [], onStop = () => undefined, onCleanup = null, exit = process.exit,
    setTimer = setTimeout, log = console.log, graceMs = SHUTDOWN_GRACE_MS
} = {}) => {
    let started = false;
    let finished = false;
    let left = false;

    // The exit itself, guarded separately from the sequence that leads to it.
    // The deadline reaches this directly: a cleanup that never comes back must
    // not be able to hold the container open, which is the exact failure this
    // module exists to end.
    const leave = (code) => {
        if (left) return;
        left = true;
        exit(code);
    };

    /**
     * Nothing is listening any more, so whatever is still open can be closed.
     *
     * A second signal must not run this twice, and neither must the deadline
     * firing after the last listener already closed.
     *
     * Without a hook this exits in the same tick, which is what every caller
     * but index.js gets and what the shape of this module was before: an exit
     * deferred by a promise nobody needed is a behaviour change for no reason.
     * With one, failure still ends the process within the same deadline, but
     * its status must distinguish that departure from completed cleanup.
     */
    const finish = () => {
        if (finished) return;
        finished = true;

        if (!onCleanup) return leave(SHUTDOWN_SUCCESS_EXIT_CODE);

        Promise.resolve().then(onCleanup).then(
            () => leave(SHUTDOWN_SUCCESS_EXIT_CODE),
            () => leave(SHUTDOWN_INCOMPLETE_EXIT_CODE)
        );
    };

    return (signal) => {
        if (started) return;
        started = true;

        log(`Received ${signal}, shutting down`);

        onStop();

        // Keep the deadline referenced: a pending promise alone does not keep
        // the runtime alive, and an early natural exit would falsely report 0.
        // Completed cleanup still calls process.exit immediately.
        setTimer(() => leave(SHUTDOWN_INCOMPLETE_EXIT_CODE), graceMs);

        let pending = listeners.length;
        if (pending === 0) return finish();

        for (const listener of listeners) {
            // A keep-alive connection with nothing on it would otherwise hold
            // its listener open for the whole grace period.
            try {
                listener.closeIdleConnections?.();
            } catch {
                // Best effort, on a listener that may already be closing. This
                // only shortens the grace period; the timeout below still ends
                // the process either way.
            }

            // Closing a listener that is already closed throws, and one that
            // refuses must not strand the rest.
            try {
                listener.close(() => {
                    pending -= 1;
                    if (pending === 0) finish();
                });
            } catch {
                pending -= 1;
                if (pending === 0) finish();
            }
        }
    };
};
