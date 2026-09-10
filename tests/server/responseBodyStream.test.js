import {it} from "node:test";
import assert from "node:assert/strict";
import {Readable, PassThrough} from "node:stream";
import {EventEmitter} from "node:events";
import {responseBodyStream} from "../../server/util/outboundHttp.js";

it("drains the original bytes without changing chunk order", async () => {
    const chunks = [Buffer.from("Grüezi "), Buffer.from("🌍")];
    const body = Readable.from(chunks);
    const received = [];
    await responseBodyStream(body).pipeTo(new WritableStream({write: value => received.push(value)}));
    assert.deepEqual(received, chunks);
    assert.equal(body.readableEnded, true);
});

it("propagates a body read failure to the Web reader", async () => {
    const body = new PassThrough();
    const reader = responseBodyStream(body).getReader();
    const fault = new Error("synthetic response failure");
    const pending = reader.read();
    body.destroy(fault);
    await assert.rejects(pending, error => error === fault);
});

for (const reason of [undefined, "cancel", new Error("synthetic cancellation")]) {
    it("cancels an outstanding body read and destroys its Node stream", async () => {
        const body = new PassThrough();
        const reader = responseBodyStream(body).getReader();
        const read = reader.read();
        await reader.cancel(reason);
        assert.equal(body.destroyed, true);
        assert.deepEqual(await read, {value: undefined, done: true});
    });
}

for (const completion of ["value", "done", "error"]) {
    it(`ignores a late ${completion} after cancellation closes the Web controller`, async () => {
        let complete;
        let fail;
        let destroyed = false;
        const next = new Promise((resolve, reject) => {complete = resolve; fail = reject;});
        const iterator = {next: () => next, return: async () => {throw new Error("late iterator cleanup");}};
        const body = Object.assign(new EventEmitter(), {
            [Symbol.asyncIterator]: () => iterator, destroy: () => {destroyed = true;}
        });
        const reader = responseBodyStream(body).getReader();
        const read = reader.read();
        await Promise.resolve();
        await reader.cancel();
        if (completion === "error") fail(new Error("late read failure"));
        else complete({value: Buffer.from("late bytes"), done: completion === "done"});
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(destroyed, true);
        assert.deepEqual(await read, {value: undefined, done: true});
    });
}
