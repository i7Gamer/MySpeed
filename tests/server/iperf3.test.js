import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readSource } from "../helpers/source.js";
import { EventEmitter } from "node:events";
import { parseIperf3 } from "../../server/util/providers/parseData.js";
import { parseCliOutput } from "../../server/util/providers/cliOutput.js";
import { iperf3Progress } from "../../server/util/providers/progress.js";
import { measureLatency, median, sampleHandshake, spread } from "../../server/util/providers/iperfLatency.js";
import { IPERF_DEFAULT_PORT, REGISTRY, splitEndpoint } from "../../server/util/providers/registry.js";
import { iperfEndpointProblem, targetProblem } from "../../server/controller/targets.js";
import { selectBinary } from "../../server/util/providers/loadIperf3.js";
import { iperfList } from "../../server/config/binaries.js";

/**
 * iperf3, which differs from the three providers before it in every way the
 * abstractions had assumed away: it measures one direction per invocation,
 * reports no latency at all, is published as a bare executable rather than an
 * archive, and says both its results and its failures as line-delimited events
 * rather than as one object with an `error` member.
 *
 * The fixtures here are real output, captured from iperf3 3.21 run against a
 * local server - not written from the schema, which is how the first version
 * of the parser came to read `connecting_to` off an event that does not carry
 * it.
 */

// One end event, as --json-stream writes it. Trimmed to the members the parser
// reads; the shape and the nesting under `data` are the CLI's own.
const endEvent = ({received, sent, bytes = 1000000, seconds = 10}) => ({
    event: "end",
    data: {
        sum_sent: {bytes, seconds, bits_per_second: sent},
        sum_received: {bytes, seconds, bits_per_second: received}
    }
});

const bothWays = (overrides = {}) => ({
    runs: {
        download: endEvent({received: 94000000, sent: 95000000}),
        upload: endEvent({received: 47000000, sent: 48000000})
    },
    latency: {ping: 3.4, jitter: 0.8},
    endpoint: {host: "10.0.0.5", port: 5201},
    ...overrides
});

describe("parsing an iperf3 test", () => {
    it("reads each direction from its own run", () => {
        const row = parseIperf3(bothWays());

        // Mbit/s, the same unit and rounding every other provider stores:
        // 94000000 bits per second is 94 Mbit/s, not the 752 that reading
        // iperf3's bits as Ookla's bytes produced.
        assert.equal(row.download, 94);
        assert.equal(row.upload, 47);
    });

    /**
     * The receiver's total, not the sender's. The sender counts what it handed
     * to the kernel, retransmissions included; the receiver counts what
     * arrived, and on a lossy path they differ by exactly the loss. A speed
     * history is about what arrived.
     */
    it("takes what arrived rather than what was sent", () => {
        const row = parseIperf3(bothWays());

        assert.equal(row.download, 94, "the sender's inflated figure was stored");
    });

    it("falls back to the sender's figure when a run reports no receiver total", () => {
        const cut = bothWays();
        delete cut.runs.download.data.sum_received;

        assert.equal(parseIperf3(cut).download, 95);
    });

    it("takes the latency the runner measured, since iperf3 measures none", () => {
        const row = parseIperf3(bothWays());

        assert.equal(row.ping, 3.4);
        assert.equal(row.jitter, 0.8);
    });

    /**
     * A transfer that succeeded is a result even when every handshake failed.
     * Zero already means "nobody measured this" for the ping column -
     * testOutcome owns that convention - and refusing the row would throw away
     * a throughput measurement that is perfectly good.
     */
    it("still records a run whose latency could not be measured", () => {
        const row = parseIperf3(bothWays({latency: {ping: null, jitter: null}}));

        assert.equal(row.ping, 0);
        assert.equal(row.jitter, null);
        assert.equal(row.download, 94, "a run that measured the line was thrown away over its ping");
    });

    /**
     * The address dialled, which is not in the end event: under --json-stream
     * `connecting_to` belongs to the start event, so a parser handed the end
     * event alone can only get this from the runner. Reading it off the output
     * is what the first version did, and every row named no server at all.
     */
    it("names the address it dialled", () => {
        assert.equal(parseIperf3(bothWays()).serverHost, "10.0.0.5:5201");
    });

    // The target's own name would say it twice: the detail pane draws that in
    // its Target fact, and falls back to the host here when there is no name.
    it("leaves the server unnamed, so the pane shows the address", () => {
        assert.equal(parseIperf3(bothWays()).serverName, null);
    });

    /**
     * A throughput tool measures throughput. Every quality figure is null
     * rather than zero, because a zero claims a flawless line where null says
     * nobody looked - the distinction the whole provider column exists for.
     */
    it("reports no quality figures rather than flawless ones", () => {
        const row = parseIperf3(bothWays());

        assert.equal(row.packetLoss, null);
        assert.equal(row.downloadLatency, null);
        assert.equal(row.uploadLatency, null);
        assert.equal(row.isp, null);
        assert.equal(row.externalIp, null);
        assert.equal(row.resultId, null);
    });

    it("counts the bytes each direction moved", () => {
        const row = parseIperf3(bothWays());

        assert.equal(row.bytesDownloaded, 1000000);
        assert.equal(row.bytesUploaded, 1000000);
    });

    it("adds up the time the two transfers took", () => {
        assert.equal(parseIperf3(bothWays()).time, 20);
    });

    /**
     * Half a result has nowhere honest to be stored: both throughput columns
     * are NOT NULL and neither has a sentinel for "unmeasured", so a run that
     * lost one direction is a failure - the same judgement parseCloudflare
     * makes for the same reason.
     */
    it("refuses a test that measured only one direction", () => {
        const half = bothWays();
        half.runs.upload = {event: "end", data: {}};

        const row = parseIperf3(half);

        assert.equal(row.download, -1);
        assert.equal(row.upload, -1);
        assert.equal(row.ping, -1);
    });

    it("survives output with no runs at all", () => {
        assert.equal(parseIperf3({}).download, -1);
        assert.equal(parseIperf3(undefined).download, -1);
    });
});

