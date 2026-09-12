import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import {
    MAX_HOPS, MAX_OUTPUT_BYTES, MAX_RTT_PER_HOP, TRACE_FALLBACK_HOSTS, TRACE_REASONS, TRACE_TIMEOUT_MS, UNDER_ONE_MS,
    degradedRun, isHopTable, isTraceableHost, parseTrace, resetMissingTools, runTrace, traceCommands, traceHost
} from "../../server/util/traceroute.js";

/**
 * The shape every reader of a stored table may rely on. The parser is the
 * only honest producer, but the column is also written by the history import
 * from whatever a file holds - and a reader that dereferences `hop.rtt` on a
 * row the import let through crashes the detail pane for that test.
 */
describe("isHopTable", () => {
    const hop = (extra = {}) => ({hop: 1, address: "192.168.1.1", rtt: [0.5, 1], lost: 0, ...extra});

    it("accepts what the parser produces", () => {
        assert.equal(isHopTable([hop(), hop({hop: 2, address: null, rtt: [], lost: 3})]), true);
        assert.equal(isHopTable([]), true);
    });

    it("refuses anything that is not a list of hops", () => {
        for (const value of [null, undefined, "[]", {}, 42, [null], ["hop"], [[]]])
            assert.equal(isHopTable(value), false, JSON.stringify(value));
    });

    it("refuses a hop missing a field or carrying the wrong kind", () => {
        const {rtt, ...noRtt} = hop();
        const {lost, ...noLost} = hop();

        for (const bad of [noRtt, noLost, hop({hop: 0}), hop({hop: 1.5}), hop({hop: "1"}),
            hop({address: 5}), hop({address: undefined}), hop({rtt: "1"}), hop({rtt: [null]}), hop({rtt: [-1]}),
            hop({rtt: [Infinity]}), hop({lost: -1}), hop({lost: 1.5}), hop({lost: "3"})])
            assert.equal(isHopTable([bad]), false, JSON.stringify(bad));
    });

    it("refuses a table past the hop ceiling", () => {
        const table = Array.from({length: MAX_HOPS + 1}, (_, i) => hop({hop: i + 1}));
        assert.equal(isHopTable(table), false);
    });

    // The parser merges a hop's lines and probes at most a handful of times,
    // so a hop with a hundred thousand latencies - or two hops numbered the
    // same, which the parser also never produces - is a hand-edited file,
    // and the pane would draw a span per latency and key two rows alike.
    it("refuses a hop with more latencies than any tool probes", () => {
        assert.equal(isHopTable([hop({rtt: Array(MAX_RTT_PER_HOP).fill(1)})]), true);
        assert.equal(isHopTable([hop({rtt: Array(MAX_RTT_PER_HOP + 1).fill(1)})]), false);
    });

    it("refuses two hops with the same number", () => {
        assert.equal(isHopTable([hop({hop: 3}), hop({hop: 3})]), false);
    });
});
import { trackProcess, terminateActiveProcess } from "../../server/util/speedtest.js";
import { resolveLimits } from "../../server/util/targetLimits.js";

/*
 * The hop table is what a degraded run leaves behind so a reader can tell
 * whether the fault sat on the LAN, at the provider's gateway or somewhere out
 * on the internet. Every tool prints it differently and Windows prints it in
 * the service's own language, so the parser is held to a matrix of real
 * outputs rather than to one shape.
 */
