import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { bootServer, api, setConfig } from "./helpers/boot.js";
import { FINISHED_VARIABLES } from "../../server/util/notificationPayload.js";
import { DATE_VARIABLES } from "../../server/util/helpers.js";

let server;
let runSpeedtest;

const realFetch = globalThis.fetch;
let sent = [];

before(async () => {
    server = await bootServer();
    runSpeedtest = (await import("../../server/tasks/speedtest.js")).create;

    // A fresh install has no provider, and a run without one is refused before
    // anything is measured or announced. Preview mode supplies the result, but
    // the setting still has to name someone.
    await setConfig(server.config, "provider", "cloudflare");
});

after(async () => {
    globalThis.fetch = realFetch;
    delete process.env.PREVIEW_MODE;
    await server?.close();
});

beforeEach(() => {
    sent = [];
    globalThis.fetch = async (url, init = {}) => {
        if (String(url).startsWith(server.baseUrl)) return realFetch(url, init);

        let body = init.body;
        try {
            body = JSON.parse(init.body);
        } catch {

        }

        sent.push({url: String(url), body});
        return new Response("{}", {status: 200, headers: {"content-type": "application/json"}});
    };
});

afterEach(() => {
    globalThis.fetch = realFetch;
    delete process.env.PREVIEW_MODE;
});

/**
 * The finished notification is deliberately not awaited by the task - a slow
 * webhook must not hold the run lock - so the run returns before it goes out.
 */
const waitForEvent = async (type, timeoutMs = 10000) => {
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
        const request = sent.find((entry) => entry.body?.event === type);
        if (request) return request;

        await new Promise((resolve) => setTimeout(resolve, 25));
    }

    return null;
};

const createWebhook = async (settings = {}) => {
    const {status, body} = await api(server.baseUrl, "/integrations/webhook", {
        method: "PUT",
        headers: {"content-type": "application/json"},
        body: JSON.stringify({
            url: "https://hooks.example.invalid/myspeed",
            send_finished: true, send_failed: true,
            integration_name: "hook", ...settings
        })
    });

    assert.equal(status, 200, `could not create the webhook: ${JSON.stringify(body)}`);

    return body.id;
};

/**
 * What actually leaves the building when a test finishes.
 *
 * The payload builder is pinned by its own unit tests; this pins that the task
 * hands it everything it needs. Between the two sits the destructuring of a
 * parsed result and the row the write returned, which is exactly where a field
 * goes missing without anything failing - the notification simply carries one
 * fewer key than it should, which no existing test would have noticed.
 *
 * Driven through the task rather than the HTTP route so preview mode can supply
 * a result without the route's own preview-mode refusals getting in the way.
 */
describe("the payload a finished test sends", () => {
    it("carries every field the notification advertises", async () => {
        const id = await createWebhook();
        process.env.PREVIEW_MODE = "true";

        try {
            await runSpeedtest("manual");

            const finished = await waitForEvent("TEST_FINISHED");
            assert.ok(finished, `no TEST_FINISHED was sent, got ${JSON.stringify(sent.map((r) => r.body?.event))}`);

            const expected = FINISHED_VARIABLES.filter((name) => !DATE_VARIABLES.includes(name));
            assert.deepEqual(Object.keys(finished.body.data).sort(), expected.sort());
        } finally {
            delete process.env.PREVIEW_MODE;
            await api(server.baseUrl, `/integrations/${id}`, {method: "DELETE"});
        }
    });

    it("names the test, the moment and the provider that ran it", async () => {
        const id = await createWebhook();
        process.env.PREVIEW_MODE = "true";

        try {
            await runSpeedtest("manual");

            const {data} = (await waitForEvent("TEST_FINISHED")).body;

            assert.equal(typeof data.id, "number");
            assert.ok(!Number.isNaN(Date.parse(data.created)), `created is not a date: ${data.created}`);
            assert.ok(data.provider, "no provider was named");

            // The five it always sent, still there and still numbers.
            for (const key of ["ping", "download", "upload", "time"])
                assert.equal(typeof data[key], "number", `${key} is not a number`);
        } finally {
            delete process.env.PREVIEW_MODE;
            await api(server.baseUrl, `/integrations/${id}`, {method: "DELETE"});
        }
    });

    // The row the notification names has to be the row that was written, or a
    // consumer cannot look the test up afterwards.
    it("names a test that can be read back", async () => {
        const id = await createWebhook();
        process.env.PREVIEW_MODE = "true";

        try {
            await runSpeedtest("manual");

            const {data} = (await waitForEvent("TEST_FINISHED")).body;
            const stored = await server.tests.findOne({where: {id: data.id}});

            assert.ok(stored, `no row with id ${data.id}`);
            assert.equal(stored.download, data.download);
            assert.equal(new Date(stored.created).toISOString(), new Date(data.created).toISOString());
        } finally {
            delete process.env.PREVIEW_MODE;
            await api(server.baseUrl, `/integrations/${id}`, {method: "DELETE"});
        }
    });
});
