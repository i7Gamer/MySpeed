import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { trackProcess, untrackProcess, terminateActiveProcess, SHUTDOWN_KILL_GRACE, KILL_GRACE } from "../../server/util/speedtest.js";
import { SHUTDOWN_GRACE_MS } from "../../server/util/shutdown.js";

const SERVER = path.resolve(fileURLToPath(import.meta.url), "..", "..", "..", "server");

const read = (file) => fs.readFileSync(path.join(SERVER, file), "utf8");

/** A child process as far as the tracking is concerned - as cliTermination.test.js has it. */
const fakeChild = ({exitCode = null, signalCode = null} = {}) => {
    const signals = [];

    return {
        signals,
        exitCode,
        signalCode,
        killed: false,
        kill(signal = "SIGTERM") {
            signals.push(signal);
            this.killed = true;
            return true;
        }
    };
};

// Every test starts with nothing in flight, whatever the one before it tracked.
beforeEach(() => {
    trackProcess(null);
});

/**
 * A speedtest still running when the process is asked to stop.
 *
 * The child was held in a local, so nothing outside the run could reach it. The
 * shutdown sequence stopped the timers, closed the listeners and closed the
 * database, then exited - and the CLI carried on. Under docker the kernel tears
 * the namespace down and the orphan goes with it, which is why this stayed
 * invisible; under the Windows service there is no namespace, so the speedtest
 * outlives the server that started it. It then finishes and writes its result
 * into a database handle that has already been closed.
 */
describe("terminateActiveProcess", () => {
    it("reports nothing to do when no test is running", () => {
        assert.equal(terminateActiveProcess(), false);
    });

    it("ends the run that is in flight", () => {
        const child = fakeChild();
        trackProcess(child);

        assert.equal(terminateActiveProcess(), true);
        assert.deepEqual(child.signals, ["SIGTERM"], "the CLI was left running");
    });

    /**
     * The same escalation the run's own timeout uses: SIGTERM is a request, and
     * a CLI blocked in a socket read is free to ignore it. Without this the
     * shutdown's own deadline arrives, the process exits anyway, and the child
     * is orphaned after all - the case this exists to prevent.
     */
    it("escalates to SIGKILL when the CLI ignores the request", async () => {
        const child = fakeChild();
        trackProcess(child);

        terminateActiveProcess(10);
        await new Promise((resolve) => setTimeout(resolve, 50));

        assert.deepEqual(child.signals, ["SIGTERM", "SIGKILL"]);
    });

    /**
     * The escalation has to land inside the shutdown, not at the end of it.
     * KILL_GRACE is the whole of SHUTDOWN_GRACE_MS, so escalating on that would
     * send the SIGKILL as the process was already leaving.
     */
    it("gives the CLI less time than the shutdown itself has", () => {
        assert.ok(SHUTDOWN_KILL_GRACE < KILL_GRACE);
        assert.ok(SHUTDOWN_KILL_GRACE < SHUTDOWN_GRACE_MS,
            "a CLI that ignores SIGTERM is killed no sooner than the exit that orphans it");
    });

    it("leaves a child that has already gone alone", () => {
        const child = fakeChild({exitCode: 0});
        trackProcess(child);

        assert.equal(terminateActiveProcess(), false, "a finished run was signalled");
        assert.deepEqual(child.signals, []);
    });

    it("leaves one that was already killed alone", () => {
        const child = fakeChild({signalCode: "SIGTERM"});
        trackProcess(child);

        assert.equal(terminateActiveProcess(), false);
        assert.deepEqual(child.signals, []);
    });

    it("forgets the run once it is untracked", () => {
        const child = fakeChild();
        trackProcess(child);
        trackProcess(null);

        assert.equal(terminateActiveProcess(), false);
        assert.deepEqual(child.signals, [], "a run that had already ended was signalled");
    });

    it("tracks only the newest run", () => {
        const first = fakeChild();
        const second = fakeChild();

        trackProcess(first);
        trackProcess(second);
        terminateActiveProcess();

        assert.deepEqual(first.signals, []);
        assert.deepEqual(second.signals, ["SIGTERM"]);
    });

    it("hands the child back, so the spawn can be wrapped in it", () => {
        const child = fakeChild();

        assert.equal(trackProcess(child), child);
    });

    it("can be asked twice without signalling twice", () => {
        const child = fakeChild();
        trackProcess(child);

        terminateActiveProcess();
        child.signalCode = "SIGTERM";       // what the kill it just sent produces

        assert.equal(terminateActiveProcess(), false);
        assert.deepEqual(child.signals, ["SIGTERM"]);
    });
});