describe("parseTrace", () => {
    const WINDOWS_ENGLISH = [
        "",
        "Tracing route to fra.example.net [203.0.113.10]",
        "over a maximum of 20 hops:",
        "",
        "  1    <1 ms    <1 ms    <1 ms  192.168.1.1",
        "  2     3 ms     2 ms     3 ms  10.0.0.1",
        "  3     *        *        *     Request timed out.",
        "  4    12 ms     *       11 ms  203.0.113.10",
        "",
        "Trace complete.",
        ""
    ].join("\r\n");

    it("reads a Windows table hop by hop", () => {
        assert.deepEqual(parseTrace(WINDOWS_ENGLISH), [
            {hop: 1, address: "192.168.1.1", rtt: [UNDER_ONE_MS, UNDER_ONE_MS, UNDER_ONE_MS], lost: 0},
            {hop: 2, address: "10.0.0.1", rtt: [3, 2, 3], lost: 0},
            {hop: 3, address: null, rtt: [], lost: 3},
            {hop: 4, address: "203.0.113.10", rtt: [12, 11], lost: 1}
        ]);
    });

    // tracert speaks the service account's language, and a German service
    // prints "Zeitüberschreitung der Anforderung." where the English one
    // prints "Request timed out." - nothing in the parser may depend on a word.
    it("reads a German Windows table the same way", () => {
        const output = [
            "Routenverfolgung zu fra.example.net [203.0.113.10]",
            "über maximal 20 Abschnitte:",
            "",
            "  1     1 ms     1 ms     1 ms  192.168.1.1",
            "  2     *        *        *     Zeitüberschreitung der Anforderung.",
            "  3    14 ms    13 ms    14 ms  203.0.113.10",
            "",
            "Ablaufverfolgung beendet."
        ].join("\r\n");

        assert.deepEqual(parseTrace(output), [
            {hop: 1, address: "192.168.1.1", rtt: [1, 1, 1], lost: 0},
            {hop: 2, address: null, rtt: [], lost: 3},
            {hop: 3, address: "203.0.113.10", rtt: [14, 13, 14], lost: 0}
        ]);
    });

    it("reads a GNU traceroute table with one probe per hop", () => {
        const output = [
            "traceroute to fra.example.net (203.0.113.10), 20 hops max, 60 byte packets",
            " 1  192.168.1.1  0.412 ms",
            " 2  10.0.0.1  2.981 ms",
            " 3  *",
            " 4  203.0.113.10  11.204 ms"
        ].join("\n");

        assert.deepEqual(parseTrace(output), [
            {hop: 1, address: "192.168.1.1", rtt: [0.412], lost: 0},
            {hop: 2, address: "10.0.0.1", rtt: [2.981], lost: 0},
            {hop: 3, address: null, rtt: [], lost: 1},
            {hop: 4, address: "203.0.113.10", rtt: [11.204], lost: 0}
        ]);
    });

    // tracepath is what the Docker image gets - it needs no raw socket. It
    // prints several lines per hop, an "asymm" count that is not a latency,
    // and "no reply" rather than a star.
    it("reads a tracepath table, merging the lines of one hop", () => {
        const output = [
            " 1?: [LOCALHOST]                      pmtu 1500",
            " 1:  192.168.1.1                                           0.640ms ",
            " 1:  192.168.1.1                                           0.512ms ",
            " 2:  10.0.0.1                                              2.317ms asymm  3 ",
            " 3:  no reply",
            " 4:  203.0.113.10                                         11.820ms reached",
            "     Resume: pmtu 1500 hops 4 back 4 "
        ].join("\n");

        assert.deepEqual(parseTrace(output), [
            {hop: 1, address: "192.168.1.1", rtt: [0.64, 0.512], lost: 0},
            {hop: 2, address: "10.0.0.1", rtt: [2.317], lost: 0},
            {hop: 3, address: null, rtt: [], lost: 1},
            {hop: 4, address: "203.0.113.10", rtt: [11.82], lost: 0}
        ]);
    });

    it("reads an IPv6 route", () => {
        const output = [
            " 1  2001:db8::1  0.9 ms",
            " 2  2001:db8:1::a  4.1 ms"
        ].join("\n");

        assert.deepEqual(parseTrace(output).map((hop) => hop.address), ["2001:db8::1", "2001:db8:1::a"]);
    });

    it("reads a Windows IPv6 route, where the address comes in brackets", () => {
        const output = "  1     2 ms     2 ms     2 ms  [2001:db8::1]";

        assert.deepEqual(parseTrace(output), [{hop: 1, address: "2001:db8::1", rtt: [2, 2, 2], lost: 0}]);
    });

    // Without -n honoured, a resolver name sits beside the address. The name
    // is not an address and must not be mistaken for one, and the address
    // beside it in parentheses still is.
    it("takes the address rather than the name when both are printed", () => {
        const output = " 2  gw.example.net (10.0.0.1)  2.1 ms";

        assert.equal(parseTrace(output)[0].address, "10.0.0.1");
    });

    it("accepts a comma decimal", () => {
        assert.deepEqual(parseTrace(" 1  192.168.1.1  0,412 ms")[0].rtt, [0.412]);
    });

    it("answers an empty table for nothing, a banner alone, or a line of prose", () => {
        assert.deepEqual(parseTrace(""), []);
        assert.deepEqual(parseTrace("Tracing route to 1.1.1.1 over a maximum of 20 hops:\n"), []);
        assert.deepEqual(parseTrace("traceroute: unknown host nowhere.invalid"), []);
        assert.deepEqual(parseTrace(null), []);
    });

    // What the parser writes is what the readers will read: a table past
    // either ceiling was stored, logged as traced, and shown nowhere.
    it("keeps no more latencies per hop than a table may hold", () => {
        const lines = Array.from({length: MAX_RTT_PER_HOP + 1}, (unused, index) =>
            ` 1:  192.168.1.1  ${index + 1}.000ms`).join("\n");
        const [hop] = parseTrace(lines);

        assert.equal(hop.rtt.length, MAX_RTT_PER_HOP);
        assert.ok(isHopTable([hop]));
    });

    it("drops a hop numbered zero, which is the tool naming its own interface", () => {
        const hops = parseTrace(" 0  10.0.0.1  0.1 ms\n 1  192.168.1.1  0.5 ms\n");

        assert.deepEqual(hops.map((hop) => hop.hop), [1]);
        assert.ok(isHopTable(hops));
    });

    it("reads no more than the hop ceiling", () => {
        const lines = Array.from({length: MAX_HOPS + 5}, (_, i) => ` ${i + 1}  10.0.0.${i + 1}  1 ms`);

        assert.equal(parseTrace(lines.join("\n")).length, MAX_HOPS);
    });

    it("keeps the hops in the order the tool printed them", () => {
        const output = " 2  10.0.0.2  1 ms\n 1  10.0.0.1  1 ms";

        assert.deepEqual(parseTrace(output).map((hop) => hop.hop), [2, 1]);
    });

    it("always produces a table isHopTable accepts", () => {
        for (const output of [WINDOWS_ENGLISH, " 1:  no reply\n 2:  10.0.0.1  1.2ms asymm 3", " 3  * * *", ""])
            assert.equal(isHopTable(parseTrace(output)), true, JSON.stringify(output));
    });
});