/**
 * How a failure reaches the row. iperf3 says it as an event whose `data` is
 * the message, and then writes an *empty* end event - so the shared parser had
 * to be taught both halves, or the failure vanished and that empty event was
 * taken for the result.
 */
describe("an iperf3 run that could not connect", () => {
    // Captured from iperf3 3.21 against a port with nothing listening.
    const REFUSED = '{"event":"error","data":"unable to connect to server - server may have stopped '
        + 'running or use a different port, firewall issue, etc.: Connection refused"}\n'
        + '{"event":"end","data":{}}\n';

    it("reports the reason rather than an empty result", () => {
        const parsed = parseCliOutput("iperf3", REFUSED, "");

        assert.match(parsed.error, /unable to connect to server/);
    });

    it("does not mistake the empty end event for a measurement", () => {
        assert.equal(REGISTRY.iperf3.isResult({event: "end", data: {}}), false,
            "a failed run would be stored as a test that produced nothing");
        assert.equal(REGISTRY.iperf3.isResult({event: "end", data: {sum_received: {}}}), true);
        assert.equal(REGISTRY.iperf3.isResult({event: "interval", data: {sum: {}}}), false);
    });

    // The three providers that came before say it in an `error` member, and
    // must go on doing so.
    it("leaves the other providers' error reading alone", () => {
        const parsed = parseCliOutput("libre", '{"error":"something went wrong"}\n', "");

        assert.equal(parsed.error, "something went wrong");
    });
});

describe("the arguments an iperf3 run is given", () => {
    const argsFor = (endpoint) =>
        REGISTRY.iperf3.buildArgs({endpoint}, {name: "eth0", address: "192.168.1.9"}).args;

    it("dials the host and port the target names", () => {
        const args = argsFor("10.0.0.5:5202");

        assert.deepEqual(args.slice(0, 4), ["--client", "10.0.0.5", "--port", "5202"]);
    });

    it("binds to the interface the instance measures on", () => {
        assert.deepEqual(argsFor("10.0.0.5").slice(-2), ["--bind", "192.168.1.9"]);
    });

    /**
     * Line-delimited rather than plain --json, which pretty-prints one object
     * across many lines - none of which parse on their own, so the shared
     * line-oriented parser would have found nothing at all.
     */
    it("asks for line-delimited output", () => {
        assert.ok(argsFor("10.0.0.5").includes("--json-stream"));
        assert.ok(!argsFor("10.0.0.5").includes("--json"));
    });

    // Without it a host that accepts nothing - a LAN target switched off, the
    // ordinary case - holds the run until its own three-minute timeout and is
    // reported as a test that did not finish.
    it("bounds how long the control connection may take", () => {
        assert.ok(argsFor("10.0.0.5").includes("--connect-timeout"));
    });

    it("measures one direction per invocation, download first", () => {
        assert.deepEqual(REGISTRY.iperf3.runs.map((run) => run.key), ["download", "upload"]);
        assert.deepEqual(REGISTRY.iperf3.runs[0].args, ["-R"]);
        assert.deepEqual(REGISTRY.iperf3.runs[1].args, []);
    });
});

