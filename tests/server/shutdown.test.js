import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createShutdown } from "../../server/util/shutdown.js";

/** Lets whatever the cleanup hook chained onto settle before anything is asserted. */
const settle = () => new Promise((resolve) => setImmediate(resolve));

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

/**
 * What is still open once nothing is listening.
 *
 * onStop clears the intervals and cancels both scheduled jobs, and that was the
 * whole of the shutdown - the database handle was left to the exit. This
 * project already knows why that is not merely untidy: stopAfterReset closes it
 * explicitly, with a comment about sqlite's WAL mode leaving a -wal and a -shm
 * beside the database file, and `docker exec` skipping the entrypoint's
 * privilege drop so those two are created root-owned inside a volume the server
 * reads as another user. The signal path is the one every `docker stop` takes
 * and it did not close anything.
 *
 * A hook rather than another injected callback beside onStop, because the
 * ordering is the point: onStop runs first and stops new work arriving, this
 * runs last, once no listener can still be serving a request out of the
 * connection it is about to close.
 */
describe("createShutdown with a cleanup hook", () => {
    const withCleanup = (onCleanup, listeners = [listener()]) => {
        const ran = [];
        const {shutdown, exited, timers} = harness({
            listeners,
            overrides: {onCleanup: () => { ran.push(true); return onCleanup(); }}
        });

        return {shutdown, exited, timers, ran};
    };

    it("runs after the last listener has closed, and exits after that", async () => {
        const {shutdown, exited, ran} = withCleanup(async () => undefined);

        shutdown("SIGTERM");
        assert.deepEqual(exited, [], "exited before the database was closed");

        await settle();

        assert.deepEqual(ran, [true]);
        assert.deepEqual(exited, [0]);
    });

    it("runs when there was never anything listening", async () => {
        const {shutdown, exited, ran} = withCleanup(async () => undefined, []);

        shutdown("SIGTERM");
        await settle();

        assert.deepEqual(ran, [true]);
        assert.deepEqual(exited, [0]);
    });

    // A database that has already gone away rejects here, and an exit that
    // waits for a clean close it will never get is the hang this replaced.
    it("still exits when the cleanup rejects", async () => {
        const {shutdown, exited} = withCleanup(async () => { throw new Error("Connection lost"); });

        shutdown("SIGTERM");
        await settle();

        assert.deepEqual(exited, [0]);
    });

    it("still exits when the cleanup throws synchronously", async () => {
        const {shutdown, exited} = withCleanup(() => { throw new Error("no handle"); });

        shutdown("SIGTERM");
        await settle();

        assert.deepEqual(exited, [0]);
    });

    /**
     * The deadline outranks the hook.
     *
     * A close that never comes back must not be able to hold the container past
     * the grace period - that is the entire failure this module exists to end,
     * and a hook that hangs would have reintroduced it one layer down.
     */
    it("gives up on a cleanup that never finishes", async () => {
        const {shutdown, exited, timers} = withCleanup(() => new Promise(() => undefined));

        shutdown("SIGTERM");
        await settle();
        assert.deepEqual(exited, []);

        timers[0].fn();

        assert.deepEqual(exited, [0]);
    });

    it("does not close the database twice, however many signals arrive", async () => {
        const {shutdown, exited, ran} = withCleanup(async () => undefined);

        shutdown("SIGTERM");
        shutdown("SIGINT");
        await settle();
        shutdown("SIGTERM");
        await settle();

        assert.deepEqual(ran, [true]);
        assert.deepEqual(exited, [0]);
    });

    // And the deadline firing after a clean close must not exit a second time,
    // now that the exit no longer happens in the same tick.
    it("exits once when the deadline fires after the cleanup finished", async () => {
        const {shutdown, exited, timers} = withCleanup(async () => undefined);

        shutdown("SIGTERM");
        await settle();
        timers[0].fn();

        assert.deepEqual(exited, [0]);
    });

    // Every existing caller passes no hook at all, and the shutdown they get
    // must stay the synchronous one the tests above describe.
    it("exits in the same tick when there is no hook", () => {
        const {shutdown, exited} = harness({listeners: [listener()]});

        shutdown("SIGTERM");

        assert.deepEqual(exited, [0], "an absent hook made the exit asynchronous");
    });
});

/**
 * And the server actually hands it one.
 *
 * index.js cannot be imported to be asked - it opens the database, downloads a
 * CLI and takes the port - so the wiring is read rather than run, the way the
 * failure handler's is in runStateRelease.test.js. Without this the hook above
 * is a feature nothing uses.
 */
describe("the server's own shutdown", () => {
    const root = path.resolve(fileURLToPath(import.meta.url), "..", "..", "..");
    const source = fs.readFileSync(path.join(root, "server/index.js"), "utf8");

    const call = source.slice(source.indexOf("createShutdown({"),
        source.indexOf("process.on('SIGTERM'"));

    it("closes the database on the way out", () => {
        assert.notEqual(source.indexOf("createShutdown({"), -1, "the shutdown is no longer built here");
        assert.match(call, /onCleanup/, "the signal path leaves the database handle open");
        assert.match(call, /db\.close\(\)/, "something other than the database is being closed");
    });

    // The timers still stop first: onStop is what keeps new work from arriving
    // while the listeners drain.
    it("still stops the timers before it waits", () => {
        assert.match(call, /onStop/);
        assert.match(call, /stopTimer\(\)/);
    });
});
