import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { bootServer, api } from "./helpers/boot.js";
import nodeModel from "../../server/models/Node.js";

const nodeModelFor = () => nodeModel;

let server;
let upstream;
let upstreamUrl;
let nodeId;

/** Requests the fake node received, so the proxy's header handling is observable. */
let received = [];

/** How many /api/hang requests arrived, and how many were closed unanswered. */
let hangReceived = 0;
let hangClosed = 0;

const CSV_BODY = "id,ping,download\r\n1,10,100";

/**
 * A stand-in for a child MySpeed instance. It answers the handshake
 * checkStatus() performs and serves one JSON and one CSV endpoint, which is
 * enough to tell a faithful proxy from one that rewrites the body.
 */
const startUpstream = () => new Promise((resolve) => {
    const node = http.createServer((req, res) => {
        received.push({url: req.url, method: req.method, headers: req.headers});

        if (req.url.startsWith("/api/config")) {
            res.writeHead(200, {"content-type": "application/json"});
            return res.end(JSON.stringify({ping: "25", download: "100", viewMode: false}));
        }

        if (req.url.startsWith("/api/speedtests/export")) {
            res.writeHead(200, {
                "content-type": "text/csv",
                "content-disposition": 'attachment; filename="myspeed-export.csv"'
            });
            return res.end(CSV_BODY);
        }

        if (req.url.startsWith("/api/redirect-me")) {
            res.writeHead(302, {location: "http://169.254.169.254/latest/meta-data"});
            return res.end();
        }

        if (req.url.startsWith("/api/speedtests/status")) {
            res.writeHead(200, {"content-type": "application/json"});
            return res.end(JSON.stringify({paused: false, running: false}));
        }

        // Accepts and then says nothing, so a disconnecting caller is the only
        // thing that can end the exchange.
        if (req.url.startsWith("/api/hang")) {
            hangReceived += 1;
            res.on("close", () => { hangClosed += 1; });
            return;
        }

        res.writeHead(404, {"content-type": "application/json"});
        res.end(JSON.stringify({message: "Route not found"}));
    });

    node.listen(0, "127.0.0.1", () => resolve(node));
});

before(async () => {
    // The stand-in node listens on loopback, which the SSRF guard refuses by
    // default - a real node is never the machine MySpeed itself runs on. This is
    // the documented opt-out, and exercising it here keeps it honest.
    process.env.ALLOW_LOCAL_NODES = "true";

    server = await bootServer();
    upstream = await startUpstream();
    upstreamUrl = `http://127.0.0.1:${upstream.address().port}`;

    const {body} = await api(server.baseUrl, "/nodes", {
        method: "PUT",
        headers: {"content-type": "application/json"},
        body: JSON.stringify({name: "child", url: upstreamUrl, password: "childsecret"})
    });

    nodeId = body.id;
});

after(async () => {
    await new Promise((resolve) => upstream.close(resolve));
    await server?.close();
});