describe("traceCommands", () => {
    const host = "fra.example.net";

    it("asks tracert on Windows, without name resolution and with a bounded wait", () => {
        const [command, ...rest] = traceCommands(host, "win32");

        assert.equal(command.file, "tracert");
        assert.ok(command.args.includes("-d"), "tracert resolves names, which costs seconds a hop");
        assert.ok(command.args.includes("-h") && command.args.includes(String(MAX_HOPS)));
        assert.ok(command.args.includes("-w"), "no per-probe wait");
        assert.equal(command.args.at(-1), host);
        assert.deepEqual(rest, [], "Windows has one tool");
    });

    it("asks traceroute on Linux with tracepath behind it, both numeric and bounded", () => {
        const commands = traceCommands(host, "linux");

        assert.deepEqual(commands.map((command) => command.file), ["traceroute", "tracepath"]);

        for (const command of commands) {
            assert.ok(command.args.includes("-n"), `${command.file} resolves names`);
            assert.ok(command.args.includes("-m") && command.args.includes(String(MAX_HOPS)),
                `${command.file} has no hop ceiling`);
            assert.equal(command.args.at(-1), host);
        }

        assert.ok(commands[0].args.includes("-q") && commands[0].args.includes("1"),
            "one probe per hop, or a dead hop costs three waits");
    });

    it("asks traceroute alone on macOS", () => {
        assert.deepEqual(traceCommands(host, "darwin").map((command) => command.file), ["traceroute"]);
    });

    // The host is the last argument on purpose, and everything else is fixed:
    // a host is never read as an option, whatever it starts with.
    it("puts the host last, after every option", () => {
        for (const platform of ["win32", "linux", "darwin"])
            for (const command of traceCommands(host, platform))
                assert.equal(command.args.at(-1), host, `${platform} ${command.file}`);
    });
});

