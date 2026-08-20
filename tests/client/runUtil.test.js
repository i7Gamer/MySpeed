import { describe, it, beforeEach, afterEach, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const realLocalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");

// RequestUtil reads the selected node out of localStorage on every call, so the
// stub has to exist before its module graph is loaded.
globalThis.localStorage = {getItem: () => null, setItem: () => undefined, removeItem: () => undefined};

const { startSpeedtest } = await import("../../client/src/common/utils/RunUtil.js");

const realFetch = globalThis.fetch;

let requested = [];

beforeEach(() => {
    requested = [];
    globalThis.fetch = async (url) => {
        requested.push(String(url));
        return new Response("{}", {status: 200, headers: {"content-type": "application/json"}});
    };
});

afterEach(() => {
    globalThis.fetch = realFetch;
});

after(() => {
    if (realLocalStorage) Object.defineProperty(globalThis, "localStorage", realLocalStorage);
    else delete globalThis.localStorage;
    globalThis.fetch = realFetch;
});

const alertSpy = () => {
    const shown = [];
    return {shown, alert: {openAlert: (title, message) => { shown.push(message); }}};
};

const run = async (overrides = {}) => {
    const {shown, alert} = alertSpy();
    const calls = {status: 0, tests: 0, running: []};

    await startSpeedtest({
        status: {paused: false, running: false},
        config: {viewMode: false},
        updateStatus: async () => { calls.status += 1; },
        setRunning: (value) => calls.running.push(value),
        updateTests: async () => { calls.tests += 1; },
        alert,
        ...overrides
    });

    return {shown, calls};
};

/**
 * startSpeedtest awaited a status refresh and then re-read the *captured*
 * status, which updateStatus does not return - so the guard could only ever see
 * the render-time snapshot it was handed. Worse, StartTestButton derives
 * `disabled` from that same snapshot, so `blocked` was null by construction
 * whenever the handler could fire at all: the branch was unreachable, and the
 * comment above it described something that had stopped being true.
 *
 * The refresh itself stays. It is what puts the gauge and the poll back in step
 * after a run, which is the reason it was awaited before the request and again
 * in the finally.
 */
describe("startSpeedtest", () => {
    it("starts the test", async () => {
        const {calls} = await run();

        assert.equal(requested.filter((url) => url.includes("/speedtests/run")).length, 1);
        assert.deepEqual(calls.running, [true]);
        assert.equal(calls.tests, 1);
    });

    it("refreshes the status around the run", async () => {
        const {calls} = await run();

        assert.equal(calls.status, 2, "the status is read before the run and again after it");
    });

    it("says so when the server refuses the run", async () => {
        globalThis.fetch = async () => new Response(JSON.stringify({message: "Already running"}),
            {status: 409, headers: {"content-type": "application/json"}});

        const {shown, calls} = await run();

        assert.deepEqual(shown, ["Already running"]);
        assert.deepEqual(calls.running, [true, false]);
        assert.equal(calls.tests, 0);
    });

    it("says so when the request never lands", async () => {
        globalThis.fetch = async () => { throw new Error("offline"); };

        const {shown, calls} = await run();

        assert.equal(shown.length, 1);
        assert.deepEqual(calls.running, [true, false]);
    });
});

describe("the vestigial guard", () => {
    const source = fs.readFileSync(fileURLToPath(
        new URL("../../client/src/common/utils/RunUtil.js", import.meta.url)), "utf8");

    it("is gone", () => {
        assert.doesNotMatch(source, /startBlockedReason/,
            "the guard reads a snapshot the awaited refresh cannot have changed");
    });

    it("leaves no comment describing it", () => {
        assert.doesNotMatch(source, /status bar/i,
            "the comment still names a second caller the header refactor removed");
    });
});
