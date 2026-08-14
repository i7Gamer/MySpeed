/**
 * How long anything still in flight gets before the process leaves anyway.
 *
 * Comfortably inside docker's own ten second grace period, so a shutdown that
 * cannot finish cleanly still ends as an exit rather than a SIGKILL.
 */
export const SHUTDOWN_GRACE_MS = 5000;

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
 * @param exit       process.exit
 * @param setTimer   setTimeout
 * @param log        console.log
 */
export const createShutdown = ({
    listeners = [], onStop = () => undefined, exit = process.exit,
    setTimer = setTimeout, log = console.log, graceMs = SHUTDOWN_GRACE_MS
} = {}) => {
    let started = false;
    let finished = false;

    // A second signal must not exit twice, and neither must the deadline
    // firing after the last listener already closed.
    const finish = () => {
        if (finished) return;
        finished = true;
        exit(0);
    };

    return (signal) => {
        if (started) return;
        started = true;

        log(`Received ${signal}, shutting down`);

        onStop();

        const deadline = setTimer(finish, graceMs);
        deadline?.unref?.();

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
