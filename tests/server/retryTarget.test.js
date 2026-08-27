import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { serversFor } from "../../server/tasks/speedtest.js";

/**
 * Which server a run measures against, and which one its retry measures
 * against.
 *
 * The automatic retry exists to fall back from a pinned server to whichever
 * one the provider chooses: a pin is a preference - "measure against this one
 * of theirs" - and an attempt that fails against it is worth repeating without
 * it. The fallback dropped the target's `endpoint` alongside the pin, and an
 * endpoint is not a preference. It is which line is being measured.
 *
 * So a librespeed target with a custom backend that failed once was retried
 * against the *public* fleet, that attempt succeeded, and the row was committed
 * under the failing target's id: the history then said the operator's own
 * backend delivered a number it never produced. Nothing about the row said
 * which server it came from, because a target with an endpoint records no
 * server id.
 *
 * These assert on the decision rather than on the call, which is why it is a
 * function of its own: the two existing retry suites pin the *condition* of the
 * retry by reading the source, and neither could see which arguments it ran
 * with.
 */
describe("the server a run measures against", () => {
    const pinned = {provider: "ookla", serverId: "1234", endpoint: null};
    const backend = {provider: "libre", serverId: null, endpoint: "https://speed.example.net"};
    const iperf = {provider: "iperf3", serverId: null, endpoint: "10.0.0.4:5201"};

    it("measures against the pinned server on the first attempt", () => {
        assert.deepEqual(serversFor(pinned, false), {serverId: "1234", serverUrl: undefined});
    });

    it("drops the pin on the retry, which is the whole point of the fallback", () => {
        assert.deepEqual(serversFor(pinned, true), {serverId: undefined, serverUrl: undefined});
    });

    it("measures against the target's own backend on the first attempt", () => {
        assert.deepEqual(serversFor(backend, false),
            {serverId: undefined, serverUrl: "https://speed.example.net"});
    });

    /**
     * The regression this suite is here for. A retry that drops the endpoint
     * measures somebody else's line and stores the answer as this target's.
     */
    it("keeps the target's own backend on the retry", () => {
        assert.deepEqual(serversFor(backend, true),
            {serverId: undefined, serverUrl: "https://speed.example.net"});
    });

    it("keeps an iperf3 host on the retry, which has no fleet to fall back to", () => {
        assert.deepEqual(serversFor(iperf, true), {serverId: undefined, serverUrl: "10.0.0.4:5201"});
    });

    /**
     * An endpoint already says which server, so a pin sent alongside it is a
     * second answer to a question that has one. Held on the retry too, where
     * the pin is dropped anyway - the assertion is that the endpoint is what
     * survives, not the id.
     */
    it("never sends a pin alongside an endpoint", () => {
        const both = {provider: "libre", serverId: "999", endpoint: "https://speed.example.net"};

        assert.deepEqual(serversFor(both, false),
            {serverId: undefined, serverUrl: "https://speed.example.net"});
        assert.deepEqual(serversFor(both, true),
            {serverId: undefined, serverUrl: "https://speed.example.net"});
    });

    // The ordinary case: a target that pins nothing and carries no backend of
    // its own, on a provider that chooses for itself.
    it("has nothing to send for a target that carries neither", () => {
        const plain = {provider: "cloudflare", serverId: null, endpoint: null};

        assert.deepEqual(serversFor(plain, false), {serverId: undefined, serverUrl: undefined});
        assert.deepEqual(serversFor(plain, true), {serverId: undefined, serverUrl: undefined});
    });

    // null and undefined both mean "not set" here, and the runner is handed
    // undefined for both: a null reaching the argument list is a value the
    // provider's buildArgs would have to know to ignore.
    it("normalises an absent value to undefined either way", () => {
        assert.deepEqual(serversFor({provider: "ookla"}, false),
            {serverId: undefined, serverUrl: undefined});
    });
});
