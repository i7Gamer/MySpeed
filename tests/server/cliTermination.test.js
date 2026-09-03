import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import {
    KILL_GRACE, SHUTDOWN_EXIT_WAIT, SHUTDOWN_KILL_GRACE, WINDOWS_DLL_NOT_FOUND, exitError,
    hasExited, terminate, trackProcess, untrackProcess, waitForActiveProcessExit
} from "../../server/util/speedtest.js";
import { SHUTDOWN_GRACE_MS } from "../../server/util/shutdown.js";
import { readSource, withoutComments } from "../helpers/source.js";

/**
 * What happens to a CLI that will not go when it is asked, and to one that goes
 * without saying why.
 *
 * The run holds a latch that nothing else clears: tasks/speedtest.js sets
 * _isRunning before the spawn and only drops it when this promise settles. So a
 * child that ignores SIGTERM - which is every child blocked in a socket read
 * that has not installed a handler - never emits 'close', the await never
 * settles, and no scheduled speedtest ever runs again for the life of the
 * process. A timeout that cannot actually end the process is not a timeout.
 *
 * The second half is the opposite failure: a run that ends cleanly as far as
 * the streams are concerned, having printed its reason somewhere the parser
 * does not look. The exit code is the one signal that cannot be misread.
 */

/** A child process as far as the two helpers under test are concerned. */
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

describe("hasExited", () => {
    it("is false while the process is still up", () => {
        assert.equal(hasExited(fakeChild()), false);
    });

    it("is true once it has exited on its own", () => {
        assert.equal(hasExited(fakeChild({exitCode: 0})), true);
        assert.equal(hasExited(fakeChild({exitCode: 1})), true);
    });

    it("is true once a signal has taken it", () => {
        assert.equal(hasExited(fakeChild({signalCode: "SIGTERM"})), true);
    });

    /**
     * `killed` says a signal was delivered, not that it was obeyed - it is set
     * by kill() whether or not the child does anything about it. Escalating on
     * `!child.killed` would therefore never escalate at all, which is exactly
     * the case this exists for.
     */
    it("is not fooled by the killed flag a delivered signal sets", () => {
        const child = fakeChild();
        child.kill();

        assert.equal(child.killed, true);
        assert.equal(hasExited(child), false);
    });
});

describe("terminate", () => {
    it("asks politely first", () => {
        const child = fakeChild();
        const escalation = terminate(child);
        clearTimeout(escalation);

        assert.deepEqual(child.signals, ["SIGTERM"]);
    });

    it("kills outright a child that ignored the polite signal", async () => {
        const child = fakeChild();

        terminate(child, 10);
        await new Promise((resolve) => setTimeout(resolve, 40));

        assert.deepEqual(child.signals, ["SIGTERM", "SIGKILL"],
            "the child ignored SIGTERM and was left running, wedging the run latch");
    });

    it("does not kick a child that already went", async () => {
        const child = fakeChild();

        terminate(child, 10);
        child.exitCode = 143;
        await new Promise((resolve) => setTimeout(resolve, 40));

        assert.deepEqual(child.signals, ["SIGTERM"]);
    });

    it("hands back a handle the caller can clear on a clean close", () => {
        const child = fakeChild();
        const escalation = terminate(child, 10);

        assert.notEqual(escalation, undefined);
        clearTimeout(escalation);
    });

    it("allows a grace period rather than escalating at once", () => {
        assert.ok(KILL_GRACE >= 1000, "a grace shorter than a second is not a grace");
    });
});

/**
 * The other half of ending a run on shutdown: knowing that it has ended.
 *
 * terminateActiveProcess only *starts* the ending - SIGTERM at once, SIGKILL a
 * second later on a timer that is deliberately unref'd. On a quiet shutdown the
 * listeners close in milliseconds and exit(0) won that race: the escalation
 * never fired, and a CLI that ignores SIGTERM outlived the server. Docker tears
 * the namespace down and takes the orphan with it, and Windows' kill() cannot
 * be ignored, so the survivor was the bare Linux install.
 */
