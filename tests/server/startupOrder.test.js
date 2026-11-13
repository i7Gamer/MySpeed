import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { bodyIn, withoutComments } from "../helpers/source.js";

/**
 * The order run() in server/index.js brings the server up in.
 *
 * Every step awaited ahead of app.listen() is time the port is closed and the
 * web interface looks hung (issue #135). The CLI downloads are network work
 * with no bearing on serving a page - a run checks for its binary itself - so
 * they belong behind the bind, and with them the scheduler that would use
 * them. What a request does need is the schema, the integrations, the
 * interface map and the stored defaults, so those stay ahead of it.
 */
const run = withoutComments(bodyIn("server/index.js", "const run ="));

const at = (marker) => {
    const index = run.indexOf(marker);
    assert.notEqual(index, -1, `run() no longer contains ${marker}`);
    return index;
};

const LISTEN = "app.listen(";

describe("start-up order", () => {
    for (const step of ["runMigrations()", "initializeIntegrations()", "requestInterfaces()",
        "config.insertDefaults()", "announceAccess()"])
        it(`finishes ${step} before the port opens`, () => {
            assert.ok(at(`await ${step}`) < at(LISTEN), `${step} now runs after the server is reachable`);
        });

    for (const step of ["loadCli()", "timerTask.startTimer(", "integrationTask.startTimer()",
        "timerTask.runTask({immediate: true})"])
        it(`opens the port before ${step}`, () => {
            assert.ok(at(LISTEN) < at(step), `${step} holds the port closed again`);
        });

    // The bind and its error handling are one block that listenErrors.test.js
    // reads as a slice, from app.listen( to the https half.
    it("keeps the https listener directly behind the http one", () => {
        const between = run.slice(at(LISTEN), at("hasSSLCerts()"));

        assert.doesNotMatch(between, /loadCli|startTimer|runTask/);
    });
});
