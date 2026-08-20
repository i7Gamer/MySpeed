import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { postJson, postText } from "../../server/util/http.js";

/**
 * A redirect is the far end choosing a destination after the check has passed.
 *
 * checkOutboundTarget runs once, on the URL the operator stored - and fetch's
 * default is to follow redirects. So an endpoint that answered 307 with
 * Location: http://169.254.169.254/ had the guarded request delivered there,
 * method and body intact, with the guard never consulted about the new address.
 * safeRequest closed exactly this hole for the node path and wrote the rule
 * down: "Redirects are never followed." These two senders are held to it here.
 *
 * The redirect target in these cases is another loopback route rather than a
 * blocked address, deliberately: what is asserted is that the request is never
 * re-sent anywhere at all, which is stronger than the guard refusing one
 * particular destination - and it keeps the test off the real network.
 */
let server;
let baseUrl;

/** Every request the far end actually received, by route. */
let received;

const PERMANENT_REDIRECT = 308;
const TEMPORARY_REDIRECT = 307;
const FOUND = 302;

before(async () => {
    server = http.createServer((req, res) => {
        received.push({url: req.url, method: req.method});

        if (req.url.startsWith("/redirect")) {
            const status = Number(req.url.split("/").at(-1));
            res.writeHead(status, {location: `${baseUrl}/target`});
            return res.end();
        }

        res.writeHead(200, {"content-type": "application/json"});
        res.end("{}");
    });

    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(() => new Promise((resolve) => server.close(resolve)));

beforeEach(() => {
    received = [];
});

const redirectUrl = (status) => `${baseUrl}/redirect/${status}`;

const hitsOn = (route) => received.filter((request) => request.url === route).length;

describe("a redirecting integration endpoint", () => {
    for (const status of [PERMANENT_REDIRECT, TEMPORARY_REDIRECT, FOUND]) {
        it(`postJson never follows a ${status}`, async () => {
            const outcome = await postJson(redirectUrl(status), {a: 1});

            assert.equal(hitsOn("/target"), 0, "the redirect was followed");
            assert.equal(outcome, null, "a refused send has to answer the way a failed one does");
        });
    }

    it("postText never follows one either", async () => {
        const outcome = await postText(redirectUrl(TEMPORARY_REDIRECT), "payload");

        assert.equal(hitsOn("/target"), 0, "the redirect was followed");
        assert.equal(outcome, null);
    });

    // The failure has to reach the integration card, not just the log: the
    // activity note is the only thing the dialog reads.
    it("reports the refusal through the activity callback", async () => {
        const noted = [];
        await postJson(redirectUrl(TEMPORARY_REDIRECT), {a: 1}, {activity: (failed) => noted.push(failed)});

        assert.deepEqual(noted, [true]);
    });
});

// The rule must cost nothing on the path every healthy webhook takes.
describe("an endpoint that answers directly", () => {
    it("still receives the post and reports the outcome", async () => {
        const outcome = await postJson(`${baseUrl}/ok`, {a: 1});

        assert.equal(hitsOn("/ok"), 1);
        assert.deepEqual(outcome, {ok: true, status: 200});
    });
});
