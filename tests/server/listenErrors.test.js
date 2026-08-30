import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { bodyOf, withoutJsComments } from "../helpers/source.js";

/**
 * The HTTP listener says when it cannot bind.
 *
 * index.js cannot be imported to be asked - it opens the database, downloads a
 * CLI and takes the port - so the wiring is read rather than run, the way
 * shutdown.test.js and runStateRelease.test.js read theirs.
 *
 * app.listen(port) returns a server that emits 'error' with no listener when the
 * port is already taken - another copy of the server is the realistic cause -
 * and Node rethrows that as an uncaughtException. That path is for states that
 * genuinely cannot be reasoned about; routing a benign, expected port clash
 * through it logs the clash as a fatal fault and exits a generic 1. The https
 * listener beside it has carried an 'error' handler all along - this is the http
 * one catching up to it, with the deliberate startup exit run()'s own catch uses.
 */
const root = path.resolve(fileURLToPath(import.meta.url), "..", "..", "..");
const source = fs.readFileSync(path.join(root, "server/index.js"), "utf8");

// From where the http server is created to where the https one begins, and from
// there to the end, so neither listener's handler can stand in for the other's
// in what the two describes below assert is present.
const httpSetup = source.slice(source.indexOf("app.listen("), source.indexOf("hasSSLCerts()"));
const httpsSetup = source.slice(source.indexOf("hasSSLCerts()"));

