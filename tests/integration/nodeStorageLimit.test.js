import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { bootServer, api } from "./helpers/boot.js";

/**
 * The proxied form of the heaviest family in the API, which app.js used to
 * meter only when the request started with /api/storage.
 *
 * A node's own storage lives behind the proxy at /api/nodes/<id>/storage/...,
 * a path that never starts with /api/storage - so every request routed
 * through a node fell past the 20/min expensive limit onto the general
 * 300/min backstop, while the same request made directly against this
 * instance's own storage was capped at 20. This file drives the proxied path
 * the way security.test.js already drives the direct one, against a stub node
 * that answers everything with 200 so the count is the only thing under test.
 */

// One more than the expensive limit (20 as of writing) is enough to prove a
// 429 exists in the run without hard-coding the exact number the limiter
// carries - the same margin security.test.js uses for the direct route.
const REQUESTS_ABOVE_THE_EXPENSIVE_LIMIT = 25;

let server;
let upstream;
let upstreamUrl;
let nodeId;

/**
 * A stand-in child instance that answers every path, including the handshake
 * PUT /nodes performs, with the same 200 JSON body. What is being metered
 * here is the parent's limiter, not anything the child does with a request.
 */
const startStubUpstream = () => new Promise((resolve) => {
    const node = http.createServer((req, res) => {
        res.writeHead(200, {"content-type": "application/json"});
        res.end(JSON.stringify({ping: "25", download: "100", viewMode: false}));
    });

    node.listen(0, "127.0.0.1", () => resolve(node));
});

before(async () => {
    // The stub listens on loopback, which the SSRF guard refuses by default -
    // a real node is never the machine MySpeed itself runs on. This is the
    // documented opt-out.
    process.env.ALLOW_LOCAL_NODES = "true";

    server = await bootServer();
    upstream = await startStubUpstream();
    upstreamUrl = `http://127.0.0.1:${upstream.address().port}`;

    const {body} = await api(server.baseUrl, "/nodes", {
        method: "PUT",
        headers: {"content-type": "application/json"},
        body: JSON.stringify({name: "child", url: upstreamUrl, password: null})
    });

    nodeId = body.id;
});

after(async () => {
    delete process.env.ALLOW_LOCAL_NODES;
    await new Promise((resolve) => upstream.close(resolve));
    await server?.close();
});

describe("the expensive limit on a proxied node route", () => {
    it("registers the stub node", () => {
        assert.ok(nodeId, "the node was not created");
    });

    it("throttles more than the expensive limit worth of proxied storage requests", async () => {
        let refused = null;

        for (let attempt = 0; attempt < REQUESTS_ABOVE_THE_EXPENSIVE_LIMIT && refused === null; attempt++) {
            const {status} = await api(server.baseUrl, `/nodes/${nodeId}/storage/config`);
            if (status === 429) refused = attempt;
        }

        assert.notEqual(refused, null,
            "a proxied /api/nodes/<id>/storage/... request was never throttled");
    });

    // The control: the same number of proxied requests to a route that is not
    // storage still lands on the 300/min backstop alone, so this is a fact
    // about the /storage mount and not about the proxy in general.
    it("does not throttle the same count of proxied requests to a non-storage route", async () => {
        server.resetRateLimits();

        for (let attempt = 0; attempt < REQUESTS_ABOVE_THE_EXPENSIVE_LIMIT; attempt++) {
            const {status} = await api(server.baseUrl, `/nodes/${nodeId}/speedtests/status`);
            assert.notEqual(status, 429,
                `a non-storage proxied route was throttled on attempt ${attempt}`);
        }
    });
});
