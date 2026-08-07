import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { bootServer, api } from "./helpers/boot.js";

let server;

before(async () => {
    server = await bootServer();
});

after(async () => {
    await server?.close();
});

describe("POST /api/speedtests/pause", () => {
    beforeEach(async () => {
        await api(server.baseUrl, "/speedtests/continue", {method: "POST"});
    });

    const pause = (body) => api(server.baseUrl, "/speedtests/pause", {
        method: "POST",
        headers: {"content-type": "application/json"},
        body: JSON.stringify(body)
    });

    const isPaused = async () => (await api(server.baseUrl, "/speedtests/status")).body.paused;

    /**
     * Regression: the "pause indefinitely" preset in PauseDialog sends
     * resumeIn 0, but the route guarded with `if (!req.body.resumeIn)` and
     * answered 400. postRequest does not assert on the status, so the dialog
     * reported success while the scheduler kept firing tests.
     */
    it("pauses indefinitely when the client sends 0", async () => {
        const {status} = await pause({resumeIn: 0});

        assert.equal(status, 200);
        assert.equal(await isPaused(), true);
    });

    it("still accepts the -1 sentinel older clients send", async () => {
        assert.equal((await pause({resumeIn: -1})).status, 200);
        assert.equal(await isPaused(), true);
    });

    it("pauses for a whole number of hours", async () => {
        assert.equal((await pause({resumeIn: 2})).status, 200);
        assert.equal(await isPaused(), true);
    });

    it("rejects a request that omits the field entirely", async () => {
        const {status} = await pause({});

        assert.equal(status, 400);
        assert.equal(await isPaused(), false);
    });

    it("rejects a value that is not a number of hours", async () => {
        const {status} = await pause({resumeIn: "soon"});

        assert.equal(status, 400);
        assert.equal(await isPaused(), false);
    });

    it("resumes on /continue", async () => {
        await pause({resumeIn: 0});
        assert.equal((await api(server.baseUrl, "/speedtests/continue", {method: "POST"})).status, 200);
        assert.equal(await isPaused(), false);
    });

    it("blocks a manual run while paused", async () => {
        await pause({resumeIn: 0});

        const {status, body} = await api(server.baseUrl, "/speedtests/run", {method: "POST"});
        assert.equal(status, 410);
        assert.match(body.message, /paused/i);
    });
});
