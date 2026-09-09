import {outboundHttp} from "../../server/util/outboundHttp.js";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { getJson, postJson, postText } from "../../server/util/http.js";
import { OUTBOUND_TIMEOUT } from "../../server/util/integrationActivity.js";

const URL = "https://example.test/discarded-response";
const CHUNK_BYTES = 64 * 1024;
const LARGE_CHUNKS = 256;
const SMALL_JSON_LIMIT = 1024;
const TEST_DEADLINE_MS = 40;
const ASSERTION_TIMEOUT_MS = 2000;
const SUCCESS_STATUS = 200;
const ERROR_STATUS = 500;
const REPEATED_SENDS = 3;
const LOOPBACK_HOST = "127.0.0.1";
const EPHEMERAL_PORT = 0;

const bounded = async (promise) => {
    let timer;
    try {
        return await Promise.race([promise, new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error("background response read did not settle")),
                ASSERTION_TIMEOUT_MS);
        })]);
    } finally {
        clearTimeout(timer);
    }
};

// Both readers use the real stream. Observing their settlement independently
// matters: a helper returning its HTTP status does not mean drainage has ended.
const responseProbe = (response) => {
    const state = {aggregateReads: 0, streamReads: 0, settled: false};
    let complete;
    state.finished = new Promise((resolve) => { complete = resolve; });
    const observe = (promise) => {
        promise.then(() => {
            state.settled = true;
            complete({});
        }, (error) => {
            state.settled = true;
            complete({error});
        });
        return promise;
    };
    const arrayBuffer = response.arrayBuffer?.bind(response);
    response.arrayBuffer = () => {
        state.aggregateReads++;
        return observe(arrayBuffer());
    };
    const pipeTo = response.body.pipeTo.bind(response.body);
    response.body.pipeTo = (...args) => {
        state.streamReads++;
        return observe(pipeTo(...args));
    };
    return state;
};

const mockTransport = (t, implementation) => {
    t.mock.method(globalThis, "fetch", implementation);
    t.mock.method(outboundHttp, "send", implementation);
};

const HELPERS = [
    {name: "JSON POST", status: SUCCESS_STATUS, call: () => postJson(URL, {})},
    {name: "text POST refusal", status: ERROR_STATUS, call: () => postText(URL, "test")},
    {name: "GET refusal", status: ERROR_STATUS,
        call: () => getJson(URL, {maxBytes: SMALL_JSON_LIMIT})}
];

const outcomeOf = async (helper) => {
    if (helper.name === "GET refusal") {
        await assert.rejects(helper.call, /HTTP 500/);
    } else {
        assert.deepEqual(await helper.call(), {
            ok: helper.status === SUCCESS_STATUS, status: helper.status
        });
    }
};

