import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
    clearedReport, isMissingConfigTable, noConfigReport, RESET_ALREADY_CLEAR, RESET_CLEARED,
    RESET_PASSWORD_FLAG, wantsPasswordReset
} from "../../server/util/resetPassword.js";

/**
 * The one recovery path there is, and why it lives on the binary.
 *
 * A password that is set but not known has no way back through the interface:
 * the setup token and loopback access both only apply to an instance with *no*
 * password, so every remaining route is refused by the very credential that was
 * lost. It is a flag on the entry point rather than a script beside it so that
 * each deployment can reach it with what it already has - a compiled binary on
 * Windows, the bun runtime and the server sources under Docker - since a
 * separate script would not be runnable on both.
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
 * Both translations, wherever the documentation is asserted against the code.
 *
 * An operator reading the German one is no less likely to be scripting the
 * recovery, or to be the one locked out - and a claim that is corrected in one
 * file and left standing in the other is the same wrong instruction, given to
 * half as many people.
 */
const readmes = () => ["README.md", "README.de.md"].map((name) => ({
    name,
    text: fs.readFileSync(path.resolve(ENTRY, "..", "..", name), "utf8")
}));

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

/**
 * The three ways this command can stop, as a script driving it reads them.
 *
 * "There is no configuration in this database" and "the reset itself failed"
 * are opposite instructions - the first says the path is wrong and the data is
 * elsewhere, the second says the path is right and the data is in trouble - and
 * a recovery command answering both with one number tells the second operator
 * to go looking in the wrong place. isMissingConfigTable is deliberately narrow
 * so that a corrupt or locked database keeps travelling rather than being
 * reported as an empty one; these codes are where it travels to, and collapsing
 * them here would undo that narrowness at the last step.
 *
 * Scanned from the source rather than run, for the same reason as the block
 * above: importing the entry point starts a server.
 */
describe("the reset's exit codes", () => {
    const codeOf = (name) => {
        const declared = entry.match(new RegExp(`const ${name} = (\\d+);`));
        assert.notEqual(declared, null, `index.js declares no ${name}`);

        return Number(declared[1]);
    };

    const nothingToDo = () => codeOf("RESET_NOTHING_TO_DO_EXIT");
    const failed = () => codeOf("RESET_FAILED_EXIT");

    it("says 'nothing to do' and 'it did not work' with different numbers", () => {
        assert.notEqual(nothingToDo(), failed(),
            "a failed reset is reported with the code that means nothing was wrong");
    });

    /**
     * And neither may borrow a start-up code. 111 is a database that would not
     * open and 112 a start-up that did not finish; both can happen on the way
     * to a reset, and a script that saw one of them would report the wrong
     * thing entirely.
     */
    it("does not reuse the codes an ordinary start already spends", () => {
        for (const code of [nothingToDo(), failed()])
            assert.ok(![111, 112, 0].includes(code), `${code} already means something else`);
    });

    // The catch is the whole point: it is the branch that was answering a real
    // failure - a locked database, a read-only data directory - with the code
    // that means the command found nothing to do and nothing was wrong.
    it("uses the failure code where the reset actually fails", () => {
        const start = entry.indexOf("if (wantsPasswordReset())");
        const handler = entry.slice(start, entry.indexOf("run().catch", start));

        assert.match(handler, /RESET_FAILED_EXIT/,
            "a reset that threw does not exit with the failure code");
        assert.doesNotMatch(handler, /RESET_NOTHING_TO_DO_EXIT/,
            "a reset that threw still exits with the code that means nothing was wrong");
    });

    /**
     * And the operator has to be able to look them up.
     *
     * Two codes exist so that something reading them can tell the cases apart,
     * which is worth nothing while the numbers live only in this file - the
     * README is where anyone driving the command actually looks. Both
     * translations, because an operator reading the German one is no less
     * likely to be scripting the recovery.
     *
     * Asserted against the constants rather than against a copy of the numbers,
     * so changing a code here fails until the documentation follows it.
     */
    it("is documented with the same numbers it exits with", () => {
        for (const {name, text} of readmes())
            for (const code of [nothingToDo(), failed()])
                assert.ok(text.includes(String(code)), `${name} documents no exit code ${code}`);
    });

    /**
     * And the nothing-to-do code has to stay in the branch that means it.
     *
     * The assertion above reads the handler wrapped around runPasswordReset,
     * which is where the failure code is spent - and that slice begins below
     * runPasswordReset itself, so the one place RESET_NOTHING_TO_DO_EXIT is
     * actually used sits outside everything this describe block had been
     * reading. Collapsing the two codes at their real site left the pair above
     * passing, which is the shape of gap that lets a distinction be documented
     * and then quietly stop existing.
     */
    it("spends the two codes in the two places that mean them", () => {
        const reset = entry.slice(entry.indexOf("const runPasswordReset"),
            entry.indexOf("process.on('uncaughtException'"));

        assert.match(reset, /RESET_NOTHING_TO_DO_EXIT/,
            "the branch that found no configuration no longer exits with the nothing-to-do code");
        assert.doesNotMatch(reset, /RESET_FAILED_EXIT/,
            "the reset spends the failure code itself, which belongs to the caller that catches it");
    });
});

