import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { bodyIn, readSource, withoutJsComments } from "../helpers/source.js";
import { EventEmitter } from "node:events";
import { parseIperf3 } from "../../server/util/providers/parseData.js";
import { parseCliOutput } from "../../server/util/providers/cliOutput.js";
import { iperf3Progress } from "../../server/util/providers/progress.js";
import { measureLatency, median, sampleHandshake, spread } from "../../server/util/providers/iperfLatency.js";
import { IPERF_DEFAULT_PORT, REGISTRY, joinEndpoint, splitEndpoint }
    from "../../server/util/providers/registry.js";
import { iperfEndpointProblem, targetProblem } from "../../server/controller/targets.js";
import { fileExists, installFiles, missingFiles, partialInstallError, selectBinary }
    from "../../server/util/providers/loadIperf3.js";
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

    /**
     * The regression this pair of assertions exists for. The join used to be a
     * bare `${host}:${port}` after splitEndpoint had deliberately stripped the
     * brackets, so an IPv6 target's stored serverHost was "2001:db8::1:5301" -
     * a different, still valid IPv6 address, with the port absorbed into it.
     * That string reached the detail pane, the CSV, the notification payload
     * and the Prometheus label, and pasting it back created a target measuring
     * a different host while the history claimed it was the same server.
     */
    it("names an IPv6 server as an address that still means that server", () => {
        const host = parseIperf3(bothWays({endpoint: {host: "2001:db8::1", port: 5301}})).serverHost;

        assert.equal(host, "[2001:db8::1]:5301");
        assert.notEqual(host, "2001:db8::1:5301");
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
     * The family flag beside the bind, the way the cloudflare builder already
     * chooses --ipv4/--ipv6. A dual-stack hostname resolves in both families
     * and getaddrinfo's preference need not match the bound source - iperf3
     * then connects over the family the --bind address cannot bind, and a
     * reachable server reads as "unable to connect" on every scheduled run.
     */
    it("holds the connection to the bound address's family", () => {
        assert.ok(argsFor("nas.lan").includes("-4"), "an IPv4 bind does not pin the family");
        assert.ok(!argsFor("nas.lan").includes("-6"));
    });

    it("asks for IPv6 when the instance measures on it", () => {
        const args = REGISTRY.iperf3.buildArgs({endpoint: "nas.lan"},
            {name: "eth0", address: "fd00::9"}).args;

        assert.ok(args.includes("-6"), "an IPv6 bind does not pin the family");
        assert.ok(!args.includes("-4"));
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

/**
 * A target's own measurement length and stream count, replacing the registry
 * defaults for that target alone.
 *
 * The untuned argv is written out literally here rather than assembled from the
 * constants it holds still, which is deliberate and is the whole value of it: a
 * pin built out of the values it pins moves with them and asserts nothing. Every
 * target that exists today carries no tuning, so this is the assertion that says
 * the feature changed nothing about what they measure - and the numbers in it
 * are the shipped defaults spelled as the CLI receives them.
 */
describe("an iperf3 target's own tuning", () => {
    const TUNED_IFACE = {name: "eth0", address: "192.168.1.9"};

    const tunedArgs = (target) => REGISTRY.iperf3.buildArgs(target, TUNED_IFACE).args;

    const UNTUNED_ARGV = ["--client", "10.0.0.5", "--port", "5201", "--json-stream",
        "--time", "10", "--parallel", "4", "--omit", "1", "--connect-timeout", "5000",
        "-4", "--bind", "192.168.1.9"];

    // The value that follows a flag, so a moved argument is reported as the
    // wrong value rather than as a whole array nobody can diff by eye.
    const valueOf = (args, flag) => args[args.indexOf(flag) + 1];

    it("gives a target that tunes nothing the argv it has always been given", () => {
        assert.deepEqual(tunedArgs({endpoint: "10.0.0.5"}), UNTUNED_ARGV);
    });

    /**
     * A stored row spells "inherit the default" as NULL, where the fragment a
     * PUT carried spells it by leaving the field out. Both describe the same
     * run, and `?? default` is what makes them agree - `|| default` would too,
     * right up to a target that legitimately tunes something to zero.
     */
    it("reads a stored null the same way as a field that is absent", () => {
        assert.deepEqual(tunedArgs({endpoint: "10.0.0.5", iperfDuration: null, iperfStreams: null}),
            UNTUNED_ARGV);
    });

    it("measures for the duration the target names", () => {
        const args = tunedArgs({endpoint: "10.0.0.5", iperfDuration: 30});

        assert.equal(valueOf(args, "--time"), "30");
        assert.equal(valueOf(args, "--parallel"), "4", "tuning the duration moved the stream count");
    });

    it("carries the transfer over the number of streams the target names", () => {
        const args = tunedArgs({endpoint: "10.0.0.5", iperfStreams: 8});

        assert.equal(valueOf(args, "--parallel"), "8");
        assert.equal(valueOf(args, "--time"), "10", "tuning the streams moved the duration");
    });

    it("takes both at once", () => {
        const args = tunedArgs({endpoint: "10.0.0.5", iperfDuration: 30, iperfStreams: 8});

        assert.equal(valueOf(args, "--time"), "30");
        assert.equal(valueOf(args, "--parallel"), "8");
    });

    /**
     * The omitted warm-up is not per-target and must not become so by accident:
     * it is TCP slow-start compensation, the same at every duration, and a
     * fourth number in the dialog buys nothing.
     */
    it("leaves the omitted warm-up where it is", () => {
        assert.equal(valueOf(tunedArgs({endpoint: "10.0.0.5", iperfDuration: 60}), "--omit"), "1");
    });

    // The interface binding is the last pair, and the pin above reads it as
    // args.slice(-2) - so nothing may be appended after it, at any tuning.
    it("keeps the interface binding last however the target is tuned", () => {
        for (const tuning of [{}, {iperfDuration: 60}, {iperfStreams: 32},
            {iperfDuration: 5, iperfStreams: 1}])
            assert.deepEqual(tunedArgs({endpoint: "10.0.0.5", ...tuning}).slice(-2),
                ["--bind", "192.168.1.9"], `the bind moved for ${JSON.stringify(tuning)}`);
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
     * Brackets mean exactly one thing: the whole address wrapped once, with
     * nothing but an optional :port after the "]". Anything else used to be
     * read as a host with a port - "[fd00::1" swallows its own port - and
     * accepted, and splitEndpoint then dials the brackets verbatim, which
     * getaddrinfo can never resolve. The target was created happily and failed
     * every scheduled run, with the reason three clicks away in a row's error
     * column - the exact fate the door exists to refuse.
     */
    it("refuses brackets that do not wrap the whole address", () => {
        assert.match(iperfEndpointProblem("[fd00::1"), /[Bb]rackets/);
        assert.match(iperfEndpointProblem("[fd00::1:5201"), /[Bb]rackets/);
        assert.match(iperfEndpointProblem("fd00::1]"), /[Bb]rackets/);
        assert.match(iperfEndpointProblem("nas[0].lan"), /[Bb]rackets/);
        assert.match(iperfEndpointProblem("[fd00::1]x:5201"), /[Bb]rackets/);
        assert.match(iperfEndpointProblem("[[fd00::1]]"), /[Bb]rackets/);
    });

    it("still accepts the bracketed spellings that are well formed", () => {
        assert.equal(iperfEndpointProblem("[fd00::1]"), null);
        assert.equal(iperfEndpointProblem("[fd00::1]:5201"), null);
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
     * A pinned interface pins the address family too. `localAddress` alone
     * lets the resolver pick either family for a dual-stack hostname, and a
     * bind of an IPv4 address onto an IPv6 connection is refused outright -
     * `net.connect({host: "::1", localAddress: "127.0.0.1"})` answers `bind
     * EINVAL` - so a dual-stack endpoint measured over a pinned IPv4 interface
     * dropped every sample and stored 0 ms latency for the life of the target.
     */
    it("resolves the endpoint in the pinned interface's family", async () => {
        const options = [];
        const capture = (received) => {
            options.push(received);
            return socketThat((socket) => socket.emit("connect"))();
        };

        await sampleHandshake({host: "h", port: 1, localAddress: "127.0.0.1", connect: capture});
        await sampleHandshake({host: "h", port: 1, localAddress: "2001:db8::7", connect: capture});

        assert.equal(options[0].family, 4,
            "a dual-stack hostname can resolve to IPv6 and fail the IPv4 bind");
        assert.equal(options[1].family, 6);
    });

    // Unpinned, the resolver stays free to pick - Happy Eyeballs and all.
    it("leaves the family open when no interface is pinned", async () => {
        const options = [];
        const capture = (received) => {
            options.push(received);
            return socketThat((socket) => socket.emit("connect"))();
        };

        await sampleHandshake({host: "h", port: 1, connect: capture});

        assert.equal("family" in options[0], false);
        assert.equal("localAddress" in options[0], false);
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
 * What the install consists of, per platform - derived from the selected build
 * rather than from the platform name, so the answer moves with the manifest.
 */
describe("what a complete iperf3 install is", () => {
    it("counts the Cygwin runtime as part of the Windows install", () => {
        assert.deepEqual(installFiles({platform: "win32", arch: "x64"}), ["iperf3.exe", "cygwin1.dll"]);
    });

    it("is one file everywhere the published asset is the executable", () => {
        for (const [platform, arch] of [["linux", "x64"], ["linux", "arm64"],
            ["darwin", "arm64"], ["darwin", "x64"]])
            assert.deepEqual(installFiles({platform, arch}), ["iperf3"], `${platform}-${arch}`);
    });

    /**
     * Windows platforms with no published build get the one-file answer, on
     * purpose: selectBinary's own error tells the operator to install iperf3
     * themselves and put it in bin/, and a hand-installed single executable
     * must not start reading as a broken install the moment it works.
     */
    it("leaves a hand-installed build alone where Windows has no published one", () => {
        assert.deepEqual(installFiles({platform: "win32", arch: "arm64"}), ["iperf3.exe"]);
        assert.deepEqual(installFiles({platform: "win32", arch: "ia32"}), ["iperf3.exe"]);
    });

    it("asks for nothing extra on a platform it has never heard of", () => {
        assert.deepEqual(installFiles({platform: "sunos", arch: "sparc"}), ["iperf3"]);
    });
});

/**
 * The finding itself. The Windows install is two files - the Cygwin build of
 * iperf3.exe will not start without cygwin1.dll beside it - but fileExists()
 * answered on the .exe alone. A bin/ that had lost the DLL to an antivirus
 * quarantine therefore never re-downloaded: spawn succeeded, the process died
 * at once with STATUS_DLL_NOT_FOUND having printed nothing, and every
 * scheduled run failed for the life of the install with a message naming
 * neither the missing file nor the download that would fix it.
 */
describe("whether the iperf3 on disk is an install at all", () => {
    const directories = [];

    const holding = (names) => {
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), "myspeed-iperf3-"));
        for (const name of names) fs.writeFileSync(path.join(directory, name), "");
        directories.push(directory);
        return directory;
    };

    after(() => {
        for (const directory of directories) fs.rmSync(directory, {recursive: true, force: true});
    });

    it("is not an install when Windows has lost cygwin1.dll", async () => {
        const directory = holding(["iperf3.exe"]);

        assert.deepEqual(missingFiles({platform: "win32", arch: "x64", directory}), ["cygwin1.dll"]);
        assert.equal(await fileExists({platform: "win32", arch: "x64", directory}), false);
    });

    it("is an install once both files are there", async () => {
        const directory = holding(["iperf3.exe", "cygwin1.dll"]);

        assert.deepEqual(missingFiles({platform: "win32", arch: "x64", directory}), []);
        assert.equal(await fileExists({platform: "win32", arch: "x64", directory}), true);
    });

    it("wants only the executable where that is the whole install", async () => {
        assert.equal(await fileExists({platform: "linux", arch: "x64", directory: holding(["iperf3"])}), true);
        assert.deepEqual(missingFiles({platform: "linux", arch: "x64", directory: holding([])}), ["iperf3"]);
    });
});

/**
 * The extractor's blind spot, closed from the caller's side: extractFiles
 * throws only when *nothing* matched, so an archive whose layout changed could
 * unpack one member and be recorded as a finished download.
 */
describe("an archive that unpacked only half of itself", () => {
    it("says which file did not arrive", () => {
        const problem = partialInstallError(["cygwin1.dll"], "iperf3-win-x64.zip");

        assert.match(problem, /cygwin1\.dll/);
        assert.match(problem, /iperf3-win-x64\.zip/);
    });

    it("says nothing when every file arrived", () => {
        assert.equal(partialInstallError([], "iperf3-win-x64.zip"), null);
    });

    // The wiring the pure helper cannot pin: the download itself must refuse a
    // half-arrived archive rather than leave it looking like an install.
    // Comments are stripped so prose about the check cannot stand in for it.
    it("is refused by the download rather than left to look like an install", () => {
        const download = withoutJsComments(bodyIn("server/util/providers/loadIperf3.js",
            "export const downloadFile"));

        assert.match(download, /partialInstallError\(missingFiles\(\)/);
        assert.match(download, /throw new Error\(problem\)/);
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

/**
 * The inverse of that reading, for the one row column that records the address
 * as a single string. It lives beside splitEndpoint because it inverts it, and
 * a join written anywhere else as `${host}:${port}` is exactly how an IPv6
 * address came to be stored as a different IPv6 address.
 */
describe("writing a host and a port back as one string", () => {
    it("brackets an IPv6 literal so the port cannot join the address", () => {
        assert.equal(joinEndpoint({host: "2001:db8::1", port: 5301}), "[2001:db8::1]:5301");
        assert.notEqual(joinEndpoint({host: "2001:db8::1", port: 5301}), "2001:db8::1:5301");
    });

    it("leaves a name or an IPv4 address alone", () => {
        assert.equal(joinEndpoint({host: "10.0.0.5", port: 5201}), "10.0.0.5:5201");
        assert.equal(joinEndpoint({host: "nas.lan", port: 5201}), "nas.lan:5201");
    });

    // The brackets are part of the literal's spelling, not of the port's: a
    // host with no port to separate still keeps them, so the string means the
    // same server whichever way it is read back.
    it("keeps the brackets when there is no port to separate", () => {
        assert.equal(joinEndpoint({host: "fd00::1"}), "[fd00::1]");
        assert.equal(joinEndpoint({host: "10.0.0.5", port: null}), "10.0.0.5");
    });

    // The same isPort splitEndpoint holds a written port to, so the pair
    // cannot disagree about what counts as one.
    it("drops a port that is not one", () => {
        for (const port of [0, 65536, 5201.5, "5201", NaN])
            assert.equal(joinEndpoint({host: "10.0.0.5", port}), "10.0.0.5",
                `${port} was written as a port`);
    });

    it("has nothing to say without a host", () => {
        assert.equal(joinEndpoint(), null);
        assert.equal(joinEndpoint({}), null);
        assert.equal(joinEndpoint({host: null}), null);
        assert.equal(joinEndpoint({host: "   "}), null);
    });

    /**
     * The round trip that would have caught the original bug: what the join
     * writes, the split must read back as the same pair - and the validator
     * must accept, or the address a row displays cannot be pasted back in.
     */
    it("round-trips through the reading that produced it", () => {
        for (const endpoint of ["[2001:db8::1]:5301", "2001:db8::1", "10.0.0.5:5202"]) {
            const pair = splitEndpoint(endpoint);
            const written = joinEndpoint(pair);

            assert.deepEqual(splitEndpoint(written), pair, `${endpoint} came back different`);
            assert.equal(iperfEndpointProblem(written), null, `${written} was refused`);
        }
    });
});
