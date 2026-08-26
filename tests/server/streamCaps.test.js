import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { MAX_STREAM_HEAD, MAX_STREAM_TAIL, streamAccumulator } from "../../server/util/speedtest.js";
import { parseCliOutput } from "../../server/util/providers/cliOutput.js";

/**
 * What a run may keep of what its CLI printed.
 *
 * The streams were accumulated without bound for the run's whole three-minute
 * timeout, so a CLI wedged in a logging loop could grow the heap as fast as a
 * pipe can carry. The obvious head-only cap is the wrong one here, and that is
 * the fact these tests exist to hold: with --format=jsonl the Ookla CLI writes
 * its progress records first and the result record *last*, so a cap that stops
 * appending would drop the very line the whole run exists to produce - and a
 * healthy long test writes more progress than any sane head cap allows.
 */
describe("streamAccumulator", () => {
    it("hands text through untouched while it fits", () => {
        const stream = streamAccumulator({headLimit: 32, tailLimit: 8});

        stream.append("one ");
        stream.append("two");

        assert.equal(stream.value(), "one two");
        assert.equal(stream.truncated, false);
    });

    it("keeps both ends and drops the middle when it does not", () => {
        const stream = streamAccumulator({headLimit: 4, tailLimit: 6});

        stream.append("aaaa");
        stream.append("bbbb");
        stream.append("cccc");

        assert.equal(stream.truncated, true);
        assert.equal(stream.value(), "aaaa\nbbcccc");
    });

    it("splits an oversized first chunk across head and tail", () => {
        const stream = streamAccumulator({headLimit: 4, tailLimit: 8});

        stream.append("aaaabbbb");

        assert.equal(stream.value(), "aaaa\nbbbb");
    });

    // The junction always carries its own newline, so the head's torn last
    // line and the tail's torn first line cannot fuse into one line that
    // parses as something neither of them said.
    it("stays bounded under sustained output", () => {
        const stream = streamAccumulator({headLimit: 64, tailLimit: 32});

        for (let i = 0; i < 1000; i++) stream.append(`chunk ${i} `);

        assert.ok(stream.value().length <= 64 + 32 + 1, "the cap did not hold");
        assert.match(stream.value(), /chunk 0 /, "the beginning was lost");
        assert.match(stream.value(), /chunk 999 /, "the end was lost");
    });

    it("keeps the result record a long ookla run prints last", () => {
        const stream = streamAccumulator({headLimit: 500, tailLimit: 400});

        const progress = (i) => JSON.stringify({
            type: "download", timestamp: "2026-08-08T19:34:05Z",
            download: {bandwidth: 67151451, bytes: 511224 * i, elapsed: 7 * i, progress: i / 40}
        });
        const result = JSON.stringify({
            type: "result",
            ping: {jitter: 0.32, latency: 24.079},
            download: {bandwidth: 291995750, bytes: 1135809960, elapsed: 10211},
            upload: {bandwidth: 287879258, bytes: 917831105, elapsed: 9814},
            result: {id: "c63aac06-94e8-44f7-9163-49ac377f74f4"}
        });

        for (let i = 0; i < 40; i++) stream.append(progress(i) + "\n");
        stream.append(result + "\n");

        assert.equal(stream.truncated, true, "the fixture no longer overflows the limits it is testing");

        const parsed = parseCliOutput("ookla", stream.value(), "");

        assert.equal(parsed.type, "result", "the cap dropped the result record");
        assert.equal(parsed.download.bandwidth, 291995750);
    });

    /**
     * The defaults, held to what the joint above relies on: the tail has to
     * hold a whole result record with room to spare for the torn line beside
     * it, and the head has to keep the opening of a failure - the part of
     * stderr where the reason lives.
     */
    it("defaults to limits that keep a result and a reason", () => {
        assert.ok(MAX_STREAM_TAIL >= 64 * 1024);
        assert.ok(MAX_STREAM_HEAD >= 256 * 1024);
    });
});
