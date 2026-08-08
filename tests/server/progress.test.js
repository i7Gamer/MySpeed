import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { PHASE_ORDER, overallProgress, parseProgressLine } from "../../server/util/providers/progress.js";

// Verbatim lines from a real `speedtest --format=jsonl` run.
const TEST_START = '{"type":"testStart","timestamp":"2026-08-08T19:34:05Z","isp":"Salt Mobile"}';
const PING = '{"type":"ping","timestamp":"2026-08-08T19:34:05Z","ping":{"jitter":0.256,"latency":3.8,"progress":0.4}}';
const DOWNLOAD = '{"type":"download","timestamp":"2026-08-08T19:34:05Z","download":{"bandwidth":67151451,"bytes":511224,"elapsed":7,"progress":0.25}}';
const UPLOAD = '{"type":"upload","timestamp":"2026-08-08T19:34:09Z","upload":{"bandwidth":35001187,"bytes":560019,"elapsed":16,"progress":0.5}}';
const RESULT = '{"type":"result","timestamp":"2026-08-08T19:34:20Z","ping":{"latency":3.8}}';

describe("parseProgressLine", () => {
    it("reports which phase the run is in and how far through it is", () => {
        assert.deepEqual(parseProgressLine("ookla", PING), {phase: "ping", progress: 0.4, speed: null});
    });

    it("carries the live speed of a transfer phase", () => {
        const download = parseProgressLine("ookla", DOWNLOAD);

        assert.equal(download.phase, "download");
        assert.equal(download.progress, 0.25);
        // Bytes per second as the CLI reports it, in Mbit/s as the interface
        // everywhere else speaks.
        assert.equal(download.speed, 537.21);
    });

    it("distinguishes the upload phase from the download", () => {
        const upload = parseProgressLine("ookla", UPLOAD);

        assert.equal(upload.phase, "upload");
        assert.equal(upload.speed, 280.01);
    });

    it("treats the opening record as the run having started", () => {
        assert.deepEqual(parseProgressLine("ookla", TEST_START), {phase: "start", progress: 0, speed: null});
    });

    // The result is the outcome, not progress. Reporting it here would race the
    // stored row: the bar would say finished before anything was written.
    it("says nothing about the result line", () => {
        assert.equal(parseProgressLine("ookla", RESULT), null);
    });

    describe("input it cannot use", () => {
        it("ignores a line that is not JSON", () => {
            assert.equal(parseProgressLine("ookla", "Speedtest by Ookla"), null);
        });

        it("ignores a truncated line rather than throwing", () => {
            assert.equal(parseProgressLine("ookla", '{"type":"download","download":{"progr'), null);
        });

        it("ignores an unknown record type", () => {
            assert.equal(parseProgressLine("ookla", '{"type":"log","message":"Cannot open socket"}'), null);
        });

        // Neither of the other CLIs streams progress, so nothing may be invented
        // for them - a bar that moves on its own is worse than no bar.
        it("reports nothing for the providers that do not stream", () => {
            for (const mode of ["libre", "cloudflare"])
                assert.equal(parseProgressLine(mode, DOWNLOAD), null, `invented progress for ${mode}`);
        });

        it("clamps a progress value outside its range", () => {
            const over = parseProgressLine("ookla", '{"type":"ping","ping":{"progress":1.4}}');
            const under = parseProgressLine("ookla", '{"type":"ping","ping":{"progress":-0.2}}');

            assert.equal(over.progress, 1);
            assert.equal(under.progress, 0);
        });

        it("treats a missing progress as none rather than as NaN", () => {
            assert.equal(parseProgressLine("ookla", '{"type":"download","download":{"bandwidth":100}}').progress, 0);
        });

        it("has no speed to report when the CLI omits the bandwidth", () => {
            assert.equal(parseProgressLine("ookla", '{"type":"download","download":{"progress":0.5}}').speed, null);
        });
    });
});

describe("overallProgress", () => {
    it("is nothing at the start and everything at the end of the last phase", () => {
        assert.equal(overallProgress("start", 0), 0);
        assert.equal(overallProgress("upload", 1), 1);
    });

    it("never goes backwards as a run moves through its phases", () => {
        const run = [
            ["start", 0], ["ping", 0.5], ["ping", 1],
            ["download", 0], ["download", 0.5], ["download", 1],
            ["upload", 0], ["upload", 0.5], ["upload", 1]
        ].map(([phase, progress]) => overallProgress(phase, progress));

        for (let i = 1; i < run.length; i++)
            assert.ok(run[i] >= run[i - 1], `progress fell from ${run[i - 1]} to ${run[i]}`);
    });

    it("counts the phases already finished, not just the current one", () => {
        // Half way through the upload, both earlier phases are behind it.
        assert.ok(overallProgress("upload", 0) > overallProgress("download", 0.9));
    });

    it("is bounded even if asked about something unknown", () => {
        assert.equal(overallProgress("nonsense", 0.5), 0);
    });

    it("orders the phases the way a run runs them", () => {
        assert.deepEqual(PHASE_ORDER, ["ping", "download", "upload"]);
    });
});