/**
 * The database is closed before the command stops, on every way out of it.
 *
 * sqlite is opened in WAL mode, so a live handle has a -wal and a -shm beside
 * the database file, and exiting without closing leaves them behind
 * uncheckpointed. Under `docker exec` that is not merely untidy: exec skips the
 * entrypoint, and with it the privilege drop, so this command runs as root and
 * those two files are created root-owned inside a volume the server reads as
 * another user. It then cannot write them, and stays broken until the container
 * is restarted and the entrypoint chowns the directory again - a recovery
 * command that costs the operator the instance it just recovered.
 *
 * Asserted structurally: every stop goes through one place, and that place
 * closes first. Running it is not an option - it ends in process.exit.
 */
describe("the reset closes the database it opened", () => {
    const blockFrom = (marker) => {
        const at = entry.indexOf(marker);
        assert.notEqual(at, -1, `${marker} is not in index.js`);

        const ends = entry.slice(at).search(/\r?\n\r?\n/);
        return ends === -1 ? entry.slice(at) : entry.slice(at, at + ends);
    };

    const resetBody = () => entry.slice(entry.indexOf("const runPasswordReset"),
        entry.indexOf("process.on('uncaughtException'"));

    const failureHandler = () => {
        const start = entry.indexOf("if (wantsPasswordReset())");
        return entry.slice(start, entry.indexOf("run().catch", start));
    };

    it("closes the connection on the way out", () => {
        assert.match(blockFrom("const stopAfterReset"), /await db\.close\(\)/,
            "the command exits with the database still open, leaving its WAL files behind");
    });

    it("leaves no other way to stop", () => {
        assert.doesNotMatch(resetBody(), /process\.exit/,
            "the reset exits directly, without closing the database first");
        assert.match(resetBody(), /stopAfterReset/, "the reset never stops at all");
    });

    // Including the branch where the write failed. That one has most likely
    // just touched the database, so it is the last place to walk away from an
    // open handle.
    it("closes on the failed path as well", () => {
        assert.doesNotMatch(failureHandler(), /process\.exit/,
            "a failed reset exits with the database still open");
        assert.match(failureHandler(), /stopAfterReset\(RESET_FAILED_EXIT\)/);
    });
});

/**
 * The documented Docker invocation, read against the image that has to run it.
 *
 * Windows installs a compiled binary, so `MySpeed --reset-password` is the whole
 * command there. The image is the other way round: its final stage copies the
 * server sources and the bun runtime, and the docker workflow never runs
 * `build:binary`, so there is no `MySpeed` in the container at all - a
 * documented `./MySpeed` is a file that does not exist, and the operator reading
 * it has by then run out of other ways in.
 *
 * Taken from the Dockerfile's own CMD rather than pinned to a string here, so
 * that moving the entry point fails this until the documentation follows it.
 */
describe("the documented Docker reset runs what the image actually ships", () => {
    const dockerfile = fs.readFileSync(path.resolve(ENTRY, "..", "..", "Dockerfile"), "utf8");

    const entryScript = () => {
        const cmd = dockerfile.match(/^CMD \[(.+)]$/m);
        assert.notEqual(cmd, null, "the Dockerfile no longer declares its CMD as an array");

        const script = JSON.parse(`[${cmd[1]}]`).find((argument) => argument.endsWith(".js"));
        assert.notEqual(script, undefined, "the image's CMD runs no script");

        return script;
    };

    /**
     * The passage that tells the operator what to type, not the whole file: the
     * READMEs name the Windows binary a few lines above, and that mention is
     * correct.
     *
     * Ended on a blank line matched by regex rather than on "\n\n", because
     * these files are stored with CRLF endings - searching for the bare pair
     * finds nothing, and the slice then runs to the end of the document and
     * takes every later mention of the binary with it.
     */
    const dockerParagraph = (text) => {
        const start = text.indexOf("docker exec");
        assert.notEqual(start, -1, "this README documents no Docker invocation of the reset");

        const blank = text.slice(start).search(/\r?\n[ \t]*\r?\n/);
        assert.notEqual(blank, -1, "the Docker invocation runs to the end of the file");

        return text.slice(start, start + blank);
    };

    it("names the entry point the image runs", () => {
        for (const {name, text} of readmes())
            assert.ok(dockerParagraph(text).includes(entryScript()),
                `${name} documents a Docker reset that does not run ${entryScript()}`);
    });

    it("does not send the operator after a binary the image never builds", () => {
        for (const {name, text} of readmes())
            assert.doesNotMatch(dockerParagraph(text), /MySpeed/,
                `${name} tells a Docker operator to run a compiled binary, which the image has none of`);
    });

    // The same claim is made a third time, in the module's own doc comment,
    // which is where anyone changing this command reads it first.
    it("is described the same way where the flag is defined", () => {
        const source = fs.readFileSync(path.resolve(ENTRY, "..", "util", "resetPassword.js"), "utf8");
        const comment = source.slice(0, source.indexOf("export const RESET_PASSWORD_FLAG"));

        assert.ok(comment.includes("docker exec"), "the doc comment no longer says how to reach this under Docker");
        assert.ok(comment.includes(entryScript()),
            `the doc comment documents a Docker reset that does not run ${entryScript()}`);
    });
});