describe("reading a target's host and port", () => {
    it("takes iperf3's own port when the target names none", () => {
        assert.deepEqual(splitEndpoint("10.0.0.5"), {host: "10.0.0.5", port: IPERF_DEFAULT_PORT});
        assert.deepEqual(splitEndpoint("host.lan"), {host: "host.lan", port: IPERF_DEFAULT_PORT});
    });

    it("splits a port off when it names one", () => {
        assert.deepEqual(splitEndpoint("10.0.0.5:5202"), {host: "10.0.0.5", port: 5202});
    });

    // The last colon separates, so a bracketed literal keeps its own - and the
    // brackets come off the host that is actually dialled.
    it("reads an IPv6 literal", () => {
        assert.deepEqual(splitEndpoint("[2001:db8::1]:5301"), {host: "2001:db8::1", port: 5301});
        assert.deepEqual(splitEndpoint("2001:db8::1"),
            {host: "2001:db8::1", port: IPERF_DEFAULT_PORT});
    });
});

describe("what an iperf3 target may name", () => {
    const iperf = (endpoint) => targetProblem({name: "LAN", provider: "iperf3", endpoint});

    it("accepts a host, with or without a port", () => {
        assert.equal(iperf("10.0.0.5"), null);
        assert.equal(iperf("10.0.0.5:5201"), null);
        assert.equal(iperf("nas.lan:5201"), null);
        assert.equal(iperf("[2001:db8::1]:5201"), null);
    });

    /**
     * A LAN address and loopback are the ordinary case here, and the main
     * reason to want this provider at all - so the rules the node list applies
     * to stop this server being aimed at private addresses on someone's behalf
     * deliberately do not apply. The operator is aiming it at their own
     * machine on purpose.
     */
    it("accepts the private and loopback addresses that are the point of it", () => {
        assert.equal(iperf("192.168.1.50:5201"), null);
        assert.equal(iperf("127.0.0.1"), null);
        assert.equal(iperf("10.0.0.5"), null);
    });

    it("refuses a URL, naming what it wants instead", () => {
        assert.match(iperf("http://10.0.0.5:5201"), /not a URL/);
        assert.match(iperf("user@10.0.0.5"), /not a URL/);
    });

    it("refuses a port that is not one", () => {
        assert.match(iperf("10.0.0.5:0"), /between 1 and 65535/);
        assert.match(iperf("10.0.0.5:99999"), /between 1 and 65535/);
        assert.match(iperf("10.0.0.5:http"), /digits/);
    });

    it("refuses a host that is missing or unusable", () => {
        assert.match(iperfEndpointProblem(""), /needs a host/);
        assert.match(iperfEndpointProblem("  "), /needs a host/);
        assert.match(iperfEndpointProblem("nas lan"), /spaces/);
        assert.match(iperfEndpointProblem(":5201"), /needs a host/);
    });

    /**
     * Refused at the door rather than at the first run: a target with no host
     * can never measure anything, and left to the schedule it would fail once
     * an hour with the reason three clicks away in a row's error column.
     */
    it("insists on a host, unlike a libre target", () => {
        assert.match(targetProblem({name: "LAN", provider: "iperf3"}), /needs the host/);
        assert.equal(targetProblem({name: "Public", provider: "libre"}), null);
    });

    // The URL rules still hold for the provider that takes a URL.
    it("still holds a libre endpoint to being a URL", () => {
        assert.match(targetProblem({name: "own", provider: "libre", endpoint: "10.0.0.5:5201"}),
            /must be a URL/);
    });

    it("still refuses an endpoint on a provider that takes none", () => {
        assert.match(targetProblem({name: "x", provider: "ookla", endpoint: "10.0.0.5"}),
            /takes no endpoint/);
    });
});