describe("node proxy", () => {
    it("registers the child node", () => {
        assert.ok(nodeId, "the node was not created");
    });

    it("passes a JSON response through unchanged", async () => {
        const {status, body} = await api(server.baseUrl, `/nodes/${nodeId}/speedtests/status`);

        assert.equal(status, 200);
        assert.deepEqual(body, {paused: false, running: false});
    });

    /**
     * Regression: proxyRequest unconditionally ran response.json() and answered
     * with res.json(), so any non-JSON body became the literal `null`. Every
     * client request goes through /api/nodes/<id>/* while a node is selected,
     * so exporting CSV from a node view downloaded a file containing "null".
     */
    it("passes a CSV response through without JSON-decoding it", async () => {
        const {status, text} = await api(server.baseUrl,
            `/nodes/${nodeId}/speedtests/export?from=2026-08-01&to=2026-08-07&format=csv`);

        assert.equal(status, 200);
        assert.equal(text, CSV_BODY);
        assert.notEqual(text, "null");
    });

    it("forwards the upstream content type", async () => {
        const {headers} = await api(server.baseUrl,
            `/nodes/${nodeId}/speedtests/export?from=2026-08-01&to=2026-08-07&format=csv`);

        assert.match(headers.get("content-type"), /text\/csv/);
    });

    it("forwards the download filename", async () => {
        const {headers} = await api(server.baseUrl,
            `/nodes/${nodeId}/speedtests/export?from=2026-08-01&to=2026-08-07&format=csv`);

        assert.match(headers.get("content-disposition"), /myspeed-export\.csv/);
    });

    it("replaces the caller's password with the stored node password", async () => {
        received = [];
        await api(server.baseUrl, `/nodes/${nodeId}/speedtests/status`, {
            headers: {"x-password": "the-callers-own-password"}
        });

        const proxied = received.at(-1);
        assert.equal(proxied.headers["x-password"], encodeURIComponent("childsecret"));
        assert.doesNotMatch(JSON.stringify(proxied.headers), /the-callers-own-password/);
    });

    /**
     * The caller's own credentials are the parent's, and the child has no use
     * for them: each instance keeps its own session map, so a forwarded cookie
     * can never authenticate anything there.
     *
     * Since sessions landed, `myspeed_session` *is* the browser credential -
     * the password middleware honours it before it ever reads the stored hash.
     * The password headers were stripped deliberately and the cookie was not,
     * so while a node was selected the dashboard shipped a fresh copy of a
     * seven-day full-access token to a third host every few seconds, usually
     * over plain http on the LAN. Basic auth reaches the prometheus route the
     * same way, so `authorization` goes with it.
     */
    it("never forwards the caller's own credentials to the node", async () => {
        received = [];
        await api(server.baseUrl, `/nodes/${nodeId}/speedtests/status`, {
            headers: {
                cookie: "myspeed_session=parents-own-session-token",
                authorization: "Basic cGFyZW50OnNlY3JldA=="
            }
        });

        const proxied = received.at(-1);
        assert.equal(proxied.headers["cookie"], undefined);
        assert.equal(proxied.headers["authorization"], undefined);
        assert.doesNotMatch(JSON.stringify(proxied.headers), /parents-own-session-token/);
    });

    it("preserves the upstream status code", async () => {
        const {status} = await api(server.baseUrl, `/nodes/${nodeId}/does-not-exist`);
        assert.equal(status, 404);
    });

    it("404s a request for a node that does not exist", async () => {
        assert.equal((await api(server.baseUrl, "/nodes/999999/speedtests/status")).status, 404);
    });

    /**
     * Regression: the abort wiring passed `req.signal` to the upstream request,
     * but an Express request carries no such property - the signal was always
     * undefined, and a caller that gave up left the proxy holding its upstream
     * request open until the 15s timeout.
     */
    it("drops the upstream request when the caller disconnects", async () => {
        const waitFor = async (condition, timeoutMs) => {
            const deadline = Date.now() + timeoutMs;
            while (!condition() && Date.now() < deadline)
                await new Promise((resolve) => setTimeout(resolve, 25));
            return condition();
        };

        const controller = new AbortController();
        const pending = fetch(`${server.baseUrl}/api/nodes/${nodeId}/hang`, {signal: controller.signal})
            .catch(() => null);

        assert.ok(await waitFor(() => hangReceived > 0, 2000), "the upstream never saw the request");
        assert.equal(hangClosed, 0, "the upstream request ended before the caller left");

        controller.abort();
        await pending;

        // Well under the proxy's own 15s timeout: this close has to come from
        // the disconnect, not from the deadline.
        assert.ok(await waitFor(() => hangClosed > 0, 2000),
            "the upstream request outlived the caller");
    });
});

/**
 * The address check runs on every proxied request, not once when the node was
 * added. Validating only at creation left every row written before the guard
 * existed - and every hostname since repointed - as a standing channel to
 * whatever the server can reach.
 */
describe("proxy revalidation", () => {
    it("refuses to proxy a stored node that now points somewhere blocked", async () => {
        const blocked = await nodeModelFor().create({name: "sneaky", url: "http://169.254.169.254", password: null});

        try {
            delete process.env.ALLOW_LOCAL_NODES;

            const {status, body} = await api(server.baseUrl, `/nodes/${blocked.id}/speedtests/status`);

            assert.equal(status, 400);
            assert.equal(body.type, "INVALID_URL");
        } finally {
            process.env.ALLOW_LOCAL_NODES = "true";
            await nodeModelFor().destroy({where: {id: blocked.id}});
        }
    });

    // A node has no reason to redirect, and following one handed the remote host
    // a way to choose the server's destination after the check had passed.
    it("refuses a node that answers with a redirect", async () => {
        const {status} = await api(server.baseUrl, `/nodes/${nodeId}/redirect-me`);
        assert.equal(status, 502);
    });
});

/**
 * What the node list actually hands back, which nothing asserted.
 *
 * The dashboard reads `id`, `name` and `url` off every entry, and the password
 * is meant to arrive as a boolean - the interface needs to know that one is set,
 * and the value is a credential for a third host.
 */
describe("GET /api/nodes", () => {
    it("names each node", async () => {
        const {status, body} = await api(server.baseUrl, "/nodes");

        assert.equal(status, 200);
        assert.ok(Array.isArray(body), "the list is not an array");

        const child = body.find((node) => node.id === nodeId);
        assert.notEqual(child, undefined, "the created node is not in the list under its own id");
        assert.equal(child.name, "child");
        assert.equal(child.url, upstreamUrl);
    });

    it("says whether a password is set without disclosing it", async () => {
        const {body, text} = await api(server.baseUrl, "/nodes");

        assert.equal(body.find((node) => node.id === nodeId)?.password, true);
        assert.equal(text.includes("childsecret"), false,
            "the node's stored password is handed to every caller of the list");
    });

    // Sequelize keeps its values in dataValues and its attribute getters on the
    // prototype, so spreading an instance copies the bookkeeping and none of the
    // columns.
    it("answers with the row rather than the model instance", async () => {
        const {body} = await api(server.baseUrl, "/nodes");

        for (const internal of ["dataValues", "_previousDataValues", "_options", "isNewRecord"])
            assert.equal(internal in body[0], false, `the list exposes Sequelize's ${internal}`);
    });
});
