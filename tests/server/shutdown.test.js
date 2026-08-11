import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createShutdown } from "../../server/util/shutdown.js";

/** A listener that closes when told to, or never, like one holding a live connection. */
const listener = ({closes = true} = {}) => {
    const calls = {close: 0, closeIdleConnections: 0};

    return {
        calls,
        closeIdleConnections: () => { calls.closeIdleConnections += 1; },
        close: (done) => {
            calls.close += 1;
            if (closes) done();
        }
    };
};

const harness = (options = {}) => {
    const exited = [];
    const stopped = [];
    const timers = [];

    const shutdown = createShutdown({
        listeners: options.listeners ?? [],
        onStop: () => stopped.push(true),
        exit: (code) => exited.push(code),
        setTimer: (fn, ms) => {
            timers.push({fn, ms});
            return {unref: () => undefined};
        },
        log: () => undefined,
        ...options.overrides
    });

    return {shutdown, exited, stopped, timers};
};

/**
 * Nothing handled SIGTERM, and the runtime is PID 1.
 *
 * docker-entrypoint.sh execs, so bun becomes PID 1, and the kernel discards a
 * signal whose disposition is still SIG_DFL - which it is, because node and bun
 * only install a watcher once JS registers a listener. There is no tini and no
 * --init. So `docker stop`, `docker restart`, `compose down` and every image
 * upgrade blocked for the full ten second grace period and then exited 137.
 *
 * Nothing was corrupted by that - the run latch and the pause state are
 * process-local and sqlite is crash-safe - so this is a slow shutdown rather
 * than a data one. Registering the handler is also what makes the signal
 * deliverable in the first place.
 */
describe("createShutdown", () => {
    it("stops the timers and closes every listener", () => {
        const first = listener();
        const second = listener();
        const {shutdown, stopped, exited} = harness({listeners: [first, second]});

        shutdown("SIGTERM");

        assert.deepEqual(stopped, [true]);
        assert.equal(first.calls.close, 1);
        assert.equal(second.calls.close, 1);
        assert.deepEqual(exited, [0]);
    });

    // A keep-alive connection with nothing on it would otherwise hold the
    // listener open for the whole grace period.
    it("releases idle connections before waiting", () => {
        const only = listener();
        const {shutdown} = harness({listeners: [only]});

        shutdown("SIGTERM");

        assert.equal(only.calls.closeIdleConnections, 1);
    });

    it("exits at once when there is nothing listening yet", () => {
        const {shutdown, exited, stopped} = harness();

        shutdown("SIGINT");

        assert.deepEqual(stopped, [true]);
        assert.deepEqual(exited, [0]);
    });

    it("waits for the last listener rather than the first", () => {
        const slow = listener({closes: false});
        const {shutdown, exited} = harness({listeners: [listener(), slow]});

        shutdown("SIGTERM");

        assert.deepEqual(exited, [], "exited before every listener had closed");
    });

    // A request that never finishes must not keep the container alive - that is
    // the very thing this replaces.
    it("gives up after the grace period", () => {
        const {shutdown, exited, timers} = harness({listeners: [listener({closes: false})]});

        shutdown("SIGTERM");
        assert.deepEqual(exited, []);

        assert.equal(timers.length, 1);
        timers[0].fn();

        assert.deepEqual(exited, [0]);
    });

    it("exits once, however many signals arrive", () => {
        const only = listener();
        const {shutdown, exited, stopped} = harness({listeners: [only]});

        shutdown("SIGTERM");
        shutdown("SIGINT");
        shutdown("SIGTERM");

        assert.deepEqual(exited, [0]);
        assert.deepEqual(stopped, [true]);
        assert.equal(only.calls.close, 1);
    });

    it("does not exit twice when the deadline fires after a clean close", () => {
        const {shutdown, exited, timers} = harness({listeners: [listener()]});

        shutdown("SIGTERM");
        timers[0].fn();

        assert.deepEqual(exited, [0]);
    });

    // Closing what is already closed throws; the shutdown must still complete.
    it("still exits when a listener refuses to close", () => {
        const broken = {close: () => { throw new Error("Server is not running"); }};
        const {shutdown, exited} = harness({listeners: [broken]});

        shutdown("SIGTERM");

        assert.deepEqual(exited, [0]);
    });
});
