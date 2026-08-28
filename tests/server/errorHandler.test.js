import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { pathToFileURL } from "node:url";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const HANDLER = pathToFileURL(path.resolve("server/util/errorHandler.js")).href;

let workingDir;

// The handler resolves its log path from process.cwd() at import time and may
// call process.exit, so each case runs in its own process against a throwaway
// directory rather than in the test runner's.
before(() => {
    workingDir = fs.mkdtempSync(path.join(os.tmpdir(), "myspeed-errorhandler-"));
    fs.mkdirSync(path.join(workingDir, "data", "logs"), {recursive: true});
});

after(() => fs.rmSync(workingDir, {recursive: true, force: true}));

const runHandler = (options, thrown = 'new Error("boom")') => new Promise((resolve) => {
    const script = `
        process.chdir(${JSON.stringify(workingDir)});
        const {default: errorHandler} = await import(${JSON.stringify(HANDLER)});
        errorHandler(${thrown}${options ? `, ${options}` : ""});
        setTimeout(() => console.log("survived"), 250);
    `;

    execFile(process.execPath, ["--input-type=module", "-e", script], (error, stdout, stderr) =>
        resolve({code: error?.code ?? 0, stdout, stderr}));
});

const logContents = () => fs.readFileSync(path.join(workingDir, "data", "logs", "error.log"), "utf8");

