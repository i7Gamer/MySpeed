import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { bootServer, api } from "./helpers/boot.js";

let server;
let controller;

const realFetch = globalThis.fetch;

const RESULT = {ping: 12, jitter: 2, download: 500, upload: 200, time: 30};

before(async () => {
    server = await bootServer();
    controller = await import("../../server/controller/integrations.js");
});

after(async () => {
    globalThis.fetch = realFetch;
    await server?.close();
});

beforeEach(async () => {
    for (const row of await controller.getActive()) await controller.deleteIntegration(row.id);
});

/**
 * initialize() registers every module's event callbacks, and used only to
 * append them.
 *
 * The map they land in was never cleared, so a second initialisation left the
 * first pass's callbacks in place and added another set beside them - and
 * triggerEvent runs all of them. After N initialisations an operator receives N
 * copies of every notification, and N activity rows are written per event.
 *
 * The fields array three lines below it in the same function is deliberately
 * rebuilt for exactly this reason, with a comment saying that initialize() runs
 * more than once - so the hazard was known, and half of it was handled.
 *
 * Latent in production today: server/index.js calls this once, and the test
 * harness caches its boot. What was wrong is the shape - a function documented
 * as safe to re-run, one half of which was not - and the second caller already
 * exists.
 */
describe("loading the integrations twice", () => {
    const sent = [];

    const withStubbedFetch = async (run) => {
        globalThis.fetch = async (url, options) => {
            sent.push({url, options});
            return {ok: true, status: 200, text: async () => "", json: async () => ({})};
        };

        try {
            await run();
        } finally {
            globalThis.fetch = realFetch;
        }
    };

    const notifyOnce = async () => {
        sent.length = 0;
        await withStubbedFetch(() => controller.triggerEvent("testFinished", RESULT));
        return sent.length;
    };

    it("does not send a second copy of every notification", async () => {
        const {status} = await api(server.baseUrl, "/integrations/webhook", {
            method: "PUT",
            headers: {"content-type": "application/json"},
            body: JSON.stringify({
                url: "https://hooks.example.invalid/myspeed",
                integration_name: "hook",
                send_finished: true
            })
        });
        assert.equal(status, 200, "the webhook the count is taken from was not created");

        const once = await notifyOnce();
        assert.equal(once, 1, "the webhook did not fire at all, so the count below proves nothing");

        await controller.initialize();
        assert.equal(await notifyOnce(), once,
            "a second load doubled every notification the operator receives");

        await controller.initialize();
        await controller.initialize();
        assert.equal(await notifyOnce(), once,
            "the callbacks stack up with each load rather than replacing the last set");
    });

    // The definitions still have to be there afterwards: clearing the callbacks
    // must not clear what the interface offers to configure.
    it("still serves every integration definition", async () => {
        const before = Object.keys(controller.getIntegrations()).length;

        await controller.initialize();

        assert.equal(Object.keys(controller.getIntegrations()).length, before);
        assert.ok(before > 0, "no integrations are registered at all");
    });

    // And the fields do not stack either, which is the half that was already
    // right - asserted here so the two cannot drift apart.
    it("still leaves the fields the length they were", async () => {
        const before = controller.getIntegration("webhook").fields.length;

        await controller.initialize();

        assert.equal(controller.getIntegration("webhook").fields.length, before);
    });
});