/**
 * The host reaches the tool as one argv entry with no shell, so nothing here is
 * about injection. It is about a host that starts with a dash being read as an
 * option, and about a name the tool would only choke on.
 */
describe("isTraceableHost", () => {
    it("accepts names, IPv4 and IPv6 literals", () => {
        for (const host of ["fra.example.net", "203.0.113.10", "2001:db8::1", "speed.cloudflare.com", "localhost"])
            assert.ok(isTraceableHost(host), host);
    });

    it("refuses an option-shaped or empty host", () => {
        for (const host of ["-h", "--help", "", " ", null, undefined, "a b", "host\n-x", "[2001:db8::1]"])
            assert.equal(isTraceableHost(host), false, String(host));
    });
});

/**
 * What to trace to. The interesting hop table is the route to the server the
 * test actually used, and the row knows it on a success; a failure parsed
 * nothing, so the target says where it would have gone, and the provider's
 * own front door is what is left when the target names nothing.
 */
describe("traceHost", () => {
    it("traces to the ookla server the run used, without its port", () => {
        assert.equal(traceHost({provider: "ookla"}, {serverHost: "fra.example.net:8080"}), "fra.example.net");
    });

    it("traces to the librespeed backend's host, not its URL", () => {
        assert.equal(traceHost({provider: "libre"}, {serverHost: "https://speed.example.org/backend"}),
            "speed.example.org");
    });

    it("traces to the iperf3 endpoint's host", () => {
        assert.equal(traceHost({provider: "iperf3"}, {serverHost: "10.0.0.5:5201"}), "10.0.0.5");
        assert.equal(traceHost({provider: "iperf3"}, {serverHost: "[2001:db8::5]:5201"}), "2001:db8::5");
    });

    it("traces to cloudflare's edge, which the run never names", () => {
        assert.equal(traceHost({provider: "cloudflare"}, {serverHost: null}), TRACE_FALLBACK_HOSTS.cloudflare);
    });

    describe("on a failure, where the run parsed no server", () => {
        it("finds the ookla server the target pins in the server list", () => {
            const servers = {"1234": {name: "Frankfurt", host: "fra.example.net:8080"}};

            assert.equal(traceHost({provider: "ookla", serverId: "1234"}, {servers}), "fra.example.net");
        });

        it("falls back to the provider's front door for an ookla target with no pinned server", () => {
            assert.equal(traceHost({provider: "ookla", serverId: null}, {servers: {}}), TRACE_FALLBACK_HOSTS.ookla);
        });

        it("falls back the same way when the pinned server is not in the list yet", () => {
            assert.equal(traceHost({provider: "ookla", serverId: "1234"}, {servers: {}}), TRACE_FALLBACK_HOSTS.ookla);
        });

        it("reads a librespeed target's own endpoint, or the project's front door", () => {
            assert.equal(traceHost({provider: "libre", endpoint: "http://speed.example.org/"}, {}), "speed.example.org");
            assert.equal(traceHost({provider: "libre", endpoint: null}, {}), TRACE_FALLBACK_HOSTS.libre);
        });

        it("reads an iperf3 target's endpoint, and has nowhere to fall back to", () => {
            assert.equal(traceHost({provider: "iperf3", endpoint: "iperf.example.net:5201"}, {}), "iperf.example.net");
            assert.equal(traceHost({provider: "iperf3", endpoint: null}, {}), null);
        });
    });

    it("never traces a preview run", () => {
        assert.equal(traceHost({provider: "preview"}, {serverHost: "fra.example.net"}), null);
    });

    it("answers null for a host the tool could not be handed", () => {
        assert.equal(traceHost({provider: "ookla"}, {serverHost: "-h"}), null);
        assert.equal(traceHost({provider: "libre"}, {serverHost: "not a url at all"}), null);
    });
});

