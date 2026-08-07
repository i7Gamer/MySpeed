import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { bootServer, api } from "./helpers/boot.js";

let server;
let upstream;
let upstreamUrl;
let nodeId;

/** Requests the fake node received, so the proxy's header handling is observable. */
let received = [];

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

        if (req.url.startsWith("/api/speedtests/status")) {
            res.writeHead(200, {"content-type": "application/json"});
            return res.end(JSON.stringify({paused: false, running: false}));
        }

        res.writeHead(404, {"content-type": "application/json"});
        res.end(JSON.stringify({message: "Route not found"}));
    });

    node.listen(0, "127.0.0.1", () => resolve(node));
});

before(async () => {
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

    it("preserves the upstream status code", async () => {
        const {status} = await api(server.baseUrl, `/nodes/${nodeId}/does-not-exist`);
        assert.equal(status, 404);
    });

    it("404s a request for a node that does not exist", async () => {
        assert.equal((await api(server.baseUrl, "/nodes/999999/speedtests/status")).status, 404);
    });
});
