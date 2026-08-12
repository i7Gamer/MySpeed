import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { KILL_GRACE, exitError, hasExited, terminate } from "../../server/util/speedtest.js";

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
});
