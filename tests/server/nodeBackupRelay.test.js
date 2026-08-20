import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { EventEmitter } from "node:events";
import { safeRequest, MAX_RESPONSE_BYTES, RESPONSE_TOO_LARGE } from "../../server/util/safeRequest.js";
import { isBackupExportPath, IMPORT_BODY_LIMIT_BYTES } from "../../server/routes/storage.js";
import { proxyRequest } from "../../server/controller/node.js";

/**
 * A node's backup has to fit through the proxy that is the only way to ask
 * for it.
 *
 * safeRequest holds every proxied answer to a ten megabyte ceiling - the right
 * default against a node that is compromised or simply something else by now.
 * But the history export of a node with a year of tests is legitimately bigger
 * than that, and the ceiling ended it as a bare `catch` answering "Internal
 * server error": the one endpoint whose size grows with faithful use was the
 * one the relay refused, and nothing said why.
 *
 * The allowance is the import limit, because the two are one round trip: an
 * export too big to ever restore is not a backup, so nothing larger needs to
 * be relayed - it needs the honest refusal below instead.
 */
const MB = 1024 * 1024;

/** Above the default ceiling, within the backup allowance. */
const RELAY_BYTES = MAX_RESPONSE_BYTES + MB;

/** One chunk past even the backup allowance. */
const OVER_BYTES = IMPORT_BODY_LIMIT_BYTES + MB;

const WRITE_CHUNK = MB;

/** A relay this size is seconds on loopback; reaching this means it hung. */
const CASE_TIMEOUT = 30000;

const NODE_ID = "1";

let server;
let nodeUrl;

const flood = (res, total) => {
    res.writeHead(200, {"content-type": "application/json"});
    for (let sent = 0; sent < total; sent += WRITE_CHUNK) res.write("x".repeat(WRITE_CHUNK));
    res.end();
};

before(async () => {
    server = http.createServer((req, res) => {
        // The oversized answers are destroyed mid-write by the ceiling under
        // test, which surfaces here as a socket error nobody needs to hear.
        res.on("error", () => {});

        if (req.url === "/api/storage/tests/history/json") return flood(res, RELAY_BYTES);
        if (req.url === "/api/storage/config") return flood(res, OVER_BYTES);
        if (req.url === "/api/config") return flood(res, RELAY_BYTES);

        res.writeHead(200, {"content-type": "application/json"});
        res.end("{}");
    });

    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    nodeUrl = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
    server.closeAllConnections();
    return new Promise((resolve) => server.close(resolve));
});

beforeEach(() => {
    process.env.ALLOW_LOCAL_NODES = "true";
});

afterEach(() => {
    delete process.env.ALLOW_LOCAL_NODES;
});

/** A response that records what the proxy answered with. */
const capturingResponse = () => {
    const res = new EventEmitter();
    const answered = {status: null, body: null, json: null, headers: {}};

    res.writableEnded = false;
    res.setHeader = (name, value) => { answered.headers[name] = value; };
    res.status = (code) => { answered.status = code; return res; };
    res.send = (body) => { answered.body = body; res.writableEnded = true; };
    res.json = (payload) => { answered.json = payload; res.writableEnded = true; };

    return {res, answered};
};

/**
 * Asks the way routes/nodes.js does: the caller's request names the parent
 * path /api/nodes/<id>/..., and the child URL is that path with the node
 * prefix folded back to /api.
 */
const proxied = async (childRoute) => {
    const originalUrl = `/api/nodes/${NODE_ID}${childRoute.slice("/api".length)}`;
    const {res, answered} = capturingResponse();
    await proxyRequest(`${nodeUrl}${childRoute}`, {method: "GET", headers: {}, body: undefined, originalUrl}, res);
    return answered;
};

describe("the paths the backup allowance is for", () => {
    for (const route of ["/api/storage/tests/history/json", "/api/storage/tests/history/csv", "/api/storage/config"]) {
        it(`covers ${route}`, () => {
            assert.equal(isBackupExportPath(route), true);
        });

        it(`covers ${route} through the node prefix`, () => {
            assert.equal(isBackupExportPath(`/api/nodes/7${route.slice("/api".length)}`), true);
        });
    }

    it("does not cover the ordinary API", () => {
        assert.equal(isBackupExportPath("/api/config"), false);
        assert.equal(isBackupExportPath("/api/nodes/7/config"), false);
        assert.equal(isBackupExportPath("/api/storage/tests/history"), false);
    });

    it("is not fooled by a query string or a trailing slash", () => {
        assert.equal(isBackupExportPath("/api/storage/tests/history/csv/"), true);
        assert.equal(isBackupExportPath("/api/storage/tests/history/csv?x=1"), true);
    });
});

describe("the backup allowance itself", () => {
    it("is the import limit, which is what makes an export restorable", () => {
        assert.equal(IMPORT_BODY_LIMIT_BYTES, 50 * MB);
    });

    it("actually raises the default ceiling rather than restating it", () => {
        assert.ok(IMPORT_BODY_LIMIT_BYTES > MAX_RESPONSE_BYTES);
    });
});

describe("a history export bigger than the default ceiling", () => {
    it("is relayed whole", {timeout: CASE_TIMEOUT}, async () => {
        const answered = await proxied("/api/storage/tests/history/json");

        assert.equal(answered.status, 200, `the export was refused: ${JSON.stringify(answered.json)}`);
        assert.equal(answered.body.length, RELAY_BYTES, "the export arrived truncated");
    });
});

describe("an answer too large even for a backup", () => {
    it("is refused as what it is, not as a bare server error", {timeout: CASE_TIMEOUT}, async () => {
        const answered = await proxied("/api/storage/config");

        assert.equal(answered.status, 502);
        assert.match(answered.json?.message ?? "", /too large/i,
            "the refusal does not say what was refused");
    });
});

describe("an ordinary route that floods", () => {
    it("keeps the default ceiling and says why it refused", {timeout: CASE_TIMEOUT}, async () => {
        const answered = await proxied("/api/config");

        assert.equal(answered.status, 502, "a flood on a non-backup path was relayed or mislabelled");
        assert.match(answered.json?.message ?? "", /too large/i);
    });
});

describe("the ceiling's rejection", () => {
    it("carries a code a caller can branch on", async () => {
        await assert.rejects(() => safeRequest(`${nodeUrl}/api/config`, {maxBytes: MB}),
            (error) => error.code === RESPONSE_TOO_LARGE,
            "the too-large failure is indistinguishable from any other");
    });
});
