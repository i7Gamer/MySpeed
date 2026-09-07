import { beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { MAX_TRACES_PER_ROUND, TRACEROUTE_KEY, diagnoseRun, resetTraceBudget } from "../../server/tasks/hopDiagnostics.js";
import { TRACE_REASONS } from "../../server/util/traceroute.js";

/*
 * The one entry point the run loop calls after every member, success or
 * failure. It decides whether the run was degraded, where to trace to, runs
 * the trace and writes the table onto the row - and it never throws, because
 * it sits at the tail of a path whose catch would otherwise record a second
 * failure about a row that measured perfectly well.
 */

const HOPS = [{hop: 1, address: "192.168.1.1", rtt: [1], lost: 0}];

/** Every collaborator recorded, with the switch on and the trace answering. */
const harness = ({enabled = "true", hops = HOPS, ping = "25", servers = {}} = {}) => {
    const calls = {traced: [], saved: [], logged: [], errors: []};

    const deps = {
        getValue: async (key) => (key === TRACEROUTE_KEY ? enabled : key === "ping" ? ping : "none"),
        trace: async (host) => { calls.traced.push(host); return hops; },
        save: async (id, table) => { calls.saved.push({id, table}); },
        servers: () => servers,
        log: {log: (line) => calls.logged.push(line), error: (line) => calls.errors.push(line)}
    };

    return {calls, deps};
};

const test = {id: 42};
const target = {id: 7, name: "Home", provider: "ookla", serverId: null};

describe("diagnoseRun", () => {
    beforeEach(resetTraceBudget);

    it("traces a final failure and writes the table onto the row", async () => {
        const {calls, deps} = harness();

        const outcome = await diagnoseRun(test, target, {failed: true}, deps);

        assert.deepEqual(calls.traced, ["www.speedtest.net"]);
        assert.deepEqual(calls.saved, [{id: 42, table: HOPS}]);
        assert.equal(outcome.reason, TRACE_REASONS.failed);
        assert.equal(calls.logged.length, 1, "a trace that ran leaves no line in the log");
    });

    it("traces a success whose latency missed the optimum, to the server it used", async () => {
        const {calls, deps} = harness();

        const outcome = await diagnoseRun(test, target, {ping: 80, serverHost: "fra.example.net:8080"}, deps);

        assert.deepEqual(calls.traced, ["fra.example.net"]);
        assert.equal(outcome.reason, TRACE_REASONS.latency);
    });

    it("judges the latency against the target's own optimum before the instance's", async () => {
        const {calls, deps} = harness({ping: "25"});

        await diagnoseRun(test, {...target, optimalPing: 200}, {ping: 80, serverHost: "fra.example.net"}, deps);

        assert.deepEqual(calls.traced, [], "80 ms is well under a 200 ms optimum");
    });

    it("traces a success that fell under its baseline", async () => {
        const {calls, deps} = harness();

        const outcome = await diagnoseRun(test, target, {ping: 10, baselineBreached: true, serverHost: "fra.example.net"}, deps);

        assert.equal(calls.traced.length, 1);
        assert.equal(outcome.reason, TRACE_REASONS.baseline);
    });

    it("does nothing for a healthy run", async () => {
        const {calls, deps} = harness();

        assert.equal(await diagnoseRun(test, target, {ping: 10, baselineBreached: false, serverHost: "fra.example.net"}, deps), null);
        assert.deepEqual(calls.traced, []);
        assert.deepEqual(calls.saved, []);
    });

    // The switch is the first thing read: an instance that never turned this
    // on pays one config read per run and nothing else - not even the
    // optimum lookup.
    it("does nothing while the switch is off, before reading anything else", async () => {
        const read = [];
        const {calls, deps} = harness({enabled: "false"});
        const getValue = deps.getValue;
        deps.getValue = async (key) => { read.push(key); return getValue(key); };

        assert.equal(await diagnoseRun(test, target, {failed: true}, deps), null);
        assert.deepEqual(read, [TRACEROUTE_KEY]);
        assert.deepEqual(calls.traced, []);
    });

    it("leaves a rate-limited failure alone", async () => {
        const {calls, deps} = harness();

        assert.equal(await diagnoseRun(test, target, {failed: true, rateLimited: true}, deps), null);
        assert.deepEqual(calls.traced, []);
    });

    it("never traces a preview run", async () => {
        const {calls, deps} = harness();

        assert.equal(await diagnoseRun(test, {...target, provider: "preview"}, {failed: true}, deps), null);
        assert.deepEqual(calls.traced, []);
    });

    it("writes nothing when the trace produced no table", async () => {
        const {calls, deps} = harness({hops: null});

        assert.equal(await diagnoseRun(test, target, {failed: true}, deps), null);
        assert.deepEqual(calls.saved, []);
    });

    it("finds the pinned ookla server through the server list", async () => {
        const servers = {"1234": {name: "Frankfurt", host: "fra.example.net:8080"}};
        const {calls, deps} = harness({servers});

        await diagnoseRun(test, {...target, serverId: "1234"}, {failed: true}, deps);

        assert.deepEqual(calls.traced, ["fra.example.net"]);
    });

    it("writes nothing for a target with nowhere to trace to", async () => {
        const {calls, deps} = harness();

        assert.equal(await diagnoseRun(test, {...target, provider: "iperf3", endpoint: null}, {failed: true}, deps), null);
        assert.deepEqual(calls.traced, []);
    });

    describe("never throws", () => {
        it("when the config cannot be read", async () => {
            const {calls, deps} = harness();
            deps.getValue = async () => { throw new Error("database is locked"); };

            assert.equal(await diagnoseRun(test, target, {failed: true}, deps), null);
            assert.equal(calls.errors.length, 1);
            assert.match(calls.errors[0], /database is locked/);
        });

        it("when the trace rejects", async () => {
            const {calls, deps} = harness();
            deps.trace = async () => { throw new Error("EAGAIN"); };

            assert.equal(await diagnoseRun(test, target, {failed: true}, deps), null);
            assert.equal(calls.errors.length, 1);
        });

        it("when the row cannot be updated", async () => {
            const {calls, deps} = harness();
            deps.save = async () => { throw new Error("SQLITE_BUSY"); };

            assert.equal(await diagnoseRun(test, target, {failed: true}, deps), null);
            assert.equal(calls.errors.length, 1);
            assert.match(calls.errors[0], /#42/);
        });
    });
});

/**
 * A round of five degraded members would otherwise spend five full trace
 * deadlines inside the running latch, and a cron tick in that window is a
 * scheduled run dropped. The round opens a budget of a few traces; a
 * member past it is skipped and says so.
 */
describe("the round's trace budget", () => {
    beforeEach(resetTraceBudget);

    it("is a small number of traces", () => {
        assert.ok(Number.isInteger(MAX_TRACES_PER_ROUND) && MAX_TRACES_PER_ROUND >= 1 && MAX_TRACES_PER_ROUND <= 3);
    });

    it("traces the first members of a round and skips the rest, saying so", async () => {
        const {calls, deps} = harness();

        for (let i = 0; i < MAX_TRACES_PER_ROUND + 2; i++)
            await diagnoseRun({id: i}, target, {failed: true}, deps);

        assert.equal(calls.traced.length, MAX_TRACES_PER_ROUND);
        assert.equal(calls.saved.length, MAX_TRACES_PER_ROUND);
        assert.equal(calls.logged.length, MAX_TRACES_PER_ROUND + 2, "a skipped member leaves no line");
        assert.match(calls.logged.at(-1), /budget/);
    });

    it("opens again with the next round", async () => {
        const {calls, deps} = harness();

        for (let i = 0; i < MAX_TRACES_PER_ROUND; i++) await diagnoseRun({id: i}, target, {failed: true}, deps);
        resetTraceBudget();
        await diagnoseRun({id: 99}, target, {failed: true}, deps);

        assert.equal(calls.traced.length, MAX_TRACES_PER_ROUND + 1);
    });

    it("is not spent by a member that needed no trace", async () => {
        const {calls, deps} = harness();

        for (let i = 0; i < MAX_TRACES_PER_ROUND + 2; i++) await diagnoseRun({id: i}, target, {ping: 5}, deps);
        await diagnoseRun({id: 99}, target, {failed: true}, deps);

        assert.equal(calls.traced.length, 1);
    });

    // Neither is a trace that found no table: the tool ran, the deadline
    // was spent, and that is what the budget counts.
    it("is spent by a trace that found nothing", async () => {
        const {calls, deps} = harness({hops: null});

        for (let i = 0; i < MAX_TRACES_PER_ROUND + 1; i++) await diagnoseRun({id: i}, target, {failed: true}, deps);

        assert.equal(calls.traced.length, MAX_TRACES_PER_ROUND);
    });
});