/**
 * Which runs get a trace. A failure, unless the provider refused the run for
 * being asked too often - that is a fault at the provider, and a trace to it
 * says nothing. A success whose line fell under its own baseline. And a success
 * whose latency missed the optimum by the same margin the screen paints amber,
 * so the rule is the one in targetLimits rather than a fourth spelling of it.
 */
describe("degradedRun", () => {
    const limits = resolveLimits(null, {ping: "25"});

    it("names a final failure", () => {
        assert.equal(degradedRun({failed: true, limits}), TRACE_REASONS.failed);
    });

    it("leaves a rate-limited failure alone", () => {
        assert.equal(degradedRun({failed: true, rateLimited: true, limits}), null);
    });

    it("names a run that fell under its baseline", () => {
        assert.equal(degradedRun({failed: false, baselineBreached: true, ping: 10, limits}), TRACE_REASONS.baseline);
    });

    it("names a latency the screen would not paint green", () => {
        // 130% of 25 is 32.5: the boundary the client's amber starts at.
        assert.equal(degradedRun({failed: false, ping: 32.5, limits}), TRACE_REASONS.latency);
        assert.equal(degradedRun({failed: false, ping: 32.4, limits}), null);
    });

    it("judges the latency the way the screen prints it, to one decimal", () => {
        assert.equal(degradedRun({failed: false, ping: 32.449, limits}), null);
    });

    it("leaves a healthy run alone", () => {
        assert.equal(degradedRun({failed: false, baselineBreached: false, ping: 12, limits}), null);
        assert.equal(degradedRun({failed: false, baselineBreached: null, ping: 12, limits}), null);
    });

    it("judges no latency against an optimum nobody set, or one nobody measured", () => {
        assert.equal(degradedRun({failed: false, ping: 900, limits: resolveLimits(null, {})}), null);
        assert.equal(degradedRun({failed: false, ping: -1, limits}), null);
        assert.equal(degradedRun({failed: false, ping: null, limits}), null);
    });

    it("ranks a breached baseline above a slow ping", () => {
        assert.equal(degradedRun({failed: false, baselineBreached: true, ping: 900, limits}), TRACE_REASONS.baseline);
    });
});

/** A child process as the runner sees it: streams, an exit, and a kill it records. */
const fakeChild = () => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.exitCode = null;
    child.signalCode = null;
    child.signals = [];
    child.kill = (signal = "SIGTERM") => {
        child.signals.push(signal);
        return true;
    };
    child.finish = (output, code = 0) => {
        if (output) child.stdout.emit("data", Buffer.from(output));
        child.exitCode = code;
        child.emit("close", code);
    };
    return child;
};

/** A spawn that answers each file from a script, and records what it was asked. */
const fakeSpawn = (script) => {
    const calls = [];
    const spawn = (file, args, options) => {
        calls.push({file, args, options});
        const child = fakeChild();
        const behaviour = script[file] ?? (() => {});
        queueMicrotask(() => behaviour(child));
        return child;
    };
    spawn.calls = calls;
    return spawn;
};

const enoent = (child) => {
    const error = new Error(`spawn ${child.file ?? "tool"} ENOENT`);
    error.code = "ENOENT";
    child.emit("error", error);
    // Node emits 'close' after 'error' for a spawn that failed.
    child.emit("close", -2);
};

const TABLE = " 1  192.168.1.1  0.5 ms\n 2  203.0.113.10  9.1 ms\n";

