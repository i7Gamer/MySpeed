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

const runHandler = (options) => new Promise((resolve) => {
    const script = `
        process.chdir(${JSON.stringify(workingDir)});
        const {default: errorHandler} = await import(${JSON.stringify(HANDLER)});
        errorHandler(new Error("boom")${options ? `, ${options}` : ""});
        setTimeout(() => console.log("survived"), 250);
    `;

    execFile(process.execPath, ["--input-type=module", "-e", script], (error, stdout, stderr) =>
        resolve({code: error?.code ?? 0, stdout, stderr}));
});

describe("errorHandler", () => {
    it("logs the message either way", async () => {
        const {stderr} = await runHandler("{fatal: false}");
        assert.match(stderr, /An error occurred: boom/);
    });

    it("writes the error to the log file", async () => {
        await runHandler("{fatal: false}");
        const log = fs.readFileSync(path.join(workingDir, "data", "logs", "error.log"), "utf8");
        assert.match(log, /boom/);
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