/**
 * What the command prints, which is the whole of what the operator gets.
 *
 * It exits immediately afterwards, so these lines are not a summary of a state
 * they can go and inspect - they are the state, as far as anyone running this at
 * midnight is concerned. Built as values rather than printed from inside the
 * handler so that the branches can be read here rather than scanned for in the
 * source of a file that starts a server when imported.
 */
describe("what the reset tells the operator afterwards", () => {
    const report = (outcome, env) => clearedReport(outcome, env).join("\n");

    it("distinguishes a password it removed from one that was never set", () => {
        assert.match(report(RESET_CLEARED, {}), /password has been removed/);
        assert.match(report(RESET_ALREADY_CLEAR, {}), /already had no password/);
    });

    it("describes the setup-token state the instance is actually left in", () => {
        assert.match(report(RESET_CLEARED, {}), /setup token/);
    });

    /**
     * Unless it is not left in that state at all.
     *
     * ALLOW_NO_PASSWORD is consulted only while the stored value is the
     * unconfigured sentinel - which is exactly what this command restores - so
     * a variable that was a no-op for as long as a password was set becomes
     * live again the moment the password goes. The instance is then reachable
     * by anyone who can route to it, and the banner was telling the operator
     * the opposite: that every other machine is now being asked for a token.
     * The boot-time warning that covers this case never runs here, because the
     * reset returns before the server starts.
     */
    it("says so when ALLOW_NO_PASSWORD leaves the instance open instead", () => {
        const open = report(RESET_CLEARED, {ALLOW_NO_PASSWORD: "true"});

        assert.match(open, /ALLOW_NO_PASSWORD/,
            "the operator is not told the variable that is now letting everyone in");
        assert.doesNotMatch(open, /asks every other|setup token/,
            "the banner still claims a setup token protects an instance that is wide open");
    });

    // Only the exact value, as everywhere else this variable is read: the
    // instance is only open when the middleware agrees it is.
    it("does not warn for a value that does not enable it", () => {
        for (const value of ["false", "1", "TRUE", "yes", ""])
            assert.doesNotMatch(report(RESET_CLEARED, {ALLOW_NO_PASSWORD: value}), /ALLOW_NO_PASSWORD/,
                `${value} does not open the instance, so it must not be reported as though it had`);
    });
});

/**
 * And where to look when it found no configuration to reset.
 *
 * The remedy is the whole content of exit 113: the code says "the data is
 * somewhere else", and this line is what says where to go and look. Pointed at
 * the wrong thing it is worse than nothing, because it is specific enough to be
 * believed.
 */
describe("where the reset sends an operator who has no configuration", () => {
    it("names the data directory for a file database", () => {
        assert.match(noConfigReport({}).join("\n"), /data directory/);
    });

    /**
     * A MySQL install has no data directory to check, and its working directory
     * has nothing to do with which database it opened - the connection is named
     * entirely by environment variables. Sending that operator to look at a path
     * costs them the one thing the exit code was for. The start-up handler
     * already draws this distinction for the same reason.
     */
    it("names the connection for a mysql one", () => {
        const mysql = noConfigReport({DB_TYPE: "mysql"}).join("\n");

        assert.doesNotMatch(mysql, /data directory/,
            "a mysql install is sent to check a directory that has nothing to do with its database");
        assert.match(mysql, /DB_NAME/, "the operator is not told which setting actually chose this database");
    });

    it("says there is nothing to reset either way", () => {
        for (const env of [{}, {DB_TYPE: "mysql"}])
            assert.match(noConfigReport(env).join("\n"), /no MySpeed configuration/);
    });
});
