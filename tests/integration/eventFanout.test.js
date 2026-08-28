import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { bootServer, api } from "./helpers/boot.js";

/**
 * How one event reaches several integrations.
 *
 * The fan-out used to await each integration in turn, so one dead endpoint held
 * every later notification for its full OUTBOUND_TIMEOUT - and the message most
 * likely to be behind a slow send is the failure alert, which is the one nobody
 * can afford to have arrive late. The sends are dispatched together now; what
 * must not change with that is the containment the sequential loop already had,
 * which the second test holds in place.
 */

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

afterEach(() => {
    globalThis.fetch = realFetch;
});

const createTelegram = async (name) => {
    const {status, body} = await api(server.baseUrl, "/integrations/telegram", {
        method: "PUT",
        headers: {"content-type": "application/json"},
        body: JSON.stringify({
            token: "123456:abcdefghijklmnopqrstuvwxyz", chat_id: "42",
            send_finished: true, integration_name: name
        })
    });

    assert.equal(status, 200, `could not create the integration: ${JSON.stringify(body)}`);

    return body.id;
};

describe("fanning one event out to several integrations", () => {
    it("does not make the second send wait for the first", async () => {
        await createTelegram("first");
        await createTelegram("second");

        let outboundCalls = 0;
        let firstPending = false;
        let overlapped = false;
        let releaseFirst;
        const firstHeld = new Promise((resolve) => { releaseFirst = resolve; });

        globalThis.fetch = async (url, init = {}) => {
            if (String(url).startsWith(server.baseUrl)) return realFetch(url, init);

            outboundCalls += 1;

            if (outboundCalls === 1) {
                // Held open until the second send shows up. The fallback is
                // what makes a serial dispatch fail the assertion below
                // instead of deadlocking the suite: with nothing else to
                // release it, the first send lets go on its own and the
                // second then arrives too late to count as overlap.
                firstPending = true;
                const fallback = setTimeout(releaseFirst, 500);
                await firstHeld;
                clearTimeout(fallback);
                firstPending = false;
            } else {
                if (firstPending) overlapped = true;
                releaseFirst();
            }

            return new Response("{}", {status: 200, headers: {"content-type": "application/json"}});
        };

        await controller.triggerEvent("testFinished", RESULT);

        assert.equal(outboundCalls, 2, "an integration was skipped");
        assert.ok(overlapped, "the second send waited for the first to finish");
    });

    // The containment the sequential loop had, kept: a send that throws is that
    // integration's failure, and the others still hear about the test.
    it("still delivers to the second integration when the first send throws", async () => {
        await createTelegram("first");
        await createTelegram("second");

        const sent = [];

        globalThis.fetch = async (url, init = {}) => {
            if (String(url).startsWith(server.baseUrl)) return realFetch(url, init);

            sent.push(String(url));
            if (sent.length === 1) throw new Error("ECONNREFUSED");

            return new Response("{}", {status: 200, headers: {"content-type": "application/json"}});
        };

        await controller.triggerEvent("testFinished", RESULT);

        assert.equal(sent.length, 2, "the first send's failure ended the whole fan-out");
    });

    /**
     * The alerts switch on a target quiets the notifiers through this same
     * fan-out - the flag travels on the payload, so this is the whole path a
     * stored integration row sees. The sink half is unit-tested against
     * suppressesEvent, because the sinks either need a broker or listen to
     * other events entirely.
     */
    it("tells no notifier about a member that opted out of alerting", async () => {
        await createTelegram("first");

        const sent = [];

        globalThis.fetch = async (url, init = {}) => {
            if (String(url).startsWith(server.baseUrl)) return realFetch(url, init);

            sent.push(String(url));
            return new Response("{}", {status: 200, headers: {"content-type": "application/json"}});
        };

        await controller.triggerEvent("testFinished", {...RESULT, alerts: false});
        assert.deepEqual(sent, [], "an unwatched member's result still paged the notifier");

        await controller.triggerEvent("testFinished", {...RESULT, alerts: true});
        assert.equal(sent.length, 1, "the watched member's result was withheld too");
    });
});
