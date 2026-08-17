import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { probeAll, resolveFallback, ROUNDS_BEFORE_FALLBACK } from "../../server/util/loadInterfaces.js";

const adapter = (name, addresses) => [name, addresses.map((address) => ({
    address, family: address.includes(":") ? "IPv6" : "IPv4", internal: false
}))];

const adapters = (...entries) => Object.fromEntries(entries);

/**
 * Every address is probed, and the probe is a network round trip that only ends
 * on an answer or on PROBE_TIMEOUT.
 *
 * Awaited one at a time, the cost of a round was the number of addresses times
 * five seconds - and requestInterfaces is awaited before app.listen(), so that
 * is time the port is not open. A Windows host with Hyper-V, a VPN and Docker
 * carries a good handful of adapters that answer nothing, which is where this
 * was noticed: the service takes the better part of a minute to start serving.
 * Nothing about the probes needs ordering; they are independent by construction.
 */
describe("probing the adapters", () => {
    /** A probe that records how many were ever running at once. */
    const countingProbe = (answer = () => true) => {
        let running = 0;
        let peak = 0;
        const seen = [];

        const probe = async (address, family) => {
            running++;
            peak = Math.max(peak, running);
            seen.push({address, family});

            // A turn of the loop, so a caller that awaits each one in turn can
            // never have two in flight and a caller that does not, will.
            await new Promise((resolve) => setImmediate(resolve));

            running--;
            return answer(address);
        };

        return {probe, peak: () => peak, seen: () => seen};
    };

    it("probes every address at once rather than one after another", async () => {
        const {probe, peak} = countingProbe();

        await probeAll(adapters(
            adapter("eth0", ["192.168.1.10"]),
            adapter("wg0", ["10.8.0.2"]),
            adapter("docker0", ["172.17.0.1"]),
            adapter("vEthernet", ["192.168.99.1"])
        ), probe);

        assert.equal(peak(), 4, "the probes were awaited one at a time");
    });

    it("keeps only the addresses that answered, under their adapter", async () => {
        const {probe} = countingProbe((address) => address !== "10.8.0.2");

        const probed = await probeAll(adapters(
            adapter("eth0", ["192.168.1.10"]),
            adapter("wg0", ["10.8.0.2"])
        ), probe);

        assert.deepEqual(probed, {eth0: ["192.168.1.10"]});
    });

    it("keeps an adapter's addresses in the order they were reported", async () => {
        const {probe} = countingProbe();

        const probed = await probeAll(adapters(
            adapter("eth0", ["fe80::1", "192.168.1.10"])
        ), probe);

        assert.deepEqual(probed, {eth0: ["fe80::1", "192.168.1.10"]});
    });

    it("never probes a loopback address", async () => {
        const {probe, seen} = countingProbe();

        await probeAll({lo: [{address: "127.0.0.1", family: "IPv4", internal: true}]}, probe);

        assert.deepEqual(seen(), []);
    });

    it("asks for the family the address belongs to", async () => {
        const {probe, seen} = countingProbe();

        await probeAll(adapters(adapter("eth0", ["192.168.1.10", "fe80::1"])), probe);

        assert.deepEqual(seen().map((entry) => entry.family), [4, 6]);
    });
});

/**
 * Falling back writes to the configuration, and that write is one-way: nothing
 * else sets the key, so once the operator's pinned adapter has been replaced it
 * stays replaced - the guard reads the *new* value as present and never fires
 * again.
 *
 * The trigger was one round in which the adapter was absent from the operating
 * system, which is what a tunnel that is being restarted looks like. So a
 * `wg-quick down` landing on the hourly refresh permanently repointed every
 * later measurement off the VPN and onto the bare WAN link, measuring something
 * the operator never asked for, with the interface dialog showing the new
 * choice as though they had made it.
 */
describe("deciding whether to fall back", () => {
    const available = ["eth0", "wlan0"];

    it("does nothing while the configured adapter is there", () => {
        assert.deepEqual(resolveFallback("wlan0", available, 0), {missingRounds: 0, write: null});
    });

    it("clears a run of absences the moment it comes back", () => {
        assert.deepEqual(resolveFallback("wlan0", available, 2), {missingRounds: 0, write: null});
    });

    it("waits rather than rewriting the first time it is missing", () => {
        assert.deepEqual(resolveFallback("wg0", available, 0), {missingRounds: 1, write: null});
    });

    it("still waits one round short of the limit", () => {
        const {write} = resolveFallback("wg0", available, ROUNDS_BEFORE_FALLBACK - 2);

        assert.equal(write, null);
    });

    it("falls back once it has been missing for the whole run of rounds", () => {
        assert.deepEqual(resolveFallback("wg0", available, ROUNDS_BEFORE_FALLBACK - 1),
            {missingRounds: 0, write: "eth0"});
    });

    // Nothing pinned is not a choice to protect: a fresh install has no
    // interface set and should pick one on its first round, as it always did.
    it("picks one straight away when nothing is configured", () => {
        assert.deepEqual(resolveFallback("", available, 0), {missingRounds: 0, write: "eth0"});
        assert.deepEqual(resolveFallback(undefined, available, 0), {missingRounds: 0, write: "eth0"});
    });

    // With nothing detected there is nothing to fall back to, and overwriting a
    // good setting with undefined is worse than leaving it.
    it("keeps the configured one when there is nothing to move to", () => {
        assert.deepEqual(resolveFallback("wg0", [], ROUNDS_BEFORE_FALLBACK - 1),
            {missingRounds: 0, write: null});
    });

    it("does not invent one when nothing is configured either", () => {
        assert.deepEqual(resolveFallback("", [], 0), {missingRounds: 0, write: null});
    });
});
