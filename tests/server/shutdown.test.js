import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { createShutdown } from "../../server/util/shutdown.js";
import * as shutdownModule from "../../server/util/shutdown.js";
import { bodyOf } from "../helpers/source.js";

const SUCCESS_EXIT_CODE = 0;
const INCOMPLETE_EXIT_CODE = 1;
const SYNTHETIC_GRACE_MS = 50;
const SYNTHETIC_PROCESS_TIMEOUT_MS = 10000;

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
    it("reports incomplete shutdown after the grace period", () => {
        const {shutdown, exited, timers} = harness({listeners: [listener({closes: false})]});

        shutdown("SIGTERM");
        assert.deepEqual(exited, []);

        assert.equal(timers.length, 1);
        timers[0].fn();

        assert.deepEqual(exited, [INCOMPLETE_EXIT_CODE]);
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

    for (const [name, configuration, expectedCode] of [
        ["unresolved cleanup", "onCleanup: () => new Promise(() => undefined)", INCOMPLETE_EXIT_CODE],
        ["unresolved listener", "listeners: [{close: () => undefined}]", INCOMPLETE_EXIT_CODE],
        ["completed cleanup", "onCleanup: async () => undefined", SUCCESS_EXIT_CODE]
    ]) {
        it(`keeps truthful status for ${name} when the process has no other handles`, () => {
            const moduleUrl = new URL("../../server/util/shutdown.js", import.meta.url).href;
            const script = `import {createShutdown} from ${JSON.stringify(moduleUrl)};
                createShutdown({${configuration}, graceMs: ${SYNTHETIC_GRACE_MS},
                    log: () => undefined})("SIGTERM");`;
            const arguments_ = process.versions.bun ? ["--eval", script]
                : ["--input-type=module", "--eval", script];
            const result = spawnSync(process.execPath, arguments_, {
                encoding: "utf8", timeout: SYNTHETIC_PROCESS_TIMEOUT_MS, windowsHide: true,
                env: {PATH: process.env.PATH, SystemRoot: process.env.SystemRoot,
                    TEMP: process.env.TEMP, TMP: process.env.TMP}
            });
            assert.equal(result.error, undefined);
            assert.equal(result.signal, null);
            assert.equal(result.status, expectedCode, result.stderr);
        });
    }
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
    it("reports incomplete shutdown when the cleanup rejects", async () => {
        const {shutdown, exited} = withCleanup(async () => { throw new Error("Connection lost"); });

        shutdown("SIGTERM");
        await settle();

        assert.deepEqual(exited, [INCOMPLETE_EXIT_CODE]);
    });

    it("reports incomplete shutdown when the cleanup throws synchronously", async () => {
        const {shutdown, exited} = withCleanup(() => { throw new Error("no handle"); });

        shutdown("SIGTERM");
        await settle();

        assert.deepEqual(exited, [INCOMPLETE_EXIT_CODE]);
    });

    /**
     * The deadline outranks the hook.
     *
     * A close that never comes back must not be able to hold the container past
     * the grace period - that is the entire failure this module exists to end,
     * and a hook that hangs would have reintroduced it one layer down.
     */
    it("reports incomplete shutdown when cleanup never finishes", async () => {
        const {shutdown, exited, timers} = withCleanup(() => new Promise(() => undefined));

        shutdown("SIGTERM");
        await settle();
        assert.deepEqual(exited, []);

        timers[0].fn();

        assert.deepEqual(exited, [INCOMPLETE_EXIT_CODE]);
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

    for (const outcome of ["resolve", "reject"]) {
        it(`ignores cleanup ${outcome} after the deadline`, async () => {
            let complete;
            const cleanup = new Promise((resolve, reject) => {
                complete = outcome === "resolve" ? resolve : () => reject(new Error("late cleanup"));
            });
            const {shutdown, exited, timers, ran} = withCleanup(() => cleanup);
            shutdown("SIGTERM");
            shutdown("SIGINT");
            await settle();
            timers[0].fn();
            complete();
            await settle();
            timers[0].fn();
            assert.deepEqual(exited, [INCOMPLETE_EXIT_CODE]);
            assert.deepEqual(ran, [true]);
        });
    }

    it("does not replace a listener timeout with late successful cleanup", async () => {
        let closeListener;
        const lateListener = {close: done => { closeListener = done; }};
        const {shutdown, exited, timers} = withCleanup(async () => undefined, [lateListener]);
        shutdown("SIGTERM");
        timers[0].fn();
        closeListener();
        await settle();
        assert.deepEqual(exited, [INCOMPLETE_EXIT_CODE]);
    });
});

describe("runServerCleanup", () => {
    it("exports distinct named success and incomplete exit codes", () => {
        assert.equal(shutdownModule.SHUTDOWN_SUCCESS_EXIT_CODE, SUCCESS_EXIT_CODE);
        assert.equal(shutdownModule.SHUTDOWN_INCOMPLETE_EXIT_CODE, INCOMPLETE_EXIT_CODE);
    });

    const arrange = ({processExited = true, roundCompleted = true, closeError} = {}) => {
        const calls = [];
        return {
            calls,
            cleanup: () => shutdownModule.runServerCleanup({
                waitForProcessExit: async () => { calls.push("process"); return processExited; },
                waitForRound: async () => { calls.push("round"); return roundCompleted; },
                closeDatabase: async () => {
                    calls.push("database");
                    if (closeError) throw closeError;
                }
            })
        };
    };

    it("completes only after child, round and database cleanup in order", async () => {
        const state = arrange();
        await state.cleanup();
        assert.deepEqual(state.calls, ["process", "round", "database"]);
    });

    it("awaits each stage and does not finish before the database close settles", async () => {
        const calls = [];
        const releases = [];
        const stage = name => () => {
            calls.push(name);
            return new Promise(resolve => releases.push(resolve));
        };
        let finished = false;
        const cleanup = shutdownModule.runServerCleanup({
            waitForProcessExit: stage("process"),
            waitForRound: stage("round"),
            closeDatabase: stage("database")
        }).then(() => { finished = true; });
        assert.deepEqual(calls, ["process"]);
        releases.shift()(true);
        await settle();
        assert.deepEqual(calls, ["process", "round"]);
        releases.shift()(true);
        await settle();
        assert.deepEqual(calls, ["process", "round", "database"]);
        assert.equal(finished, false);
        releases.shift()();
        await cleanup;
        assert.equal(finished, true);
    });

    for (const [name, options] of [
        ["child timeout", {processExited: false}],
        ["round timeout", {roundCompleted: false}],
        ["both timeouts", {processExited: false, roundCompleted: false}],
        ["truthy child observation", {processExited: "true"}],
        ["truthy round observation", {roundCompleted: 1}],
        ["missing observation", {processExited: null}]
    ]) {
        it(`still closes the database before rejecting ${name}`, async () => {
            const state = arrange(options);
            await assert.rejects(async () => state.cleanup(), /cleanup was incomplete/);
            assert.deepEqual(state.calls, ["process", "round", "database"]);
        });
    }

    it("propagates database close failure", async () => {
        const closeError = new Error("database close failed");
        const state = arrange({closeError});
        await assert.rejects(async () => state.cleanup(), error => error === closeError);
        assert.deepEqual(state.calls, ["process", "round", "database"]);
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

    /**
     * The kill in onStop only starts the ending: SIGTERM at once, SIGKILL a
     * second later on an unref'd timer. On a quiet shutdown exit(0) used to win
     * that race and orphan a CLI that ignores SIGTERM - so the cleanup waits
     * for the child, and only then closes the handle the child would have
     * written its result into.
     */
    it("waits for the CLI child before it closes the database", () => {
        assert.match(call, /waitForActiveProcessExit/, "the exit no longer waits for the run it signalled");
        assert.ok(call.indexOf("waitForActiveProcessExit") < call.indexOf("db.close()"),
            "the database closed while the child could still be writing into it");
    });

    // Execute only this extracted callback with injected synthetic dependencies,
    // never import index.js or open any server, database or production resource.
    const cleanupBody = bodyOf(source, "onCleanup: async () =>");
    const makeCleanup = new Function("runServerCleanup", "waitForActiveProcessExit", "waitForActiveRound", "db",
        `return async () => ${cleanupBody}`);
    for (const [name, processExited, roundCompleted, closeFails] of [
        ["complete cleanup", true, true, false],
        ["child timeout", false, true, false],
        ["round timeout", true, false, false],
        ["both timeouts", false, false, false],
        ["database rejection", true, true, true]
    ]) {
        it(`reports the real callback outcome for ${name}`, async () => {
            const calls = [];
            const cleanup = makeCleanup(shutdownModule.runServerCleanup,
                async () => { calls.push("process"); return processExited; },
                async () => { calls.push("round"); return roundCompleted; },
                {close: async () => {
                    calls.push("database");
                    if (closeFails) throw new Error("database close failed");
                }});
            const state = harness({overrides: {onCleanup: cleanup}});
            state.shutdown("SIGTERM");
            await settle();
            const expected = processExited && roundCompleted && !closeFails ? SUCCESS_EXIT_CODE : INCOMPLETE_EXIT_CODE;
            assert.deepEqual(state.exited, [expected]);
            assert.deepEqual(calls, ["process", "round", "database"]);
        });
    }
});
