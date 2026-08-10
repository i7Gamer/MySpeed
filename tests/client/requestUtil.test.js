import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

// RequestUtil targets the browser; stub the globals it reaches for before the
// module graph is loaded so the request logic can be exercised under Node.
const store = new Map();

globalThis.localStorage = {
    getItem: (key) => store.has(key) ? store.get(key) : null,
    setItem: (key, value) => store.set(key, String(value)),
    removeItem: (key) => store.delete(key)
};

let lastRequest = null;
let nextResponse = null;

globalThis.fetch = async (url, options) => {
    lastRequest = {url, options};
    return nextResponse;
};

const respondWith = ({status = 200, body = {}, headers = {}} = {}) => {
    nextResponse = {
        ok: status >= 200 && status < 300,
        status,
        json: async () => {
            if (body === undefined) throw new SyntaxError("Unexpected end of JSON input");
            return body;
        },
        blob: async () => ({size: 0}),
        headers: {get: (name) => headers[name] ?? null}
    };
};

// downloadRequest hands the finished blob to an anchor, so it needs just
// enough DOM to get there. The element it builds is kept so the name it chose
// can be asserted.
let lastAnchor = null;

globalThis.document = {
    createElement: () => {
        lastAnchor = {
            attributes: {},
            setAttribute(name, value) { this.attributes[name] = value; },
            click() {},
            remove() {}
        };
        return lastAnchor;
    },
    body: {appendChild: () => {}}
};

globalThis.window = {
    URL: {createObjectURL: () => "blob:stub", revokeObjectURL: () => {}}
};

const { jsonRequest, downloadRequest, RequestError, filenameFromDisposition } =
    await import("../../client/src/common/utils/RequestUtil.js");

beforeEach(() => {
    store.clear();
    lastRequest = null;
});

describe("jsonRequest", () => {
    it("returns the parsed body on success", async () => {
        respondWith({body: [{id: 1}]});
        assert.deepEqual(await jsonRequest("/speedtests"), [{id: 1}]);
    });

    // Regression: fetch only rejects on network failure, so an error body used
    // to flow into components as if it were data - a 401 rendered as an empty
    // dashboard rather than surfacing the failure.
    it("throws instead of returning the error body on 401", async () => {
        respondWith({status: 401, body: {message: "Please provide the correct password in the header"}});
        await assert.rejects(() => jsonRequest("/speedtests"), (error) => {
            assert.ok(error instanceof RequestError);
            assert.equal(error.status, 401);
            assert.match(error.message, /correct password/);
            return true;
        });
    });

    it("throws on a 500 with an unparseable body", async () => {
        respondWith({status: 500, body: undefined});
        await assert.rejects(() => jsonRequest("/speedtests"), (error) => {
            assert.equal(error.status, 500);
            return true;
        });
    });

    /**
     * The password used to be kept in localStorage and attached to every
     * request. It is exchanged for an HttpOnly session cookie now, which the
     * browser sends on its own and no script here can read - so nothing may
     * attach a credential, and nothing may read one back out of storage.
     */
    it("never attaches a password header", async () => {
        store.set("password", "hunter2");
        respondWith({body: {}});

        await jsonRequest("/speedtests");

        assert.equal(lastRequest.options.headers["x-password"], undefined);
        assert.doesNotMatch(JSON.stringify(lastRequest.options.headers), /hunter2/);
    });

    it("targets the selected node when one is active", async () => {
        store.set("currentNode", "3");
        respondWith({body: {}});
        await jsonRequest("/speedtests");
        assert.equal(lastRequest.url, "/api/nodes/3/speedtests");
    });

    it("targets the local api when no node is selected", async () => {
        store.set("currentNode", "0");
        respondWith({body: {}});
        await jsonRequest("/speedtests");
        assert.equal(lastRequest.url, "/api/speedtests");
    });
});

describe("filenameFromDisposition", () => {
    it("reads a quoted filename", () => {
        assert.equal(filenameFromDisposition('attachment; filename="myspeed-export.csv"'), "myspeed-export.csv");
    });

    it("reads an unquoted filename", () => {
        assert.equal(filenameFromDisposition("attachment; filename=export.json"), "export.json");
    });

    // Regression: this used to be `.split('filename=')[1]` on a possibly absent
    // header, which threw a bare TypeError on every error response.
    it("returns null when the header is missing", () => {
        assert.equal(filenameFromDisposition(null), null);
    });

    it("returns null when the header carries no filename", () => {
        assert.equal(filenameFromDisposition("attachment"), null);
    });

    it("strips a path from a malicious filename", () => {
        assert.equal(filenameFromDisposition('attachment; filename="../../etc/passwd"'), "passwd");
    });
});

describe("downloadRequest", () => {
    it("throws a RequestError rather than a TypeError on an error response", async () => {
        respondWith({status: 401, body: {message: "nope"}});
        await assert.rejects(() => downloadRequest("/storage/config"), (error) => {
            assert.ok(error instanceof RequestError, `expected RequestError, got ${error.name}`);
            assert.equal(error.status, 401);
            return true;
        });
    });

    /**
     * The caller names the file when it cares, and the server names it
     * otherwise. It used to be the other way round, which left the export of
     * "all time" carrying the server's echo of the very wide window that
     * stands in for it - a name the client is the only one able to improve on,
     * since only it knows the range was a stand-in.
     */
    describe("naming the file", () => {
        it("uses the name the caller asked for", async () => {
            respondWith({headers: {"Content-Disposition": 'attachment; filename="from-the-server.csv"'}});
            await downloadRequest("/speedtests/export", {}, {}, "myspeed-export-all-time.csv");

            assert.equal(lastAnchor.attributes.download, "myspeed-export-all-time.csv");
        });

        it("falls back to the server's name when the caller does not care", async () => {
            respondWith({headers: {"Content-Disposition": 'attachment; filename="speedtests.json"'}});
            await downloadRequest("/storage/tests/history/json");

            assert.equal(lastAnchor.attributes.download, "speedtests.json");
        });

        it("still has a name when neither says anything", async () => {
            respondWith({});
            await downloadRequest("/storage/config");

            assert.ok(lastAnchor.attributes.download, "the download was left unnamed");
        });
    });
});
