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

const NODE_PASSWORD = "childsecret";

/**
 * A stand-in for a child MySpeed instance. It answers the handshake
 * checkStatus() performs and serves one JSON and one CSV endpoint, which is
 * enough to tell a faithful proxy from one that rewrites the body.
 */
const startUpstream = () => new Promise((resolve) => {
    const node = http.createServer((req, res) => {
        received.push({url: req.url, method: req.method, headers: req.headers});

        if (req.url.startsWith("/api/config")) {
            // A node with a password refuses a caller presenting the wrong one.
            // That is what makes "check the password before storing it"
            // meaningful - and what makes checking the sentinel for *clearing*
            // it wrong, since no node ever accepts "none" as a password.
            if (req.headers["x-password"] !== encodeURIComponent(NODE_PASSWORD)) {
                res.writeHead(401, {"content-type": "application/json"});
                return res.end(JSON.stringify({
                    message: "Please provide the correct password in the header",
                    type: "PASSWORD_REQUIRED"
                }));
            }

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

        // A revalidated read. Express answers a conditional request with a bare
        // 304 while the caller's validator still matches, which is what the
        // dashboard's polling produces as soon as a node's answer stops
        // changing - i.e. for the whole gap between two speedtests.
        if (req.url.startsWith("/api/cached")) {
            if (req.headers["if-none-match"]) {
                res.writeHead(304, {etag: 'W/"same"'});
                return res.end();
            }

            res.writeHead(200, {"content-type": "application/json", etag: 'W/"same"'});
            return res.end(JSON.stringify({fresh: true}));
        }

        // A node that has stopped being a MySpeed instance: compromised, or a
        // hostname that changed hands. It answers a document rather than an API.
        if (req.url.startsWith("/api/hostile")) {
            res.writeHead(200, {"content-type": "text/html"});
            return res.end("<script>fetch('/api/storage/config?includeSecrets=true')</script>");
        }

        if (req.url.startsWith("/api/speedtests/status")) {
            res.writeHead(200, {"content-type": "application/json"});
            return res.end(JSON.stringify({paused: false, running: false}));
        }

        // The shape a child answers with while it already has as many password
        // comparisons running for this caller as it will run at once.
        if (req.url.startsWith("/api/busy")) {
            res.writeHead(503, {"content-type": "application/json", "retry-after": "1"});
            return res.end(JSON.stringify({message: "The server is busy checking passwords. Please try again",
                type: "SERVER_BUSY"}));
        }

        // What a reverse proxy in front of a stopped container answers. Same
        // status, no MySpeed body - and that address will never start working.
        if (req.url.startsWith("/api/gateway-down")) {
            res.writeHead(503, {"content-type": "text/html"});
            return res.end("<html><body>503 Service Temporarily Unavailable</body></html>");
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
        body: JSON.stringify({name: "child", url: upstreamUrl, password: NODE_PASSWORD})
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

    /**
     * 304 sits in the 3xx range and is not a redirect: it carries no Location
     * and means "your copy is still good".
     *
     * The proxy classified it by range alone and answered 502 "The node
     * redirected the request". The browser gets an ETag on every proxied 200 -
     * Express generates one - and revalidates on the next poll, so a node whose
     * answer had stopped changing turned the node view into an error until the
     * next speedtest landed.
     */
    it("passes a revalidated 304 back rather than calling it a redirect", async () => {
        const {status} = await api(server.baseUrl, `/nodes/${nodeId}/cached`, {
            headers: {"if-none-match": 'W/"same"'}
        });

        assert.equal(status, 304);
    });

    it("still answers the unconditional read in full", async () => {
        const {status, body} = await api(server.baseUrl, `/nodes/${nodeId}/cached`);

        assert.equal(status, 200);
        assert.deepEqual(body, {fresh: true});
    });

    /**
     * A node is a machine an admin pointed at, not a trusted one, and the proxy
     * serves its answer from the *parent's* origin.
     *
     * Copying the node's content-type through let it choose that answer's type.
     * `text/html` renders as a document on the parent origin, and the CSP that
     * would otherwise stop it says `script-src 'self'` - which the node's own
     * scripts satisfy, because they are proxied through the parent too. From
     * there a script reads GET /api/storage/config?includeSecrets=true with the
     * operator's HttpOnly session riding along: the admin hash, every node
     * password in clear, every integration token. The whole point of stripping
     * the caller's credentials at this boundary is undone by handing the far end
     * the parent's origin instead.
     */
    it("does not let a node serve a document on the parent's origin", async () => {
        const {status, headers, text} = await api(server.baseUrl, `/nodes/${nodeId}/hostile`);

        assert.equal(status, 200, "the body is still delivered, just not as a document");
        assert.doesNotMatch(headers.get("content-type") ?? "", /text\/html/,
            "a hostile node chose the content type of a same-origin response");
        assert.match(text, /includeSecrets/, "the body itself must still pass through unchanged");
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
        assert.equal(proxied.headers["x-password"], encodeURIComponent(NODE_PASSWORD));
        assert.doesNotMatch(JSON.stringify(proxied.headers), /the-callers-own-password/);
    });

    /**
     * Clearing the parent's stored credential for a node is not a password
     * change and needs no proof the node still accepts one.
     *
     * The route checked "none" the way it checks a real password: it asked the
     * node to authenticate with the sentinel. No node ever accepts that, and
     * the node whose password has just been removed - which is the only reason
     * anyone sends this - answers 401 loudest of all. So the parent refused the
     * clear 400 and kept the stale credential, while the client, which never
     * looked at the response, toasted "Password removed" in green. Every poll
     * afterwards authenticated with a password the node no longer has.
     */
    it("clears a stored node password without asking the node to accept it", async () => {
        const {body: created} = await api(server.baseUrl, "/nodes", {
            method: "PUT",
            headers: {"content-type": "application/json"},
            body: JSON.stringify({name: "retiring", url: upstreamUrl, password: NODE_PASSWORD})
        });

        const {status} = await api(server.baseUrl, `/nodes/${created.id}/password`, {
            method: "PATCH",
            headers: {"content-type": "application/json"},
            body: JSON.stringify({password: "none"})
        });

        assert.equal(status, 200, "the parent refused to forget a password it no longer needs");

        const stored = await nodeModelFor().findOne({where: {id: created.id}});
        assert.equal(stored.password, null, "the stale credential is still stored");
    });

    // The other half: a password that is genuinely wrong is still refused, so
    // the check has not simply been dropped.
    it("still refuses a node password the node does not accept", async () => {
        const {status, body} = await api(server.baseUrl, `/nodes/${nodeId}/password`, {
            method: "PATCH",
            headers: {"content-type": "application/json"},
            body: JSON.stringify({password: "not-the-childs-password"})
        });

        assert.equal(status, 400);
        assert.equal(body.type, "PASSWORD_REQUIRED");
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

    /**
     * The parent cannot decompress, so it must not ask the child to compress.
     *
     * `accept-encoding` was passed straight through from the browser, while
     * safeRequest is raw node:http and never decodes a response and only
     * content-type and content-disposition are copied back. A child sitting
     * behind a reverse proxy with compression on - `encode gzip` in a Caddyfile
     * is a one-liner self-hosters add without thinking about it - would then
     * hand the parent gzip bytes, and the parent would hand the browser those
     * bytes labelled application/json with no Content-Encoding to explain them.
     */
    it("does not ask the node for a body it cannot decode", async () => {
        received = [];
        await api(server.baseUrl, `/nodes/${nodeId}/speedtests/status`, {
            headers: {"accept-encoding": "gzip, deflate, br, zstd"}
        });

        assert.equal(received.at(-1).headers["accept-encoding"], undefined,
            "the child was invited to compress a response the parent forwards verbatim");
    });

    /**
     * A child that is momentarily busy is not a child that has failed.
     *
     * Every proxied request re-authenticates on the child by header - the
     * parent holds no session there and cannot, since the proxy strips cookies
     * both ways - so a dashboard's own polling can fill the child's in-flight
     * comparison slots. Flattening the 503 into "Internal server error" threw
     * away the reason and the retry and reported a healthy node as broken.
     */
    describe("a node that is busy", () => {
        it("says so rather than reporting the node as broken", async () => {
            const {status, body} = await api(server.baseUrl, `/nodes/${nodeId}/busy`);

            assert.equal(status, 503);
            assert.equal(body.type, "SERVER_BUSY");
            assert.doesNotMatch(body.message, /internal server error/i);
        });

        // So a client knows this is worth retrying, and when.
        it("passes the retry hint through", async () => {
            const {headers} = await api(server.baseUrl, `/nodes/${nodeId}/busy`);

            assert.equal(headers.get("retry-after"), "1");
        });
    });

    /**
     * A gateway's 503 is not a busy MySpeed.
     *
     * A reverse proxy in front of a stopped container answers 503 too, and that
     * address will never start working - so reporting it as "busy, try again"
     * invites retries with no end. Ours names itself in the body; the proxy
     * forwards anything else as the server error it is.
     */
    it("does not call a gateway's 503 a busy node", async () => {
        const {status, body} = await api(server.baseUrl, `/nodes/${nodeId}/gateway-down`);

        assert.equal(status, 500);
        assert.notEqual(body.type, "SERVER_BUSY");
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