describe("discarded HTTP response streams", () => {
    for (const helper of HELPERS) {
        for (const declared of [false, true]) {
            it(`${helper.name} streams a large ${declared ? "declared" : "chunked"} reply`, async (t) => {
                let sent = 0;
                let cancelled = false;
                const chunk = new Uint8Array(CHUNK_BYTES);
                const body = new ReadableStream({
                    pull(controller) {
                        if (sent === LARGE_CHUNKS) controller.close();
                        else {
                            sent++;
                            controller.enqueue(chunk);
                        }
                    },
                    cancel() { cancelled = true; }
                });
                const response = new Response(body, {
                    status: helper.status,
                    headers: declared ? {"content-length": String(CHUNK_BYTES * LARGE_CHUNKS)} : {}
                });
                const probe = responseProbe(response);
                mockTransport(t, async () => response);
                t.mock.method(console, "error", () => undefined);

                await outcomeOf(helper);
                assert.deepEqual(await bounded(probe.finished), {});
                assert.equal(sent, LARGE_CHUNKS, "the body was not fully consumed");
                assert.equal(cancelled, false, "a reusable response was cancelled");
                assert.equal(probe.aggregateReads, 0, "discarding collected the complete response in memory");
                assert.equal(probe.streamReads, 1);
            });
        }

        it(`${helper.name} returns before a stalled body, then drains until the deadline aborts`, async (t) => {
            const realTimeout = AbortSignal.timeout.bind(AbortSignal);
            let signal;
            let probe;
            let requestedTimeout;
            t.mock.method(AbortSignal, "timeout", (milliseconds) => {
                requestedTimeout = milliseconds;
                return realTimeout(TEST_DEADLINE_MS);
            });
            mockTransport(t, async (_url, init) => {
                signal = init.signal;
                const response = new Response(new ReadableStream({
                    start(controller) {
                        controller.enqueue(new Uint8Array(CHUNK_BYTES));
                        signal.addEventListener("abort", () => controller.error(signal.reason), {once: true});
                    }
                }), {status: helper.status});
                probe = responseProbe(response);
                return response;
            });
            t.mock.method(console, "error", () => undefined);

            await bounded(outcomeOf(helper));
            assert.equal(probe.settled, false, "the HTTP outcome waited for the stalled body");
            const completion = await bounded(probe.finished);
            assert.equal(requestedTimeout, OUTBOUND_TIMEOUT);
            assert.equal(signal.aborted, true);
            assert.equal(completion.error, signal.reason);
            assert.equal(probe.aggregateReads, 0);
            assert.equal(probe.streamReads, 1);
        });

        it(`${helper.name} catches a body read failure without changing its HTTP outcome`, async (t) => {
            const fault = new Error("connection reset during response");
            const response = new Response(new ReadableStream({
                pull(controller) { controller.error(fault); }
            }), {status: helper.status});
            const probe = responseProbe(response);
            mockTransport(t, async () => response);
            t.mock.method(console, "error", () => undefined);

            await outcomeOf(helper);
            assert.equal((await bounded(probe.finished)).error, fault);
            assert.equal(probe.aggregateReads, 0);
            assert.equal(probe.streamReads, 1);
        });
    }

    for (const body of [null, undefined]) {
        it(`tolerates a ${String(body)} body on POST and GET refusal`, async (t) => {
            mockTransport(t, async () => ({ok: false, status: ERROR_STATUS, body}));
            t.mock.method(console, "error", () => undefined);

            assert.deepEqual(await postJson(URL, {}), {ok: false, status: ERROR_STATUS});
            await assert.rejects(() => getJson(URL), /HTTP 500/);
        });
    }

    it("catches a synchronous stream-pipe failure", async (t) => {
        let attempted = false;
        mockTransport(t, async () => ({
            ok: true,
            status: SUCCESS_STATUS,
            body: {pipeTo() {
                attempted = true;
                throw new Error("response stream unavailable");
            }}
        }));

        assert.deepEqual(await postText(URL, "test"), {ok: true, status: SUCCESS_STATUS});
        assert.equal(attempted, true);
    });

    it("reuses HTTP connections after completely draining small chunked replies", async (t) => {
        const connections = new Set();
        const server = http.createServer((request, response) => {
            connections.add(request.socket);
            request.resume();
            response.writeHead(SUCCESS_STATUS, {"content-type": "text/plain"});
            response.write("accepted");
            setImmediate(() => response.end(" successfully"));
        });
        await new Promise((resolve, reject) => {
            server.once("error", reject);
            server.listen(EPHEMERAL_PORT, LOOPBACK_HOST, resolve);
        });
        t.after(async () => {
            server.closeAllConnections();
            await new Promise((resolve) => server.close(resolve));
        });
        const fetch = outboundHttp.send.bind(outboundHttp);
        let probe;
        mockTransport(t, async (...args) => {
            const response = await fetch(...args);
            probe = responseProbe(response);
            return response;
        });

        for (let send = 0; send < REPEATED_SENDS; send++) {
            assert.deepEqual(await postJson(`http://${LOOPBACK_HOST}:${server.address().port}/hook`, {}),
                {ok: true, status: SUCCESS_STATUS});
            assert.deepEqual(await bounded(probe.finished), {});
            assert.equal(probe.aggregateReads, 0);
            assert.equal(probe.streamReads, 1);
            await new Promise((resolve) => setImmediate(resolve));
        }
        assert.ok(connections.size < REPEATED_SENDS, "each notification discarded its reusable connection");
    });
});
