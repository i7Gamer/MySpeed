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
