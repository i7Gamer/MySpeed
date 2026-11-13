import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { probeAddress, PROBE_TIMEOUT } from "../../server/util/loadInterfaces.js";

/** An agent that records whether anything ever tore it down. */
const fakeAgent = () => {
    const agent = {
        options: null,
        destroyed: false,
        destroy() { this.destroyed = true; }
    };
    return agent;
};

/**
 * A scripted https.request. `outcome` decides how the probe ends, and every
 * request built is kept so the options it was given can be asserted on.
 */
const client = (outcome) => {
    const built = [];
    const agents = [];

    const Agent = function (options) {
        const agent = fakeAgent();
        agent.options = options;
        agents.push(agent);
        return agent;
    };

    const request = (options, onResponse) => {
        const handlers = {};
        const req = {
            destroyed: false,
            ended: false,
            on(event, handler) { handlers[event] = handler; return this; },
            destroy() { this.destroyed = true; },
            end() {
                this.ended = true;

                // Bun never fires the request's own `timeout` on a connect or
                // lookup that does not answer, so the request simply never
                // settles.
                if (outcome === "hung") return;

                // Settled on the next turn, as a real socket would.
                setImmediate(() => {
                    if (outcome === "answered") return onResponse({});
                    if (outcome === "refused") return handlers.error?.(new Error("ECONNREFUSED"));

                    // A silent server: the timeout fires and destroys the
                    // request, which emits ECONNRESET rather than nothing.
                    handlers.timeout?.();
                    handlers.error?.(new Error("socket hang up"));
                });
            }
        };

        built.push({options, req});
        return req;
    };

    return {request, Agent, built, agents};
};

/** Timers that record what was armed and cleared, and fire only on demand. */
const manualTimers = () => {
    const armed = new Map();
    let nextId = 0;

    return {
        armed,
        setTimeout(callback, delay) {
            const id = ++nextId;
            armed.set(id, {callback, delay});
            return id;
        },
        clearTimeout(id) { armed.delete(id); },
        fireAll() {
            for (const [id, {callback}] of armed) {
                armed.delete(id);
                callback();
            }
        }
    };
};

const probe = (outcome, address = "192.168.1.10", family = 4, timers = undefined) => {
    const scripted = client(outcome);
    return {scripted, result: probeAddress(address, family, {...scripted, timers})};
};

/**
 * Every probe built an https.Agent and nothing ever destroyed one.
 *
 * A fresh Agent per address, per round - and requestInterfaces runs on an
 * interval for the life of the process, not just at boot. Node keeps agents
 * alive with keep-alive on by default, so each one holds its idle socket open
 * for its own timeout, and the sockets accumulate on a machine with several
 * adapters. Nothing breaks; the process simply holds more than it needs to,
 * indefinitely, and the count only ever goes up.
 */
describe("probing one address", () => {
    it("destroys the agent when the probe answers", async () => {
        const {scripted, result} = probe("answered");

        assert.equal(await result, true);
        assert.equal(scripted.agents.length, 1);
        assert.equal(scripted.agents[0].destroyed, true, "the agent was left holding its socket open");
    });

    it("destroys the agent when the probe is refused", async () => {
        const {scripted, result} = probe("refused");

        assert.equal(await result, false);
        assert.equal(scripted.agents[0].destroyed, true,
            "a failed probe leaks its agent, which is every probe on an adapter that cannot reach the internet");
    });

    it("destroys the agent when the probe times out", async () => {
        const {scripted, result} = probe("silent");

        assert.equal(await result, false);
        assert.equal(scripted.agents[0].destroyed, true);
    });

    it("builds one agent per probe, and hands that one to the request", async () => {
        const {scripted, result} = probe("answered");
        await result;

        assert.equal(scripted.agents.length, 1);
        assert.equal(scripted.built[0].options.agent, scripted.agents[0]);
    });

    // The whole point of the probe: it asks whether *this* address can reach
    // the internet, which only means anything if the socket is bound to it.
    it("binds the request to the address being probed", async () => {
        const {scripted, result} = probe("answered", "10.0.0.5");
        await result;

        assert.equal(scripted.built[0].options.localAddress, "10.0.0.5");
    });

    it("probes over the address family it was given", async () => {
        const {scripted, result} = probe("answered", "fe80::1", 6);
        await result;

        assert.equal(scripted.built[0].options.family, 6);
    });

    it("arms a timeout, so a silent server cannot hold the round open", async () => {
        const {scripted, result} = probe("answered");
        await result;

        assert.equal(scripted.built[0].options.timeout, PROBE_TIMEOUT);
        assert.ok(PROBE_TIMEOUT > 0 && Number.isFinite(PROBE_TIMEOUT));
    });

    it("closes the request it opened once the answer is in", async () => {
        const {scripted, result} = probe("answered");
        await result;

        assert.equal(scripted.built[0].req.destroyed, true, "the probe response was left unread");
    });

    /*
     * Issue #135. The request's `timeout` option is Node's socket idle timer,
     * and Bun - which every release runs on - never fires it while a connect
     * or a lookup is still waiting. requestInterfaces is awaited during
     * start-up, so a probe that cannot settle on its own must still be ended
     * by a deadline the probe keeps itself.
     */
    describe("when the request never settles on its own", () => {
        it("gives up once its own deadline passes, and reports no answer", async () => {
            const timers = manualTimers();
            const {result} = probe("hung", "192.168.1.10", 4, timers);

            assert.equal(timers.armed.size, 1, "no deadline was armed");
            assert.equal([...timers.armed.values()][0].delay, PROBE_TIMEOUT);

            timers.fireAll();

            assert.equal(await result, false);
        });

        it("tears down the request and the agent it gave up on", async () => {
            const timers = manualTimers();
            const {scripted, result} = probe("hung", "192.168.1.10", 4, timers);

            timers.fireAll();
            await result;

            assert.equal(scripted.built[0].req.destroyed, true, "the abandoned request kept its socket");
            assert.equal(scripted.agents[0].destroyed, true);
        });

        it("settles on real timers when none are injected", async () => {
            // A mistake wiring up the default timers shows here as a probe
            // that never returns, which node:test reports as a pending test.
            const scripted = client("hung");
            const SHORT_DEADLINE_MS = 1;

            assert.equal(await probeAddress("192.168.1.10", 4, {...scripted, deadline: SHORT_DEADLINE_MS}), false);
        });
    });

    for (const outcome of ["answered", "refused", "silent"])
        it(`clears its deadline once the probe has ${outcome === "silent" ? "timed out" : outcome}`, async () => {
            const timers = manualTimers();
            const {result} = probe(outcome, "192.168.1.10", 4, timers);

            await result;

            assert.equal(timers.armed.size, 0, "a settled probe left a timer behind");
        });

    it("sends the request rather than building one and stopping", async () => {
        const {scripted, result} = probe("answered");
        await result;

        assert.equal(scripted.built[0].req.ended, true);
    });
});
