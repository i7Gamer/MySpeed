import {after, before, describe, it} from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {EventEmitter} from "node:events";
import {PassThrough} from "node:stream";
import {downloadToFile} from "../../server/util/providers/downloadHelper.js";

const DEADLINE = 40;
const HALF_DEADLINE = DEADLINE / 2;
const REDIRECT_DELAY = DEADLINE * 0.75;
let directory;
before(() => { directory = fs.mkdtempSync(path.join(os.tmpdir(), "myspeed-deadline-")); });
after(() => fs.rmSync(directory, {recursive: true, force: true}));

const requestDouble = () => {
    const request = new EventEmitter();
    request.destroyed = false;
    request.setTimeout = () => {};
    request.destroy = () => { request.destroyed = true; };
    return request;
};

describe("the whole download deadline", () => {
    it("closes an unused redirect body and ignores its cleanup errors while the final transfer completes", async () => {
        const requests = [];
        const responses = [];
        const destination = path.join(directory, "closed-redirect");
        const pending = downloadToFile("https://download.invalid/start", destination, {
            client: (_url, callback) => {
                const request = requestDouble();
                requests.push(request);
                const redirect = requests.length === 1;
                const response = Object.assign(new PassThrough(), redirect
                    ? {statusCode: 302, headers: {location: "/binary"}}
                    : {statusCode: 200, headers: {}});
                responses.push(response);
                queueMicrotask(() => callback(response));
                return request;
            }
        });
        // Observe the promise from the outset so a mistaken late-error
        // rejection is still an ordinary assertion failure.
        const outcome = pending.then(() => null, error => error);
        try {
            await new Promise(setImmediate);
            assert.equal(responses[0].destroyed, true, "unused redirect response must be closed immediately");
            requests[0].emit("error", new Error("redirect socket closed"));
            responses[0].emit("error", new Error("redirect body closed"));
            responses[1].end("complete");
            assert.equal(await outcome, null);
            assert.equal(fs.readFileSync(destination, "utf8"), "complete");
        } finally {
            for (const response of responses) response.destroy();
            if (responses[1] && !responses[1].readableEnded)
                requests[1].emit("error", new Error("test cleanup"));
            await outcome;
        }
    });

    it("ends an active trickle, removes partial output and permits a retry", async (t) => {
        t.mock.timers.enable({apis: ["setTimeout"]});
        const destination = path.join(directory, "trickle");
        const response = Object.assign(new PassThrough(), {statusCode: 200, headers: {}});
        const request = requestDouble();
        const client = (_url, callback) => { queueMicrotask(() => callback(response)); return request; };
        try {
            const pending = downloadToFile("https://download.invalid/binary", destination,
                {client, timeoutMs: DEADLINE});
            await new Promise(setImmediate);
            response.write("first bytes");
            t.mock.timers.tick(HALF_DEADLINE);
            response.write("still active");
            t.mock.timers.tick(HALF_DEADLINE);
            await assert.rejects(pending, /deadline/i);
            assert.equal(request.destroyed, true);
            assert.equal(response.destroyed, true);
            assert.equal(fs.existsSync(destination), false);
        } finally {
            response.destroy();
        }

        await downloadToFile("https://download.invalid/binary", destination, {
            client: (_url, callback) => {
                const completed = Object.assign(new PassThrough(), {statusCode: 200, headers: {}});
                queueMicrotask(() => { callback(completed); completed.end("complete"); });
                return requestDouble();
            }
        });
        assert.equal(fs.readFileSync(destination, "utf8"), "complete");
    });

    it("uses one deadline across redirects", async (t) => {
        t.mock.timers.enable({apis: ["setTimeout"]});
        const requests = [];
        const timers = [];
        const client = (_url, callback) => {
            const request = requestDouble();
            requests.push(request);
            const first = requests.length === 1;
            timers.push(setTimeout(() => {
                if (request.destroyed) return;
                const response = Object.assign(new PassThrough(), first
                    ? {statusCode: 302, headers: {location: "/binary"}}
                    : {statusCode: 200, headers: {}});
                callback(response);
                response.end(first ? "" : "complete");
            }, REDIRECT_DELAY));
            return request;
        };
        try {
            const pending = downloadToFile("https://download.invalid/start",
                path.join(directory, "redirect"), {client, timeoutMs: DEADLINE});
            t.mock.timers.tick(REDIRECT_DELAY);
            t.mock.timers.tick(DEADLINE - REDIRECT_DELAY);
            await assert.rejects(pending, /deadline/i);
            assert.equal(requests.length, 2);
            assert.equal(requests.at(-1).destroyed, true);
        } finally {
            timers.forEach(clearTimeout);
        }
    });

    it("clears its deadline after successful completion", async (t) => {
        t.mock.timers.enable({apis: ["setTimeout"]});
        const request = requestDouble();
        await downloadToFile("https://download.invalid/done", path.join(directory, "done"), {
            timeoutMs: DEADLINE,
            client: (_url, callback) => {
                const response = Object.assign(new PassThrough(), {statusCode: 200, headers: {}});
                queueMicrotask(() => { callback(response); response.end("done"); });
                return request;
            }
        });
        t.mock.timers.tick(DEADLINE * 2);
        assert.equal(request.destroyed, false);
    });

    it("reports an exception opening a redirected request", async () => {
        const error = new Error("could not open redirected request");
        let requests = 0;
        await assert.rejects(downloadToFile("https://download.invalid/start",
            path.join(directory, "open-error"), {client: (_url, callback) => {
                if (requests++ > 0) throw error;
                queueMicrotask(() => callback(Object.assign(new PassThrough(), {
                    statusCode: 302, headers: {location: "/next"}
                })));
                return requestDouble();
            }}), error);
    });
});