describe("runTrace", () => {
    beforeEach(() => {
        resetMissingTools();
        trackProcess(null);
    });

    it("hands back the table the tool printed", async () => {
        const spawn = fakeSpawn({traceroute: (child) => child.finish(TABLE)});

        const hops = await runTrace("fra.example.net", {spawn, platform: "linux"});

        assert.deepEqual(hops.map((hop) => hop.address), ["192.168.1.1", "203.0.113.10"]);
        assert.equal(spawn.calls[0].file, "traceroute");
        assert.equal(spawn.calls[0].options.windowsHide, true);
        assert.equal(spawn.calls[0].options.shell, undefined, "a shell would parse the host");
    });

    it("falls through to the next tool when the first is not installed", async () => {
        const spawn = fakeSpawn({traceroute: enoent, tracepath: (child) => child.finish(" 1:  192.168.1.1  0.5ms\n")});

        const hops = await runTrace("fra.example.net", {spawn, platform: "linux"});

        assert.deepEqual(spawn.calls.map((call) => call.file), ["traceroute", "tracepath"]);
        assert.equal(hops[0].address, "192.168.1.1");
    });

    // A tool that is not there today is not there in an hour either, and a
    // failed spawn per degraded run would say so in the log every time.
    it("remembers a missing tool for the rest of the process", async () => {
        const spawn = fakeSpawn({traceroute: enoent, tracepath: enoent});

        assert.equal(await runTrace("fra.example.net", {spawn, platform: "linux"}), null);
        assert.equal(await runTrace("fra.example.net", {spawn, platform: "linux"}), null);

        assert.equal(spawn.calls.length, 2, "the missing tools were spawned again");
    });

    // A tool that is installed but refused - traceroute without the raw
    // socket it needs on a bare-metal install - prints its refusal to
    // stderr and nothing to stdout, and the next tool is the one the image
    // ships for exactly that case.
    it("falls through to the next tool when the first ran and printed no table", async () => {
        const spawn = fakeSpawn({traceroute: (child) => child.finish("", 1), tracepath: (child) => child.finish(" 1:  192.168.1.1  0.5ms\n")});

        const hops = await runTrace("fra.example.net", {spawn, platform: "linux"});

        assert.deepEqual(spawn.calls.map((call) => call.file), ["traceroute", "tracepath"]);
        assert.equal(hops[0].address, "192.168.1.1");
    });

    it("answers null when the tool ran and printed no table", async () => {
        const spawn = fakeSpawn({tracert: (child) => child.finish("Unable to resolve target system name nowhere.invalid.\r\n", 1)});

        assert.equal(await runTrace("nowhere.invalid", {spawn, platform: "win32"}), null);
    });

    // busybox's traceroute without a raw socket, or any other refusal: the
    // exit code says it failed, but a table it printed before failing is
    // still a table.
    it("keeps a table a failing exit still printed", async () => {
        const spawn = fakeSpawn({traceroute: (child) => child.finish(TABLE, 1)});

        assert.equal((await runTrace("fra.example.net", {spawn, platform: "linux"})).length, 2);
    });

    it("answers null for a host it could not hand to a tool", async () => {
        const spawn = fakeSpawn({});

        assert.equal(await runTrace("-h", {spawn, platform: "linux"}), null);
        assert.equal(await runTrace(null, {spawn, platform: "linux"}), null);
        assert.equal(spawn.calls.length, 0);
    });

    it("ends a tool that outlives its deadline and keeps what it printed", async () => {
        let held;
        const spawn = fakeSpawn({traceroute: (child) => {
            held = child;
            child.stdout.emit("data", Buffer.from(" 1  192.168.1.1  0.5 ms\n"));
        }});

        const pending = runTrace("fra.example.net", {spawn, platform: "linux", timeoutMs: 5});

        await new Promise((resolve) => setTimeout(resolve, 20));
        assert.deepEqual(held.signals, ["SIGTERM"], "the deadline passed and nothing was sent");

        held.finish("", null);
        const hops = await pending;

        assert.equal(hops.length, 1);
    });

    // Linux offers two tools, and a first that ends on its own with no table
    // falls through to the second - so a deadline handed to each tool let one
    // trace hold the round's latch for two of them.
    it("shares one deadline between the tools it falls through", async (t) => {
        const timeoutMs = 50;
        const firstToolDurationMs = 30;
        const boundaryStepMs = 1;
        const started = Date.now();
        t.mock.timers.enable({apis: ["Date", "setTimeout"], now: started});
        let second;
        const spawn = fakeSpawn({
            traceroute: (child) => setTimeout(() => child.finish("", 0), firstToolDurationMs),
            tracepath: (child) => { second = child; }
        });

        const pending = runTrace("fra.example.net", {spawn, platform: "linux", timeoutMs});

        // Drain spawn/close microtasks independently of wall-clock scheduling.
        await new Promise(setImmediate);
        t.mock.timers.tick(firstToolDurationMs);
        await new Promise(setImmediate);
        assert.ok(second, "the second tool was never asked");
        t.mock.timers.tick(timeoutMs - firstToolDurationMs - boundaryStepMs);
        assert.deepEqual(second.signals, [], "the second tool was stopped before the shared deadline");
        t.mock.timers.tick(boundaryStepMs);
        assert.deepEqual(second.signals, ["SIGTERM"], "the second tool was given a whole deadline of its own");

        second.finish("", null);
        assert.equal(await pending, null);
        assert.equal(Date.now() - started, timeoutMs, "the trace outlived its one deadline");
    });

    it("spawns no second tool once the deadline has passed", async () => {
        const spawn = fakeSpawn({
            traceroute: (child) => setTimeout(() => child.finish("", 0), 30)
        });

        assert.equal(await runTrace("fra.example.net", {spawn, platform: "linux", timeoutMs: 20}), null);
        assert.deepEqual(spawn.calls.map((call) => call.file), ["traceroute"]);
    });

    it("answers null for a deadline that passed before any hop", async () => {
        let held;
        const spawn = fakeSpawn({traceroute: (child) => { held = child; }});

        const pending = runTrace("fra.example.net", {spawn, platform: "linux", timeoutMs: 5});
        await new Promise((resolve) => setTimeout(resolve, 20));
        held.finish("", null);

        assert.equal(await pending, null);
    });

    it("stops reading a tool that will not stop printing", async () => {
        let held;
        const spawn = fakeSpawn({traceroute: (child) => {
            held = child;
            child.stdout.emit("data", Buffer.alloc(MAX_OUTPUT_BYTES + 1, "x"));
        }});

        const pending = runTrace("fra.example.net", {spawn, platform: "linux"});
        await new Promise((resolve) => setTimeout(resolve, 0));

        assert.deepEqual(held.signals, ["SIGTERM"], "the runaway output was read to the end");
        held.finish("", null);
        assert.equal(await pending, null);
    });

    // The trace runs after the speedtest CLI has exited, so the one slot the
    // shutdown terminates is free - and a trace must sit in it, or the Windows
    // service leaves tracert running after the server that started it is gone.
    it("is the process the shutdown terminates while it runs", async () => {
        let held;
        const spawn = fakeSpawn({traceroute: (child) => { held = child; }});

        const pending = runTrace("fra.example.net", {spawn, platform: "linux"});
        await new Promise((resolve) => setTimeout(resolve, 0));

        assert.equal(terminateActiveProcess(), true, "the trace is not tracked");
        assert.deepEqual(held.signals, ["SIGTERM"]);

        held.finish("", null);
        await pending;

        assert.equal(terminateActiveProcess(), false, "the finished trace is still tracked");
    });

    it("spawns nothing once the server is shutting down", async () => {
        const spawn = fakeSpawn({traceroute: (child) => child.finish(TABLE)});

        assert.equal(await runTrace("fra.example.net", {spawn, platform: "linux", isShuttingDown: () => true}), null);
        assert.equal(spawn.calls.length, 0);
    });

    it("survives a spawn that throws", async () => {
        const spawn = () => { throw new Error("EAGAIN"); };

        assert.equal(await runTrace("fra.example.net", {spawn, platform: "linux"}), null);
    });

    it("keeps its deadline inside a scheduled hour", () => {
        assert.ok(TRACE_TIMEOUT_MS <= 60_000, "a trace may outlast the gap to the next run");
    });
});