/**
 * The wiring is the whole of the bug: the helper above is worth nothing if the
 * shutdown never asks for it, and that is precisely the state this was found in.
 */
describe("the shutdown sequence", () => {
    it("tracks the process it spawns", () => {
        assert.match(read("util/speedtest.js"), /trackProcess\(\s*spawn\(/,
            "the spawned CLI is not reachable from outside the run again");
    });

    it("ends a running speedtest when the server is stopping", () => {
        const index = read("index.js");

        assert.match(index, /terminateActiveProcess/,
            "a speedtest in flight is left running when the server shuts down");

        // In onStop rather than onCleanup: onStop is for what is holding the
        // event loop open, and it runs before the grace deadline can cut the
        // sequence short.
        const onStop = index.slice(index.indexOf("onStop:"), index.indexOf("onCleanup:"));
        assert.match(onStop, /terminateActiveProcess\(\)/,
            "the CLI is killed too late in the sequence to be sure of it");
    });
});

/**
 * Letting go of a run says *which* run, because two can briefly overlap.
 *
 * A child that finishes clears the tracker, and it used to clear it whatever was
 * in there - the handlers called `trackProcess(null)`. Node emits 'error' before
 * 'close' for a spawn that failed, and the promise rejection that the 'error'
 * handler triggers is a microtask, so the retry in tasks/speedtest.js resumes
 * while the first child's 'close' is still queued. Nothing about the tracker
 * prevented that 'close' from arriving after the retry had tracked its own
 * child and wiping it - which leaves terminateActiveProcess with nothing to
 * find, and the CLI running after the server has gone.
 *
 * What stops it today is that the retry awaits two configuration reads before it
 * spawns, so the queued 'close' always lands first. That is a property of the
 * retry's shape rather than of the tracking, and it is not one anybody editing
 * either file would know they were relying on. Asking whose child it is costs a
 * comparison and does not need to be known about.
 */
describe("untrackProcess", () => {
    it("lets go of the run that finished", () => {
        const child = fakeChild();
        trackProcess(child);

        untrackProcess(child);

        assert.equal(terminateActiveProcess(), false, "the finished run is still held as the one in flight");
    });

    it("leaves a newer run alone", () => {
        const first = fakeChild();
        const second = fakeChild();

        trackProcess(first);
        trackProcess(second);

        // The first child's deferred 'close', arriving after the retry spawned.
        untrackProcess(first);

        assert.equal(terminateActiveProcess(), true, "the run in flight was forgotten and cannot be ended");
        assert.deepEqual(second.signals, ["SIGTERM"], "the shutdown reached the wrong child, or none");
        assert.deepEqual(first.signals, [], "the finished child was signalled again");
    });

    it("does nothing when there is no run at all", () => {
        untrackProcess(fakeChild());

        assert.equal(terminateActiveProcess(), false);
    });

    /**
     * And the run lets go through it.
     *
     * The three above test the helper against fake children. The helper is not
     * what was wrong: `trackProcess(null)` in the run's own handlers is, and
     * putting that back leaves all three of them passing while the race is fully
     * restored. `finish()` is the one place a run ends, so it is the one place
     * this has to be asked.
     */
    it("is how the run itself lets go", () => {
        const source = read("util/speedtest.js");
        const finish = source.slice(source.indexOf("const finish = () =>"),
            source.indexOf("await new Promise"));

        assert.notEqual(finish.length, 0, "the run no longer ends in one place");
        assert.match(finish, /untrackProcess\(testProcess\)/,
            "the run clears the tracker without asking whose child it is");
        assert.doesNotMatch(source, /trackProcess\(null\)/,
            "a handler still wipes the tracker outright, which can take a retry's child with it");
    });
});
