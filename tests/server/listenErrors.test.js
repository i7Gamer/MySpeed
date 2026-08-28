import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

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

describe("the http listener's error handling", () => {
    // From where the http server is created to where the https one begins, so
    // the https handler cannot stand in for the http one these assert is present.
    const httpSetup = source.slice(source.indexOf("app.listen("), source.indexOf("hasSSLCerts()"));

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
    // From the handler to the end of the http setup, so the assertions below
    // cannot be satisfied by app.listen's own callback.
    const errorPath = httpSetup.slice(httpSetup.search(/\.on\(\s*["']error["']/));

    it("records the failure through errorHandler, so it reaches the log file", () => {
        assert.match(errorPath, /errorHandler\(/,
            "a bind failure is reported to the console only and never written to data/logs/error.log");
    });

    it("asks whether the listener ever bound before calling it a start-up failure", () => {
        assert.match(errorPath, /listening/,
            "an 'error' on a running listener is reported as a failure to bind, which it is not");
    });

    it("leaves the exit to the reporter rather than taking a bound server down itself", () => {
        assert.doesNotMatch(errorPath, /process\.exit\(/,
            "an accept failure hours after start-up exits a healthy instance with the start-up code");
    });
});