describe("waitForActiveProcessExit", () => {
    /** A child the wait can listen to, still running until told otherwise. */
    const listeningChild = () =>
        Object.assign(new EventEmitter(), {exitCode: null, signalCode: null, kill: () => true});

    it("answers at once when nothing is tracked", async () => {
        untrackProcess(trackProcess(listeningChild()));

        assert.equal(await waitForActiveProcessExit(10), true);
    });

    it("answers at once when the tracked child has already gone", async () => {
        const child = listeningChild();
        child.exitCode = 0;
        trackProcess(child);

        try {
            assert.equal(await waitForActiveProcessExit(10), true);
        } finally {
            untrackProcess(child);
        }
    });

    it("holds the exit until the child closes", async () => {
        const child = trackProcess(listeningChild());

        try {
            const wait = waitForActiveProcessExit(1000);

            let settled = false;
            wait.then(() => { settled = true; });
            await new Promise((resolve) => setTimeout(resolve, 20));
            assert.equal(settled, false, "the wait resolved before the child had closed");

            child.exitCode = 143;
            child.emit("close", 143);

            assert.equal(await wait, true);
        } finally {
            untrackProcess(child);
        }
    });

    // A child that cannot die must not hold the shutdown for ever - the
    // deadline in shutdown.js would exit anyway, but giving up here keeps
    // db.close() on the ordinary path instead of being skipped by that exit.
    it("gives up on a child that never closes", async () => {
        const child = trackProcess(listeningChild());

        // The wait's own timer is deliberately unref'd, and this fake holds no
        // event-loop handle the way a real ChildProcess does - so without a
        // ref'd timer of the test's own, the loop drains and the runner
        // cancels the file mid-flight.
        const hold = setTimeout(() => undefined, 1000);

        try {
            assert.equal(await waitForActiveProcessExit(20), false);
            assert.equal(child.listenerCount("close"), 0, "the abandoned wait left its listener behind");
        } finally {
            clearTimeout(hold);
            untrackProcess(child);
        }
    });

    /**
     * The default wait sits between the two deadlines it has to respect: after
     * SHUTDOWN_KILL_GRACE, or it would stop waiting before the SIGKILL it is
     * waiting out has even been sent - and inside SHUTDOWN_GRACE_MS, which
     * outranks everything and must keep the last word.
     */
    it("waits past the escalation and stays inside the shutdown deadline", () => {
        assert.ok(SHUTDOWN_EXIT_WAIT > SHUTDOWN_KILL_GRACE);
        assert.ok(SHUTDOWN_EXIT_WAIT < SHUTDOWN_GRACE_MS);
    });
});