describe("the latency the runner measures for it", () => {
    it("takes the middle of the samples, not their mean", () => {
        assert.equal(median([5, 1, 3]), 3);
        assert.equal(median([4, 1, 3, 2]), 2.5);
        assert.equal(median([]), null);
    });

    // Around the median rather than the mean, so one slow handshake widens the
    // figure without also dragging the centre it is measured from.
    it("reports the spread of the samples as jitter", () => {
        assert.equal(spread([10, 10, 10]), 0);
        assert.equal(spread([9, 10, 11]), 2 / 3);
        assert.equal(spread([10]), null, "one sample says nothing about how steady the path is");
    });

    // A socket that connects, timed. The stub is an EventEmitter shaped like a
    // real one, so the module's own listeners are what settle it.
    const socketThat = (behaviour) => () => {
        const socket = new EventEmitter();
        socket.destroy = () => undefined;
        socket.setTimeout = (ms, onTimeout) => { socket.onTimeout = onTimeout; };

        queueMicrotask(() => behaviour(socket));

        return socket;
    };

    it("times a handshake that completed", async () => {
        const reading = await sampleHandshake({host: "h", port: 1,
            connect: socketThat((socket) => socket.emit("connect"))});

        assert.equal(typeof reading, "number");
        assert.ok(reading >= 0);
    });

    /**
     * A sample that failed is dropped rather than recorded. Recording the
     * timeout as the reading would put a made-up two thousand milliseconds
     * into the figure, which is worse than measuring one sample fewer.
     */
    it("drops a handshake that was refused", async () => {
        const reading = await sampleHandshake({host: "h", port: 1,
            connect: socketThat((socket) => socket.emit("error", new Error("ECONNREFUSED")))});

        assert.equal(reading, null);
    });

    it("drops one that never answered", async () => {
        const reading = await sampleHandshake({host: "h", port: 1, timeoutMs: 5,
            connect: socketThat((socket) => socket.onTimeout?.())});

        assert.equal(reading, null);
    });

    it("answers nothing at all when no handshake completed", async () => {
        const latency = await measureLatency({host: "h", port: 1, samples: 3,
            connect: socketThat((socket) => socket.emit("error", new Error("nope")))});

        assert.deepEqual(latency, {ping: null, jitter: null});
    });

    it("builds a reading out of the samples that did complete", async () => {
        const latency = await measureLatency({host: "h", port: 1, samples: 3,
            connect: socketThat((socket) => socket.emit("connect"))});

        assert.equal(typeof latency.ping, "number");
        assert.equal(typeof latency.jitter, "number");
    });
});

/**
 * The progress bar follows an iperf3 run through its interval records - which
 * name no direction, because an interval describes whichever one this
 * invocation was started for.
 */
describe("progress through an iperf3 transfer", () => {
    const interval = (end, bits, omitted = false) =>
        ({event: "interval", data: {sum: {end, bits_per_second: bits, omitted}}});

    it("reports the phase the runner says is running", () => {
        assert.equal(iperf3Progress(interval(5, 94000000), "download").phase, "download");
        assert.equal(iperf3Progress(interval(5, 94000000), "upload").phase, "upload");
    });

    it("works out how far through from the interval's own clock", () => {
        assert.equal(iperf3Progress(interval(5, 0), "download").progress, 0.5);
        assert.equal(iperf3Progress(interval(10, 0), "download").progress, 1);
        assert.equal(iperf3Progress(interval(99, 0), "download").progress, 1,
            "a run that overran reported more than a full bar");
    });

    it("reports the speed in the unit the row is stored in", () => {
        assert.equal(iperf3Progress(interval(5, 94000000), "download").speed, 94);
    });

    /**
     * The warm-up intervals run before the measurement and are marked omitted.
     * Reported, they would take the bar to a tenth and then back to nothing
     * when the measured intervals started counting from zero again.
     */
    it("says nothing during the omitted warm-up", () => {
        assert.equal(iperf3Progress(interval(1, 94000000, true), "download"), null);
    });

    it("says nothing for the events that are not intervals", () => {
        assert.equal(iperf3Progress({event: "start", data: {}}, "download"), null);
        assert.equal(iperf3Progress({event: "end", data: {}}, "download"), null);
    });

    // The latency sample is not one of these invocations, and a run with no
    // phase has nothing to report.
    it("says nothing when the runner named no phase", () => {
        assert.equal(iperf3Progress(interval(5, 94000000), undefined), null);
        assert.equal(iperf3Progress(interval(5, 94000000), "ping"), null);
    });
});

