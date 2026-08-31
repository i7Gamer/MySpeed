import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { PHASE_ORDER, iperf3Progress, overallProgress, parseProgressLine }
    from "../../server/util/providers/progress.js";
import { IPERF_DURATION_SECONDS, IPERF_MAX_DURATION_SECONDS }
    from "../../server/util/providers/registry.js";

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

/**
 * How far through an iperf3 transfer is, measured against the length this
 * particular run was asked for.
 *
 * iperf3 states no fraction of its own, so the bar divides the interval's clock
 * by the duration the arguments named. That denominator was a module constant
 * equal to the registry default: a target measuring for a minute filled its bar
 * in the first ten seconds and then sat at 100% for fifty, which reads as a run
 * that has hung - the one thing the bar exists to distinguish from a slow line.
 */
describe("an iperf3 transfer's own length", () => {
    const interval = (end) => ({event: "interval", data: {sum: {end, bits_per_second: 0}}});

    const HALF = 0.5;

    // Every caller that names no duration - which is every one of them until a
    // target tunes it - has to behave exactly as it did before the parameter
    // existed.
    it("is the registry default when the caller names none", () => {
        assert.equal(iperf3Progress(interval(IPERF_DURATION_SECONDS), "download").progress, 1);
        assert.equal(iperf3Progress(interval(IPERF_DURATION_SECONDS * HALF), "download").progress,
            HALF);
    });

    it("fills exactly at the end of the run, whatever length that is", () => {
        for (const duration of [IPERF_DURATION_SECONDS, 30, IPERF_MAX_DURATION_SECONDS])
            assert.equal(iperf3Progress(interval(duration), "download", duration).progress, 1,
                `a ${duration}s run did not fill its bar`);
    });

    /**
     * One elapsed reading, read against two runs. Ten seconds into a minute is
     * a sixth of the way through it and not the whole of it, which is the
     * entire bug.
     */
    it("reads one elapsed reading differently for two durations", () => {
        const short = iperf3Progress(interval(IPERF_DURATION_SECONDS), "download",
            IPERF_DURATION_SECONDS).progress;
        const long = iperf3Progress(interval(IPERF_DURATION_SECONDS), "download",
            IPERF_MAX_DURATION_SECONDS).progress;

        assert.equal(short, 1);
        assert.equal(long, IPERF_DURATION_SECONDS / IPERF_MAX_DURATION_SECONDS);
        assert.ok(long < short, "the longer run was reported as far along as the short one");
    });

    // The runner reads lines, not events, so the duration has to survive the
    // whole way through the reader or the bar divides by the default anyway.
    it("carries the duration through the line reader", () => {
        const line = JSON.stringify(interval(IPERF_DURATION_SECONDS));

        assert.equal(parseProgressLine("iperf3", line, "download").progress, 1);
        assert.equal(parseProgressLine("iperf3", line, "download", IPERF_MAX_DURATION_SECONDS)
            .progress, IPERF_DURATION_SECONDS / IPERF_MAX_DURATION_SECONDS);
    });

    // A duration handed to the ookla reader is not one of its arguments and
    // must not become one: its records state their own fraction.
    it("leaves the provider that states its own fraction alone", () => {
        assert.equal(parseProgressLine("ookla", DOWNLOAD, undefined, IPERF_MAX_DURATION_SECONDS)
            .progress, 0.25);
    });
});