describe("errorHandler", () => {
    it("logs the message either way", async () => {
        const {stderr} = await runHandler("{fatal: false}");
        assert.match(stderr, /An error occurred: boom/);
    });

    it("writes the error to the log file", async () => {
        await runHandler("{fatal: false}");
        assert.match(logContents(), /boom/);
    });

    /**
     * What was being attempted, which the message alone does not say.
     *
     * The scheduled jobs catch their own rejections now, and a bare
     * console.error there would have kept them out of this file entirely - the
     * one an operator is pointed at from the log's own header. Reported through
     * here instead, with the job's name, so the record is both kept and legible:
     * "Could not open the database" says nothing about which of the two
     * schedules was the one that could not.
     */
    describe("context", () => {
        it("names what was happening on the console", async () => {
            const {stderr} = await runHandler('{fatal: false, context: "The scheduled speedtest failed"}');

            assert.match(stderr, /The scheduled speedtest failed: boom/);
            assert.doesNotMatch(stderr, /An error occurred/, "the generic wording was kept as well");
        });

        it("keeps it in the log file too", async () => {
            await runHandler('{fatal: false, context: "The scheduled speedtest failed"}');

            const entry = logContents();
            assert.match(entry, /The scheduled speedtest failed/);
            assert.match(entry, /boom/, "the error itself was replaced rather than introduced");
        });

        it("falls back to its own wording when given none", async () => {
            assert.match((await runHandler("{fatal: false}")).stderr, /An error occurred: boom/);
        });
    });

    /**
     * A rejection is not always an Error.
     *
     * `throw "…"` and a rejected promise carrying a plain object both reach the
     * catches that report through here, and `.message` on either is undefined -
     * so the console line read "An error occurred: undefined" and the log
     * recorded the same nothing. index.js already normalises before calling
     * this; the scheduled jobs would each have had to remember to.
     */
    describe("something that is not an Error", () => {
        it("reports a thrown string", async () => {
            const {stderr} = await runHandler("{fatal: false}", '"a bare string"');

            assert.match(stderr, /a bare string/);
            assert.doesNotMatch(stderr, /undefined/);
        });

        it("writes it to the log file rather than nothing", async () => {
            await runHandler("{fatal: false}", '"a bare string"');

            assert.match(logContents(), /a bare string/);
        });

        it("survives being handed nothing at all", async () => {
            const {code, stdout} = await runHandler("{fatal: false}", "undefined");

            assert.equal(code, 0, "the reporter itself threw");
            assert.match(stdout, /survived/);
        });

        /**
         * The one input that could take the reporter down with it.
         *
         * An object with no prototype cannot be coerced to a string at all -
         * `String(value)` throws "Cannot convert object to primitive value",
         * and so did the concatenation that built the log entry before it. This
         * function is also the uncaughtException handler, so a throw inside it
         * ends the process with neither the original error nor this one
         * recorded anywhere. The last line of defence has to be unable to fail.
         */
        it("survives an object that cannot be described", async () => {
            const {code, stdout, stderr} = await runHandler("{fatal: false}", "Object.create(null)");

            assert.equal(code, 0, "the reporter threw and took the process with it");
            assert.match(stdout, /survived/);
            assert.match(stderr, /could not be described/, "nothing at all was reported");
        });

        it("still writes a line to the log for one", async () => {
            await runHandler("{fatal: false}", "Object.create(null)");

            assert.match(logContents(), /could not be described/);
        });
    });

    /**
     * Where the error came from, which is the whole reason for keeping a file.
     *
     * The entry was built by concatenating the Error into a string, and that
     * calls toString() - "Error: boom", and nothing else. So data/logs/error.log
     * held exactly what the console line above it already said, and the frames
     * were discarded at the one point they were being written down for. The
     * log's own header points bug reports at this file; what arrived was a
     * message with no indication of which of the callers produced it.
     *
     * The stack already begins with "Error: <message>", so recording it is a
     * substitution rather than an addition - nothing that read the old entry
     * loses anything.
     */
    describe("the stack", () => {
        // The function name appears in the stack and nowhere else - not in the
        // message, not in the context - so matching it cannot pass by accident.
        const thrownFrom = '(function deliberatelyNamedThrower() { return new Error("stacky"); })()';

        it("is written to the log, not just the message", async () => {
            await runHandler("{fatal: false}", thrownFrom);

            assert.match(logContents(), /deliberatelyNamedThrower/,
                "the entry is the error's toString(), so every frame was dropped");
        });

        it("keeps the message that heads it", async () => {
            await runHandler("{fatal: false}", thrownFrom);

            assert.match(logContents(), /Error: stacky/);
        });

        it("still records the context beside it", async () => {
            await runHandler('{fatal: false, context: "The scheduled speedtest failed"}', thrownFrom);

            const entry = logContents();
            assert.match(entry, /The scheduled speedtest failed/);
            assert.match(entry, /deliberatelyNamedThrower/, "the context displaced the stack");
        });

        // The console line is a summary and stays one - a stack on stderr for
        // every non-fatal integration failure is noise, and the file is where
        // the detail was always meant to go.
        it("is not added to the console line", async () => {
            const {stderr} = await runHandler("{fatal: false}", thrownFrom);

            assert.match(stderr, /An error occurred: stacky/);
            assert.doesNotMatch(stderr, /deliberatelyNamedThrower/, "stderr now carries a full stack per error");
        });

        /**
         * An Error can reach here without one: a cross-realm error, one built
         * where Error.stackTraceLimit was 0, or a caller that assembled the
         * object itself. This function is the uncaughtException handler, so
         * "undefined" is not an acceptable thing to write instead.
         */
        it("falls back to the message when the error carries none", async () => {
            await runHandler("{fatal: false}",
                'Object.assign(new Error("stackless"), {stack: undefined})');

            const entry = logContents();
            assert.match(entry, /stackless/);
            assert.doesNotMatch(entry, /## [^\n]*\nundefined/, "the entry recorded the word undefined");
        });
    });

    /**
     * The reason describeError exists, seen from the end an operator reads.
     *
     * Upstream #1549: a validation failure reported as "Validation error" and
     * nothing else, 138 times, ended by deleting the database. The columns and
     * the rule sit on properties of the error, and neither the console line nor
     * the stack carried them - a stack's first line is "Error: <message>", which
     * is the same nothing.
     *
     * Built by hand rather than imported so this holds whatever sequelize's own
     * constructors do next: what is being asserted is that the handler reads the
     * properties, not that one library shape survives.
     */
    describe("an error carrying detail behind its message", () => {
        const validationError = `(() => {
            const error = new Error("Validation error");
            error.name = "SequelizeValidationError";
            error.errors = [{message: "", type: "notNull Violation", path: "ping"}];
            return error;
        })()`;

        it("names the column and the rule on the console", async () => {
            const {stderr} = await runHandler("{fatal: false}", validationError);

            assert.match(stderr, /notNull Violation on ping/,
                "the operator is told only that something is invalid");
        });

        it("keeps them in the log file, alongside the frames", async () => {
            await runHandler("{fatal: false}", validationError);

            const entry = logContents();
            assert.match(entry, /notNull Violation on ping/);
            assert.match(entry, /at /, "the stack was dropped to make room for the detail");
        });

        /**
         * The entries accumulate in one file, so this reads the last one rather
         * than the whole log - every case above has already written "boom" into
         * it, and a scan of the file would match those.
         */
        it("does not repeat an ordinary error's message above its own stack", async () => {
            await runHandler("{fatal: false}");

            const lastEntry = logContents().split("\n\n## ").pop();

            assert.doesNotMatch(lastEntry, /\nboom\nError: boom/,
                "an error with nothing hidden behind it is now recorded twice");
        });
    });

    describe("fatal", () => {
        it("exits with a failure code by default", async () => {
            const {code, stdout} = await runHandler();
            assert.equal(code, 1);
            assert.doesNotMatch(stdout, /survived/, "the process must not outlive a fatal error");
        });

        it("still exits when asked explicitly", async () => {
            assert.equal((await runHandler("{fatal: true}")).code, 1);
        });
    });

    /**
     * Which failure it was, not merely that there was one.
     *
     * server/index.js keeps distinct start-up codes - 111 for a database that
     * would not open, 112 for a start-up that did not finish - so an operator,
     * and whatever supervises the process, can tell an expected clash from a
     * state that cannot be reasoned about. The http listener's bind failure is
     * the second of those, and it exited on its own precisely because reporting
     * it through here would have flattened it to the generic 1 - which left the
     * failure out of data/logs/error.log altogether, the one file the log's own
     * header points bug reports at.
     */
    describe("the exit code", () => {
        // The start-up code server/index.js names; kept here as the value a
        // caller may ask for, not as anything this module knows about.
        const STARTUP_FAILED_EXIT = 112;

        it("is the one the caller named", async () => {
            assert.equal((await runHandler(`{fatal: true, code: ${STARTUP_FAILED_EXIT}}`)).code,
                STARTUP_FAILED_EXIT, "a caller's own start-up code was flattened to the generic 1");
        });

        it("still writes the log before leaving with it", async () => {
            await runHandler(`{fatal: true, code: ${STARTUP_FAILED_EXIT}}`);

            assert.match(logContents(), /boom/, "the exit outran the write it was waiting on");
        });

        // Every existing caller passes no code at all, so the default is the
        // one thing here that must not move.
        it("stays 1 when none is named", async () => {
            assert.equal((await runHandler("{fatal: true}")).code, 1);
        });

        /**
         * And it is named where its neighbours are named.
         *
         * Every other code that reaches this function has a name at the top of
         * the module it comes from: server/index.js keeps 111, 112, 113 and 114
         * that way, each with a paragraph saying what it asks of the operator.
         * The default sat in the destructuring as a bare 1 - which says only
         * "a failure", and says it in the one place a reader looking for the
         * answer is least likely to check.
         *
         * The value is what every existing caller relies on and is pinned by the
         * case above; this asks only that it also be reachable by a name.
         */
        it("names the default rather than leaving a literal in the signature", () => {
            const module = fs.readFileSync(path.resolve("server/util/errorHandler.js"), "utf8");

            assert.match(module, /const\s+[A-Z][A-Z_]*\s*=\s*1;/,
                "there is no named constant for the code a caller that names none exits with");
            assert.doesNotMatch(module, /code\s*=\s*\d/,
                "the default exit code is a bare number in the destructuring, unlike every code its callers name");
        });

        it("is not consulted at all when the error is not fatal", async () => {
            const {code, stdout} = await runHandler(`{fatal: false, code: ${STARTUP_FAILED_EXIT}}`);

            assert.equal(code, 0, "a code turned a survivable error into an exit");
            assert.match(stdout, /survived/);
        });
    });

    // The regression this guards: server/index.js installs an unhandledRejection
    // handler specifically so one failing integration cannot take the server
    // down, and the handler then exited anyway.
    describe("non-fatal", () => {
        it("lets the process carry on", async () => {
            const {code, stdout} = await runHandler("{fatal: false}");
            assert.equal(code, 0);
            assert.match(stdout, /survived/);
        });
    });
});