describe("the builds it downloads", () => {
    it("offers one for every platform MySpeed itself supports", () => {
        for (const [platform, arch] of [["linux", "x64"], ["linux", "arm64"],
            ["win32", "x64"], ["darwin", "arm64"], ["darwin", "x64"]])
            assert.ok(selectBinary({platform, arch}), `${platform}-${arch} has no build`);
    });

    /**
     * No musl branch, unlike cfspeedtest: these are static builds that carry
     * their own libc, so one Linux download serves both.
     */
    it("serves musl and glibc from the one Linux build", () => {
        assert.equal(selectBinary({platform: "linux", arch: "x64"}).suffix, "iperf3-amd64");
    });

    it("says which platform it has nothing for", () => {
        assert.throws(() => selectBinary({platform: "sunos", arch: "sparc"}), /sunos-sparc/);
    });

    /**
     * Only the Windows asset is an archive, and it is the one that must be,
     * because the Cygwin build needs its DLL beside it. Everywhere else the
     * asset is the executable itself.
     */
    it("unpacks only the archive, and only Windows publishes one", () => {
        const archives = iperfList.filter((entry) => entry.archive);

        assert.deepEqual(archives.map((entry) => entry.os), ["win32"]);
        assert.ok(archives[0].suffix.endsWith(".zip"));
    });
});

/**
 * And it is not fetched until something wants it.
 *
 * The three speedtest CLIs are what a default install measures with, so having
 * them on disk before the first scheduled run is worth the download. This one
 * measures against a server the operator runs themselves - which most
 * instances do not have - and its static build is some sixteen megabytes.
 */
describe("when the binary is fetched", () => {
    it("is left until a target actually uses it", () => {
        assert.equal(REGISTRY.iperf3.downloadedOnDemand, true);
    });

    it("is kept out of the boot download", () => {
        const source = readSource("server/util/loadCli.js");

        assert.match(source, /\.filter\(\(entry\) => !entry\.downloadedOnDemand\)/,
            "every instance pays for a CLI most of them will never measure with");
    });

    // The three that a default install does measure with stay eager, or the
    // first scheduled run on a fresh instance waits for a download.
    it("leaves the providers a default install uses on the boot list", () => {
        for (const id of ["ookla", "libre", "cloudflare"])
            assert.notEqual(REGISTRY[id].downloadedOnDemand, true, `${id} stopped being fetched at boot`);
    });

    /**
     * What makes the lazy path work at all: the runner asks the loader before
     * every run, so a provider left out of the boot download is fetched by the
     * first test that needs it rather than never.
     */
    it("is fetched by the run that needs it", () => {
        const runner = readSource("server/util/speedtest.js");

        assert.match(runner, /await ensureBinary\(mode, binaryPath\)/);
    });
});

/**
 * A bracketed IPv6 literal carrying no port.
 *
 * The brackets are the URL spelling of an address and never part of the host
 * that is dialled, but they only came off on the branch that also parses a
 * port. "[fd00::1]" has its last colon inside the literal, so it took the
 * no-port branch and kept them - and iperfEndpointProblem accepts it, so the
 * target was created, scheduled, and handed "[fd00::1]" to --client, which
 * getaddrinfo cannot resolve. It could never produce a measurement.
 */
describe("a bracketed IPv6 endpoint without a port", () => {
    it("keeps the default port and loses the brackets", () => {
        assert.deepEqual(splitEndpoint("[fd00::1]"), {host: "fd00::1", port: IPERF_DEFAULT_PORT});
        assert.deepEqual(splitEndpoint("[2001:db8::1]"),
            {host: "2001:db8::1", port: IPERF_DEFAULT_PORT});
    });

    // The bracketed form with a port, and the bare form, both already worked
    // and must keep working.
    it("leaves the forms that already worked alone", () => {
        assert.deepEqual(splitEndpoint("[2001:db8::1]:5301"), {host: "2001:db8::1", port: 5301});
        assert.deepEqual(splitEndpoint("2001:db8::1"),
            {host: "2001:db8::1", port: IPERF_DEFAULT_PORT});
        assert.deepEqual(splitEndpoint("10.0.0.5:5202"), {host: "10.0.0.5", port: 5202});
    });
});
