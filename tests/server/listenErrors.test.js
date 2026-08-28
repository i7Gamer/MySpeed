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
        assert.match(httpSetup, /process\.exit\(/,
            "a bind failure falls through to the uncaughtException handler instead of a clean startup exit");
    });
});
