import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { retiredByPatch, targetProblem } from "../../server/controller/targets.js";

/**
 * The columns a PATCH retires without naming them.
 *
 * The door judges the row a request would LEAVE BEHIND, which is right - a
 * PATCH carrying only `{endpoint}` has to be held against the provider it will
 * run under. But `update()` writes only the columns the request named, so a
 * fragment was judged against fields it never sent and refused for them:
 *
 *   PATCH {provider: "ookla"}  -> "This provider takes no iperf3 tuning"
 *   PATCH {iperfUdp: false}    -> "A bitrate applies only to a UDP run"
 *
 * Both name a field the request did not carry, and to get past them a caller
 * had to null four columns it was not editing. The dialog never hit it - it
 * sends the whole tuning block every time - so this was an API-only dead end
 * and a trap for the next caller that sends a minimal patch.
 *
 * Same shape as the `renames` door above it in the route, which was fixed for
 * the same reason: a check about what a request DOES must not be asked of
 * values the request is implicitly retiring.
 */
describe("retiredByPatch", () => {
    const iperf = {
        id: 1, name: "NAS", provider: "iperf3", endpoint: "10.0.0.5:5201",
        iperfDuration: 30, iperfStreams: 4, iperfUdp: true, iperfBitrate: 500
    };

    it("retires the whole run shape when the provider stops being iperf3", () => {
        const retired = retiredByPatch(iperf, {provider: "ookla"});

        assert.deepEqual(retired, {
            endpoint: null, iperfDuration: null, iperfStreams: null,
            iperfUdp: false, iperfBitrate: null
        });
    });

    /**
     * The endpoint goes with them, because it is refused on its own terms -
     * "This provider takes no endpoint" - and a caller moving to ookla is not
     * asking to keep a host it can no longer reach.
     */
    it("keeps the endpoint where the new provider still takes one", () => {
        assert.equal(Object.hasOwn(retiredByPatch(iperf, {provider: "libre"}), "endpoint"), false,
            "a libre target lost the backend URL it is allowed to carry");
    });

    it("retires the bitrate when the run stops sending datagrams", () => {
        assert.deepEqual(retiredByPatch(iperf, {iperfUdp: false}), {iperfBitrate: null});
    });

    /**
     * Only what the request did NOT name. A caller that sends a contradiction
     * on purpose - datagrams off and a bitrate in the same breath - still
     * earns the refusal that names it, rather than having half of it quietly
     * dropped.
     */
    it("never retires a column the request itself carried", () => {
        assert.deepEqual(retiredByPatch(iperf, {iperfUdp: false, iperfBitrate: 500}), {});
        assert.equal(Object.hasOwn(retiredByPatch(iperf, {provider: "ookla", endpoint: "x"}),
            "endpoint"), false);
    });

    // A patch about something else entirely retires nothing: the columns are
    // still meaningful under the provider the row keeps.
    it("retires nothing from a patch that changes neither", () => {
        for (const fields of [{enabled: false}, {name: "NAS 2"}, {iperfDuration: 20}])
            assert.deepEqual(retiredByPatch(iperf, fields), {},
                `${JSON.stringify(fields)} retired a column it had no business touching`);
    });

    // And nothing on a target that was never iperf3 - there is no run shape to
    // retire, and `iperfUdp: false` is what such a row already stores.
    it("retires nothing from a target that carries no run shape", () => {
        const ookla = {id: 2, name: "Ookla", provider: "ookla", endpoint: null, iperfUdp: false};

        assert.deepEqual(retiredByPatch(ookla, {provider: "libre"}), {});
        assert.deepEqual(retiredByPatch(ookla, {iperfUdp: false}), {});
    });
});

/**
 * And the pair the door refused, now that the merged row is the one the write
 * would actually produce.
 */
describe("the patches that were dead ends", () => {
    const iperf = {
        id: 1, name: "NAS", provider: "iperf3", endpoint: "10.0.0.5:5201",
        iperfDuration: 30, iperfStreams: 1, iperfUdp: true, iperfBitrate: 500,
        alerts: true, enabled: true
    };

    const merged = (fields) => ({...iperf, ...fields, ...retiredByPatch(iperf, fields)});

    it("lets a target move off iperf3 without nulling four columns by hand", () => {
        assert.equal(targetProblem(merged({provider: "ookla"})), null);
    });

    it("lets a UDP run be turned off", () => {
        assert.equal(targetProblem(merged({iperfUdp: false})), null);
    });

    // The refusals that should still stand, so the retirement has not simply
    // switched the door off.
    it("still refuses a contradiction the request states itself", () => {
        assert.notEqual(targetProblem(merged({iperfUdp: false, iperfBitrate: 500})), null,
            "a bitrate on a run that sends no datagrams was allowed through");
        assert.notEqual(targetProblem(merged({provider: "ookla", iperfDuration: 30})), null,
            "run tuning on a provider that has no run shape was allowed through");
    });
});

/**
 * A pinned server is retired the same way an endpoint is.
 *
 * The endpoint had this and the server id did not, so moving an ookla target
 * with a pinned server to a provider that has no server list was a dead end:
 * the merged row still carried the id, and the door refuses one on a provider
 * that cannot pin - "This provider has no servers to pin", 400. The only way
 * through was to know to send `serverId: null` alongside, which the API says
 * nowhere.
 */
describe("a server id under a provider that has none", () => {
    const pinned = {id: 3, name: "Ookla US", provider: "ookla", serverId: "1234",
        endpoint: null, iperfUdp: false, alerts: true, enabled: true};

    it("is retired when the provider moves to one with no server list", () => {
        assert.equal(retiredByPatch(pinned, {provider: "cloudflare"}).serverId, null,
            "the id survived a move to a provider that cannot pin one");
    });

    it("is left alone when both providers carry server lists", () => {
        assert.equal(Object.hasOwn(retiredByPatch(pinned, {provider: "libre"}), "serverId"), false,
            "the id was cleared moving between two providers that both pin");
    });

    it("is left alone when the caller names one itself", () => {
        // The retirement only fills in what the request did not say.
        assert.equal(Object.hasOwn(retiredByPatch(pinned, {provider: "cloudflare", serverId: "9"}),
            "serverId"), false);
    });

    it("lets the move through the door it used to fail at", () => {
        const merged = (fields) => ({...pinned, ...fields, ...retiredByPatch(pinned, fields)});

        assert.equal(targetProblem(merged({provider: "cloudflare"})), null);
    });
});
