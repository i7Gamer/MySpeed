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

const probe = (outcome, address = "192.168.1.10", family = 4) => {
    const scripted = client(outcome);
    return {scripted, result: probeAddress(address, family, scripted)};
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

    it("sends the request rather than building one and stopping", async () => {
        const {scripted, result} = probe("answered");
        await result;

        assert.equal(scripted.built[0].req.ended, true);
    });
});