// One listener's 'error' handler: from where it is attached to the push that
// follows it, so neither the listen callback beside it nor anything later in the
// block can satisfy assertions written about the handler.
const errorHandlerOf = (setup) =>
    setup.slice(setup.search(/\.on\(\s*["']error["']/), setup.indexOf("listeners.push("));

/**
 * What a listener's 'error' handler does once the listener is already up.
 *
 * The two branches are told apart by the return that ends the first: a bind
 * failure is reported and returned from, so what follows the last return in a
 * handler is what an instance that is still serving gets. Sliced rather than
 * matched whole because most of what matters about this half is what is *not*
 * in it - a start-up exit code, a flag that says TLS is down - and matching the
 * handler entire would find both of those in the branch above.
 *
 * A handler with no return in it has no branch held back from a bound listener,
 * so the whole of it is what one gets. Said explicitly because the arithmetic
 * below would otherwise slice from the first statement's semicolon and hand back
 * almost nothing - which is every "this is not in the post-bind branch"
 * assertion passing against a handler that has no branches at all, the exact
 * shape they exist to reject.
 *
 * And the slice proves it still holds the branch, the same anchoring the
 * release walker does with its push line: a return added *after* the reporter
 * call would move "last return" past the branch and collapse the slice to a
 * closing brace, at which point every doesNotMatch built on it holds against
 * nothing. The reporter call is the one thing the branch cannot be without.
 */
const postBindBranchOf = (handler) => {
    const lastReturn = handler.lastIndexOf("return");
    const branch = lastReturn === -1 ? handler : handler.slice(handler.indexOf(";", lastReturn) + 1);

    assert.match(branch, /report(Http|Https)Error\(/,
        "the post-bind slice no longer contains the reporter call, so nothing below it is being asserted");

    return branch;
};

describe("the http listener's error handling", () => {
    it("attaches an error handler to the listener it keeps", () => {
        assert.match(httpSetup, /\.on\(\s*["']error["']/,
            "app.listen's server is kept with no error handler, so a failed bind is an uncaught exception");
    });

    it("exits deliberately on a bind failure rather than crashing as an uncaught fault", () => {
        assert.match(httpSetup, /STARTUP_FAILED_EXIT/,
            "a bind failure falls through to the uncaughtException handler instead of a clean startup exit");
    });

    /**
     * What the handler that replaced the uncaughtException path gave up.
     *
     * That path wrote the fault to data/logs/error.log on its way out - through
     * errorHandler, which is the only thing that writes that file, and which the
     * log's own header points bug reports at. A console.error and a bare exit in
     * its place leaves an operator whose port is taken with a line in whatever
     * captured stdout and nothing on disk at all.
     *
     * And the handler stays attached for the life of the listener, so it is not
     * only the bind it hears. A healthy instance that runs out of descriptors
     * emits 'error' on accept hours later; reported as "could not listen on port
     * X" and exited with the start-up code, that is a wrong diagnosis followed by
     * a shutdown nobody asked for. The https listener beside it logs and carries
     * on, and after the bind this one has to as well - the only difference being
     * that before the bind there is no server to carry on as.
     */
    const errorPath = errorHandlerOf(httpSetup);

    it("records the failure through errorHandler, so it reaches the log file", () => {
        assert.match(errorPath, /errorHandler\(/,
            "a bind failure is reported to the console only and never written to data/logs/error.log");
    });

    /**
     * The guard itself, rather than a word that happens to appear near it.
     *
     * This asked only that "listening" occurred somewhere in the handler, and
     * the non-fatal branch's own wording - "The server listening on port X
     * reported an error" - contains it. So the assertion was answered by a
     * string literal instead of by the branch it was written to protect:
     * collapsing the whole handler to one unconditional fatal call, with a
     * context phrased that way, left this green. What has to be present is the
     * question being asked of the listener, so that is what is matched.
     */
    it("asks whether the listener ever bound before calling it a start-up failure", () => {
        assert.match(errorPath, /if\s*\(\s*!\s*httpServer\.listening\s*\)/,
            "an 'error' on a running listener is reported as a failure to bind, which it is not");
    });

    it("keeps the start-up exit code out of the branch that runs on a bound server", () => {
        assert.doesNotMatch(postBindBranchOf(errorPath), /STARTUP_FAILED_EXIT/,
            "an accept failure hours after start-up is reported as a start-up that never finished");
    });

    it("leaves the exit to the reporter rather than taking a bound server down itself", () => {
        assert.doesNotMatch(errorPath, /process\.exit\(/,
            "an accept failure hours after start-up exits a healthy instance with the start-up code");
    });
});

/**
 * The https listener says the same things, and stops saying one of them.
 *
 * It has carried an 'error' handler all along - the http one above was written
 * to catch up to it - but not this shape of one. A console.error and nothing
 * else meant a failure that took TLS down was never written to
 * data/logs/error.log, the file the log's own header points bug reports at, and
 * the operator got a line in whatever captured stdout instead.
 *
 * The unconditional setHttpsListening(false) beside it is the worse half.
 * That flag is what httpsRedirect consults before sending a caller from the
 * plain port to this one, and the handler stays attached for the life of the
 * listener - so an 'error' that has nothing to do with binding, an accept out of
 * descriptors or a client that went away mid-handshake, marks TLS down on a
 * listener that is still up and still serving. Nothing sets it back: the only
 * setHttpsListening(true) is in the listen callback, which has already run. The
 * redirect stops for good and callers stay on http for a port that never went
 * anywhere.
 *
 * So: the same split as the handler above, minus the exit. https is optional
 * here - an instance with no certificates serves plain http quite happily - and
 * a certificate or port problem must not be the thing that stops a server that
 * would otherwise come up.
 */
describe("the https listener's error handling", () => {
    const httpsErrorPath = errorHandlerOf(httpsSetup);

    it("asks whether the listener ever bound, as the http handler beside it does", () => {
        assert.match(httpsErrorPath, /if\s*\(\s*!\s*httpsServer\.listening\s*\)/,
            "every 'error' is answered as a failed bind, whatever the listener was doing at the time");
    });

    it("records the failure through errorHandler, so it reaches the log file", () => {
        assert.match(httpsErrorPath, /errorHandler\(/,
            "a TLS failure is reported to the console only and never written to data/logs/error.log");
    });

    it("stops the redirect when the listener never came up", () => {
        assert.match(httpsErrorPath, /setHttpsListening\(\s*false\s*\)/,
            "a failed bind leaves httpsRedirect sending callers to a port with nothing behind it");
    });

    it("leaves the redirect alone when the listener is still up", () => {
        assert.doesNotMatch(postBindBranchOf(httpsErrorPath), /setHttpsListening/,
            "a passing error on a healthy listener marks TLS down for good, and nothing sets it back");
    });

    it("never exits, because an instance without TLS still serves", () => {
        assert.doesNotMatch(httpsErrorPath, /process\.exit\(/,
            "a certificate problem takes down a server that was serving plain http quite happily");
        assert.doesNotMatch(httpsErrorPath, /fatal:\s*true/,
            "the failure is reported as fatal, which is errorHandler being asked to exit");
    });
});

/**
 * A failing accept is not one event.
 *
 * Both handlers report a post-bind 'error' through errorHandler, and that
 * appends an entry to data/logs/error.log every single time it is called. The
 * failures that reach it there do not arrive once: a process that has run out of
 * file descriptors emits EMFILE for every connection the kernel hands it, for as
 * long as callers keep arriving - so the report meant to explain a quiet failure
 * is a log file with no ceiling on it. And when the write is itself what is
 * failing, which a full disk makes likely in exactly this situation,
 * errorHandler answers each call with a second console line and the flood simply
 * moves to stdout.
 *
 * So the first occurrence of a fault is written down in full and the ones
 * behind it are counted, silently - a console line per suppressed event would
 * only move the unbounded growth into the journal every deployment here
 * captures. The count rides on that fault's next full entry, so the log still
 * says the storm continued without growing with it; a storm that simply stops
 * leaves its last count unflushed, which is accepted, because its first entry
 * recorded the fault in full.
 *
 * Per listener, so a busy http listener cannot mute the https one beside it.
 */
describe("how often a bound listener's errors are written down", () => {
    // From the reporter to run(), so the interval has to be consulted by the
    // thing deciding whether to write, not merely declared somewhere above it.
    const reporter = source.slice(source.indexOf("const listenerErrorReporter"), source.indexOf("const run ="));

    const httpPostBind = postBindBranchOf(errorHandlerOf(httpSetup));
    const httpsPostBind = postBindBranchOf(errorHandlerOf(httpsSetup));

    it("names the interval instead of burying the number in the reporter", () => {
        assert.match(source, /const\s+LISTENER_ERROR_LOG_INTERVAL_MS\s*=\s*\d+/,
            "how long a repeat is held for is a bare literal with nothing saying what it is");
    });

    it("consults it before reporting the same trouble again", () => {
        assert.match(reporter, /LISTENER_ERROR_LOG_INTERVAL_MS/,
            "every 'error' a bound listener raises is appended to the log, one per connection attempt");
    });

    it("keeps the window it is reporting inside, so the first is never held back", () => {
        assert.match(reporter, /windowStart/,
            "there is nothing to measure the interval from, so either all are written or none are");
    });

    it("is what the http listener's post-bind branch reports through", () => {
        assert.match(httpPostBind, /reportHttpError\(/,
            "the http listener writes an entry for every failing accept");
    });

    it("is what the https listener's post-bind branch reports through", () => {
        assert.match(httpsPostBind, /reportHttpsError\(/,
            "the https listener writes an entry for every failing accept");
    });

    // The pin that puts the throttle on the path rather than merely near it: a
    // direct call beside the reporter is a second, unthrottled way to the log.
    it("is not bypassed by a direct report beside it", () => {
        assert.doesNotMatch(httpPostBind, /errorHandler\(/,
            "the http post-bind branch reaches errorHandler without passing the interval");
        assert.doesNotMatch(httpsPostBind, /errorHandler\(/,
            "the https post-bind branch reaches errorHandler without passing the interval");
    });

    // "Per listener" is a claim about run(), not about the factory: one
    // reporter handed to both handlers would share a window, and the executed
    // isolation case below can only prove what the factory makes possible.
    it("gives each listener a reporter of its own", () => {
        assert.match(httpSetup, /const reportHttpError = listenerErrorReporter\(\)/,
            "the http listener reports through something other than its own reporter");
        assert.match(httpsSetup, /const reportHttpsError = listenerErrorReporter\(\)/,
            "the https listener reports through something other than its own reporter");
    });
});

/**
 * The reporter itself, executed - the scans above proved less than they
 * claimed. Deleting the line that records the report's own time left the
 * throttle completely inert, restoring the unbounded log growth this exists to
 * end, and every scan stayed green; a *different* failure inside the window
 * was suppressed behind a console line claiming it was "already recorded" -
 * untrue, and if it never recurred it never reached the log at all; the
 * suppressed branch printed one stderr line per event, which under a storm is
 * the same unbounded growth moved into the journal; and the wall clock the
 * delta read goes backward under NTP steps and VM resumes, silencing the log
 * until real time catches up. Lifted and run with an injected clock and a
 * recording errorHandler, the way the verdict deadline is.
 */
describe("the reporter, executed", () => {
    // Far enough apart that an off-by-one in the comparison cannot blur the
    // inside/outside cases.
    const INTERVAL = 1000;

    // The factory itself, not an instance of it: run() calls
    // listenerErrorReporter() once per listener, and only instances made by
    // one evaluation can show whether they share state. A harness that
    // evaluated the source once per instance got isolation for free from its
    // own scoping, and would have stayed green with every reporter sharing
    // one window.
    const liftFactory = () => {
        const stripped = withoutJsComments(source);
        const factory = bodyOf(stripped, "const listenerErrorReporter");

        // Off zero, deliberately: the first cut's dead `lastReported !== 0`
        // guard made a report at clock 0 read as never having happened, and a
        // harness starting there exercised that artifact instead of the
        // window.
        const clock = {value: 5 * INTERVAL, now() { return this.value; }};
        const reports = [];
        const consoleLines = [];

        const make = new Function("Date", "performance", "LISTENER_ERROR_LOG_INTERVAL_MS",
            "errorHandler", "console",
            `return (() => ${factory});`)(
            clock, clock, INTERVAL,
            (err, options) => reports.push({err, options}),
            {error: (line) => consoleLines.push(line)});

        return {clock, reports, consoleLines, make};
    };

    const build = () => {
        const rig = liftFactory();
        return {...rig, report: rig.make()};
    };

    const fault = (code) => Object.assign(new Error(`accept ${code}`), {code});

    it("reports the first fault in full, whenever it arrives", () => {
        const {reports, report} = build();

        report(fault("EMFILE"), "the listener");

        assert.equal(reports.length, 1);
        assert.equal(reports[0].options.fatal, false);
        assert.match(reports[0].options.context, /the listener/);
    });

    it("suppresses a repeat of the same fault silently", () => {
        const {clock, reports, consoleLines, report} = build();

        report(fault("EMFILE"), "the listener");
        clock.value += INTERVAL / 2;
        report(fault("EMFILE"), "the listener");

        assert.equal(reports.length, 1, "every repeat is appended to the log");
        assert.deepEqual(consoleLines, [],
            "one stderr line per suppressed event is the same unbounded growth, moved into the journal");
    });

    it("reports a different fault inside the window at once", () => {
        const {clock, reports, report} = build();

        report(fault("EMFILE"), "the listener");
        clock.value += INTERVAL / 2;
        report(fault("ECONNABORTED"), "the listener");

        assert.equal(reports.length, 2,
            "a failure that never happened before is told it was already recorded");
    });

    it("reports again past the window, carrying the suppressed count", () => {
        const {clock, reports, report} = build();

        report(fault("EMFILE"), "the listener");
        clock.value += INTERVAL / 2;
        report(fault("EMFILE"), "the listener");
        report(fault("EMFILE"), "the listener");
        clock.value += INTERVAL;
        report(fault("EMFILE"), "the listener");

        assert.equal(reports.length, 2);
        assert.match(reports[1].options.context, /\b2\b/,
            "the storm's continuation is invisible: the log reads as one quiet failure");
    });

    it("keeps two listeners' reporters apart", () => {
        // Two instances from ONE evaluation, the way run() makes them - a
        // rig per instance would isolate them by construction and prove
        // nothing about the factory.
        const {clock, reports, make} = liftFactory();
        const http = make();
        const https = make();

        http(fault("EMFILE"), "http");
        clock.value += INTERVAL / 2;
        https(fault("EMFILE"), "https");

        assert.equal(reports.length, 2, "a busy http listener mutes the https one");
        assert.doesNotMatch(reports[1].options.context, /suppressed/,
            "one listener's storm is counted against the other's entry");
    });

    // errorHandler's own asError normalises whatever shape gets reported, so
    // the reporter has to survive the shapes that reach it: an Error with no
    // code, and a value that is not an Error at all. They share one bucket -
    // keyed by message, a storm whose message carries the peer's address
    // would make every event distinct, and the log would grow without a
    // ceiling again, which is the exact growth the reporter exists to end.
    it("holds every codeless fault in one bucket, whatever its message says", () => {
        const {clock, reports, report} = build();

        report(new Error("read ETIMEDOUT 10.0.0.7:443"), "the listener");
        clock.value += INTERVAL / 2;
        report(new Error("read ETIMEDOUT 10.0.0.9:443"), "the listener");
        report("boom", "the listener");

        assert.equal(reports.length, 1,
            "a storm with a varying message writes one entry per event, which is no ceiling at all");
    });

    it("tells faults apart by code even when the message is one shared string", () => {
        const {clock, reports, report} = build();

        report(fault("EMFILE"), "the listener");
        clock.value += INTERVAL / 2;
        report(Object.assign(new Error("accept EMFILE"), {code: "ECONNABORTED"}), "the listener");

        assert.equal(reports.length, 2,
            "two different faults wearing one message are treated as the same fault");
    });

    // The count is the fault's own. A shared counter flushed EMFILE's storm
    // onto whichever entry came next - an unrelated ECONNABORTED's, which
    // then read as N occurrences of a fault that happened once - and left
    // EMFILE's own next entry saying nothing about its storm at all.
    it("credits a suppressed storm to its own fault, not to whoever reports next", () => {
        const {clock, reports, report} = build();

        report(fault("EMFILE"), "the listener");
        clock.value += INTERVAL / 4;
        report(fault("EMFILE"), "the listener");
        report(fault("EMFILE"), "the listener");
        clock.value += INTERVAL / 4;
        report(fault("ECONNABORTED"), "the listener");
        clock.value += INTERVAL;
        report(fault("EMFILE"), "the listener");

        assert.equal(reports.length, 3);
        assert.doesNotMatch(reports[1].options.context, /suppressed/,
            "EMFILE's storm is written against the one ECONNABORTED that happened");
        assert.match(reports[2].options.context, /\b2\b/,
            "EMFILE's own next entry no longer says its storm continued");
    });

    // Two storms of different lengths, so a count that is never reset - or a
    // note built from anything but the count - cannot stay green by echoing
    // the first storm's number.
    it("counts each storm afresh rather than accumulating across entries", () => {
        const {clock, reports, report} = build();

        report(fault("EMFILE"), "the listener");
        for (let i = 0; i < 4; i++) report(fault("EMFILE"), "the listener");
        clock.value += INTERVAL;
        report(fault("EMFILE"), "the listener");
        for (let i = 0; i < 2; i++) report(fault("EMFILE"), "the listener");
        clock.value += INTERVAL;
        report(fault("EMFILE"), "the listener");

        assert.equal(reports.length, 3);
        assert.match(reports[1].options.context, /\b4\b/);
        assert.match(reports[2].options.context, /\b2\b/,
            "the second storm's count still carries the first storm in it");
        assert.doesNotMatch(reports[2].options.context, /\b[46]\b/);
    });

    // The clock itself: monotonic, never the wall clock a stepped NTP or a
    // resumed VM moves backward - a backward step read as "inside the window"
    // for as long as the step was long.
    it("does not measure its window with the wall clock", () => {
        const reporter = bodyOf(withoutJsComments(source), "const listenerErrorReporter");

        assert.doesNotMatch(reporter, /Date\.now/,
            "an NTP step back silences the log until real time catches up");
        assert.match(reporter, /performance\.now/,
            "nothing monotonic measures the window");
    });
});
