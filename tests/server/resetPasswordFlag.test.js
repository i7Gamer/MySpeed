import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isMissingConfigTable, RESET_PASSWORD_FLAG, wantsPasswordReset } from "../../server/util/resetPassword.js";

/**
 * The one recovery path there is, and why it lives on the binary.
 *
 * A password that is set but not known has no way back through the interface:
 * the setup token and loopback access both only apply to an instance with *no*
 * password, so every remaining route is refused by the very credential that was
 * lost. Both supported deployments ship one compiled binary and no node, so a
 * separate script would not be runnable on the machine that needs it - the flag
 * has to be on the thing the operator already has.
 */
describe("wantsPasswordReset", () => {
    // argv[0] is the runtime and argv[1] the script; a real invocation carries
    // both, and reading the flag out of position 2 alone would miss it behind
    // any other argument.
    const argv = (...args) => ["/usr/bin/node", "/app/server/index.js", ...args];

    it("is off for an ordinary start", () => {
        assert.equal(wantsPasswordReset(argv()), false);
    });

    it("is on when the flag is given", () => {
        assert.equal(wantsPasswordReset(argv(RESET_PASSWORD_FLAG)), true);
    });

    it("finds the flag behind another argument", () => {
        assert.equal(wantsPasswordReset(argv("--verbose", RESET_PASSWORD_FLAG)), true);
    });

    // Starting the server is the default and the common case, so anything that
    // is not exactly the flag has to fall through to it rather than be guessed
    // at - a typo that silently cleared the password would be the worst
    // possible reading of an argument.
    it("does not answer to an approximation of the flag", () => {
        for (const near of ["--reset-passwords", "reset-password", "--reset_password",
            "--RESET-PASSWORD", "--reset-password=yes"])
            assert.equal(wantsPasswordReset(argv(near)), false, `${near} must not clear a password`);
    });

    it("reads process.argv when handed nothing", () => {
        assert.equal(wantsPasswordReset(), false, "the test runner was not started with the flag");
    });
});

/**
 * Pointed at the wrong directory, which is the mistake this command invites.
 *
 * The server resolves `data/storage.db` from the working directory, so running
 * the binary from anywhere else opens a brand new, empty database - sqlite
 * creates the file rather than refusing - and the first query fails on a table
 * that was never there. Reported raw, that reads "SQLITE_ERROR: no such table:
 * config", which says nothing about the one thing to change.
 */
describe("isMissingConfigTable", () => {
    const dialectError = (message) => Object.assign(new Error(message), {name: "SequelizeDatabaseError"});

    it("recognises an empty sqlite database", () => {
        assert.equal(isMissingConfigTable(dialectError("SQLITE_ERROR: no such table: config")), true);
    });

    it("recognises the same thing in mysql's words", () => {
        assert.equal(isMissingConfigTable(dialectError("Table 'myspeed.config' doesn't exist")), true);
    });

    /**
     * Everything else has to keep travelling. A corrupt database, a locked
     * file or a refused connection are all worth the operator's attention, and
     * answering them with "there is no configuration here" would send someone
     * whose data is at risk off to check their working directory.
     */
    it("does not swallow a database that is there and unwell", () => {
        for (const error of [
            dialectError("SQLITE_CORRUPT: database disk image is malformed"),
            dialectError("SQLITE_BUSY: database is locked"),
            Object.assign(new Error("connect ECONNREFUSED"), {name: "SequelizeConnectionRefusedError"}),
            new Error("no such table: config"),
            null,
            undefined
        ])
            assert.equal(isMissingConfigTable(error), false, `${error?.message} must not read as an empty database`);
    });
});

const ENTRY = path.resolve(fileURLToPath(import.meta.url), "..", "..", "..", "server", "index.js");
const entry = fs.readFileSync(ENTRY, "utf8");

/**
 * Where the flag is handled, which matters as much as that it is.
 *
 * The command is normally run on a machine with the instance still up: taking
 * the port, starting the scheduler or downloading a speedtest CLI on the way to
 * clearing one row would turn a recovery into an outage. A source scan, since
 * importing the entry point starts a server.
 */
describe("the reset runs instead of the server, not before it", () => {
    it("is decided before anything is started", () => {
        const decided = entry.indexOf("wantsPasswordReset()");
        const started = entry.indexOf("run().catch");

        assert.notEqual(decided, -1, "index.js never consults the flag");
        assert.ok(decided < started, "the server is started before the flag is read");
    });

    it("returns rather than falling through into the start-up", () => {
        assert.match(entry, /if \(wantsPasswordReset\(\)\) \{\s*return runPasswordReset\(\)/,
            "the reset does not stop index.js going on to start the server");
    });

    /**
     * The token this process would mint is not the one the running server
     * holds, so printing it would hand the operator a credential that the very
     * instance refusing them has never heard of.
     */
    it("does not announce a setup token of its own", () => {
        const reset = entry.slice(entry.indexOf("const runPasswordReset"), entry.indexOf("process.on('uncaughtException'"));

        assert.doesNotMatch(reset, /announceSetupToken/,
            "the reset prints a setup token minted by the wrong process");
    });
});
