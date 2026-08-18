import { describe, it, beforeEach, mock } from "node:test";
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
            click() { blobEvents.push({event: "click", url: this.href}); },
            remove() {}
        };
        return lastAnchor;
    },
    body: {appendChild: () => {}}
};

// The order matters as much as the calls: a blob url revoked in the same tick
// as the click is gone before the download manager has read it.
let blobEvents = [];

globalThis.window = {
    URL: {
        createObjectURL: () => "blob:stub",
        revokeObjectURL: (url) => blobEvents.push({event: "revoke", url})
    }
};

const { jsonRequest, downloadRequest, RequestError, filenameFromDisposition, migrateStoredPassword } =
    await import("../../client/src/common/utils/RequestUtil.js");

beforeEach(() => {
    store.clear();
    lastRequest = null;
    blobEvents = [];
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

/**
 * Regression: only baseRequest carried a timeout. request() - behind
 * jsonRequest and with it the whole dashboard - had none, so a connection
 * that stalled (or a proxied node that accepted and went quiet) hung the
 * fetch forever and left the page on its skeleton with nothing said.
 */
describe("request timeout", () => {
    // The documented REQUEST_TIMEOUT in RequestUtil.js.
    const REQUEST_TIMEOUT_MS = 10000;

    it("aborts a request that never answers", async () => {
        mock.timers.enable({apis: ["setTimeout"]});
        const originalFetch = globalThis.fetch;

        let signal;
        globalThis.fetch = (url, options) => new Promise(() => { signal = options.signal; });

        try {
            jsonRequest("/speedtests").catch(() => {});

            assert.ok(signal instanceof AbortSignal, "the request carries no abort signal");
            assert.equal(signal.aborted, false);

            mock.timers.tick(REQUEST_TIMEOUT_MS);

            assert.equal(signal.aborted, true, "the stalled request was never aborted");
        } finally {
            globalThis.fetch = originalFetch;
            mock.timers.reset();
        }
    });

    it("does not abort a request that answered in time", async () => {
        respondWith({body: {}});

        await jsonRequest("/speedtests");

        assert.equal(lastRequest.options.signal.aborted, false);
    });
});

/**
 * The boot migration is awaited at the top level of index.jsx, so whether it
 * settles decides whether React mounts at all.
 *
 * A `.catch()` was put on it for the rejecting case. That covers a refusal and
 * a dropped connection and misses the one this has to survive: a request that
 * is accepted and then never answered - a reverse proxy holding the call while
 * the backend restarts, which is exactly when an upgrading user reloads. A
 * fetch that never settles is neither fulfilled nor rejected, so no catch can
 * run, the top-level await never returns, and root.render below it never
 * executes. The page is blank, which is the symptom the catch was added to
 * remove.
 *
 * login() was the only fetch in the file with no abort signal on it.
 */
describe("the boot password migration", () => {
    const REQUEST_TIMEOUT_MS = 10000;

    it("settles when the sign-in is accepted and never answered", async () => {
        mock.timers.enable({apis: ["setTimeout"]});
        const originalFetch = globalThis.fetch;
        store.set("password", "hunter2");

        try {
            let signal = null;

            globalThis.fetch = (url, options) => new Promise((resolve, reject) => {
                signal = options?.signal ?? null;
                signal?.addEventListener("abort",
                    () => reject(new Error("The operation was aborted")));
            });

            const settled = migrateStoredPassword().then(() => "resolved", () => "rejected");

            assert.ok(signal instanceof AbortSignal,
                "the sign-in carries no abort signal, so a stalled boot never mounts the app");

            mock.timers.tick(REQUEST_TIMEOUT_MS);

            assert.equal(await settled, "rejected",
                "the migration never settled, so the top-level await below it never returns");
            assert.equal(store.get("password"), undefined,
                "the stored password survived, so every later load repeats the same stall");
        } finally {
            globalThis.fetch = originalFetch;
            mock.timers.reset();
        }
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

    /**
     * A blob url has to outlive the click that uses it.
     *
     * revokeObjectURL was called on the line after element.click(), in the same
     * tick - but the click only *starts* the download, and the browser reads
     * the blob afterwards. Revoking it first drops the only reference to the
     * data, so the download manager finds nothing behind the url it was handed
     * and the entry lands as "Failed - Network error". Chrome usually survives
     * it by reading the blob synchronously; Firefox and Safari do not, so
     * every export was broken there and worked here.
     */
    describe("the blob url behind the download", () => {
        it("is still alive when the click happens", async () => {
            respondWith({});
            await downloadRequest("/storage/config");

            const clicked = blobEvents.findIndex((entry) => entry.event === "click");
            const revoked = blobEvents.findIndex((entry) => entry.event === "revoke");

            assert.notEqual(clicked, -1, "the download was never triggered");
            assert.ok(revoked === -1 || revoked > clicked,
                "the url was revoked before the browser could read the blob");
        });

        it("is not revoked in the same tick as the click", async () => {
            respondWith({});
            await downloadRequest("/storage/config");

            assert.equal(blobEvents.some((entry) => entry.event === "revoke"), false,
                "the revoke is still synchronous, so the download races it");
        });

        it("is revoked eventually rather than leaked", async () => {
            respondWith({});
            await downloadRequest("/storage/config");

            await new Promise((resolve) => setTimeout(resolve, 1200));

            assert.equal(blobEvents.some((entry) => entry.event === "revoke"), true,
                "the blob is never released, so every export leaks it for the session");
        });
    });
});