describe("exitError", () => {
    it("says nothing when the run produced a result", () => {
        assert.equal(exitError(0, {type: "result", download: {bandwidth: 1}}), null);
    });

    /**
     * A non-zero exit with a parsed result is the Ookla CLI's habit of failing
     * *after* it has printed one. The result is the measurement; the code is
     * not allowed to throw it away.
     */
    it("says nothing when there is a result despite a non-zero code", () => {
        assert.equal(exitError(1, {type: "result", download: {bandwidth: 1}}), null);
    });

    it("leaves an error the parser already found alone", () => {
        assert.equal(exitError(1, {error: "Too many requests. Please try again later"}), null);
    });

    it("reports the code when the run ended with nothing to show", () => {
        const message = exitError(2, {});

        assert.match(message, /2/);
        assert.match(message, /exit/i);
    });

    it("says nothing when a clean exit produced nothing, which is a timeout's job to explain", () => {
        assert.equal(exitError(0, {}), null);
    });

    it("reports a code of null - a child taken by a signal - as a failure", () => {
        assert.notEqual(exitError(null, {}), null);
    });

    /**
     * STATUS_DLL_NOT_FOUND. On Windows, spawn succeeds and the process dies
     * before main() with nothing on either stream, so the generic wording -
     * "exited without producing a result" - described a run that never began.
     * The stored error is what the operator reads, and it has to say a library
     * the CLI needs is not beside it in bin/.
     */
    it("explains the Windows code that means the CLI never started", () => {
        const message = exitError(WINDOWS_DLL_NOT_FOUND, {});

        assert.match(message, /library/);
        assert.match(message, /bin\//);
        assert.doesNotMatch(message, /without producing a result/);
    });

    // The new branch sits behind the unchanged gate: a result that arrived
    // despite the code is still a result.
    it("still keeps a result that arrived despite it", () => {
        assert.equal(exitError(WINDOWS_DLL_NOT_FOUND, {type: "result", download: {bandwidth: 1}}), null);
    });

    /**
     * A child taken by a signal reports `code === null`, and the generic
     * wording read "exited with code null without producing a result" - a
     * sentence that named no cause, went into the row, and went out to every
     * prose notifier. The commonest way to see it is a `docker stop` or a
     * service restart landing on a run in progress, where the truth is simply
     * that the server was leaving.
     *
     * Signal and shutdown are asked separately because they are separate
     * facts: `isShuttingDown()` is read at the call site and passed in, so this
     * stays a pure function over what it is told.
     */
    it("names the shutdown when the signal was ours", () => {
        const message = exitError(null, {}, "SIGTERM", true);

        assert.match(message, /shutting down/);
        assert.doesNotMatch(message, /code null/);
    });

    /**
     * The same death without a shutdown in progress is somebody else's kill -
     * the OOM killer, an operator's pkill, or systemd's control-group stop
     * reaching the CLI alongside the server. Naming the signal is honest;
     * claiming a shutdown that is not happening is not.
     */
    it("names the signal when the kill was not ours", () => {
        const message = exitError(null, {}, "SIGKILL", false);

        assert.match(message, /SIGKILL/);
        assert.doesNotMatch(message, /shutting down/);
        assert.doesNotMatch(message, /code null/);
    });

    // Told nothing about a signal, it answers exactly what it answered before:
    // the two-argument call is what the pure tests above use.
    it("keeps the bare code wording when no signal is named", () => {
        assert.match(exitError(null, {}), /code null/);
        assert.match(exitError(2, {}, null, true), /2/);
    });

    // The gate is unchanged, so a shutdown that still produced a measurement
    // keeps it - the round has a result and no failure to report.
    it("keeps a result that arrived before the signal", () => {
        assert.equal(exitError(null, {type: "result", download: {bandwidth: 1}}, "SIGTERM", true), null);
    });
});

/**
 * And the run that dies of a signal actually reaches all that.
 *
 * Everything above calls exitError directly, which leaves the four arguments
 * the close handler passes it entirely to the source: dropping `signal` from
 * the event's parameter list, or `isShuttingDown()` from the call, puts every
 * killed run back to "exited with code null without producing a result" with
 * the whole suite above still green. Read as text because the handler is a
 * closure inside the spawn, with a child process, two stream readers and a
 * timeout around it - the composition is what is in doubt here, not the
 * behaviour of the function it composes.
 */
describe("what the close handler hands exitError", () => {
    // Without its comments: the docblock above this handler quotes the call
    // it is explaining, so a revert that left the prose in place satisfied
    // both assertions below while the handler had lost the argument.
    const source = withoutComments(readSource("server/util/speedtest.js"));

    it("takes the signal off the event beside the code", () => {
        assert.match(source, /testProcess\.on\('close', \(code, signal\) =>/,
            "the handler never sees the signal, so a killed run has only a null code to explain itself");
    });

    it("tells it whether the shutdown was ours", () => {
        assert.match(source, /exitError\(code, result, signal, isShuttingDown\(\)\)/,
            "a run our own shutdown killed is reported as a signal from nowhere, or not at all");
    });
});
