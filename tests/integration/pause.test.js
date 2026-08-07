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

describe("fractional pauses", () => {
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
     * Regression: resumeIn validated with a digits-only regex against the
     * stringified number, so the decimal point matched and every fractional
     * value was refused - including the 0.5 steps the pause dialog's own input
     * offers. postRequest does not check the status, so the dialog reported
     * those pauses as applied while the scheduler kept running.
     */
    it("accepts a half-hour pause", async () => {
        assert.equal((await pause({resumeIn: 0.5})).status, 200);
        assert.equal(await isPaused(), true);
    });

    it("accepts other fractional durations the input allows", async () => {
        for (const hours of [1.5, 2.5, 0.1]) {
            await api(server.baseUrl, "/speedtests/continue", {method: "POST"});
            assert.equal((await pause({resumeIn: hours})).status, 200, `rejected ${hours}`);
        }
    });

    it("still refuses a negative duration", async () => {
        assert.equal((await pause({resumeIn: -5})).status, 400);
        assert.equal(await isPaused(), false);
    });

    it("still refuses something that is not a number", async () => {
        assert.equal((await pause({resumeIn: "2 hours"})).status, 400);
        assert.equal(await isPaused(), false);
    });

    // A duration beyond what setTimeout can hold used to overflow and fire
    // immediately; it now holds until it is lifted by hand.
    it("holds a duration larger than setTimeout can represent", async () => {
        assert.equal((await pause({resumeIn: 100000})).status, 200);
        assert.equal(await isPaused(), true);

        await new Promise((resolve) => setTimeout(resolve, 50));
        assert.equal(await isPaused(), true);
    });
});
