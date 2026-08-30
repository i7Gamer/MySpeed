import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { stripConnectionIdentity } from "../../server/util/connectionIdentity.js";

/**
 * Who the connection is - the operator's provider and external address - is
 * stored for the operator and withheld from read-only viewers: an instance
 * shared as a public dashboard must not tell every visitor where its owner
 * lives on the network.
 */
describe("stripConnectionIdentity", () => {
    const row = () => ({id: 1, ping: 10, isp: "Salt Mobile", externalIp: "203.0.113.7",
        resultId: "f2cfac79", error: null});

    it("nulls the provider and the address", () => {
        const stripped = stripConnectionIdentity(row());

        assert.equal(stripped.isp, null);
        assert.equal(stripped.externalIp, null);
    });

    /**
     * The result id is identity through a side door: it links to the
     * provider's public result page, which names the ISP and the rough
     * location - the very things the masking withholds.
     *
     * Deleted rather than nulled, unlike the other two, because absence is
     * what a row without a result already looks like: every list path strips
     * a null resultId key, so a null here would say "there is a result you
     * cannot see" where deletion says nothing at all.
     */
    it("removes the link to the provider's public result page", () => {
        const stripped = stripConnectionIdentity(row());

        assert.equal("resultId" in stripped, false);
    });

    it("touches nothing else", () => {
        const {isp, externalIp, ...rest} = stripConnectionIdentity(row());

        assert.deepEqual(rest, {id: 1, ping: 10, error: null});
    });

    // The routes hand the same object on to res.json, so the contract is
    // mutate-in-place and return it.
    it("mutates and returns the same object", () => {
        const original = row();

        assert.equal(stripConnectionIdentity(original), original);
        assert.equal(original.isp, null);
    });

    // Null rather than deleted, and set even where the column never existed: a
    // masked row must be byte-identical to one that never measured anything, or
    // the response itself tells a viewer that something was withheld.
    it("makes a masked row indistinguishable from an unmeasured one", () => {
        const stripped = stripConnectionIdentity({id: 2, ping: 12});

        assert.equal(stripped.isp, null);
        assert.equal(stripped.externalIp, null);
        assert.equal("resultId" in stripped, false);
    });

    // The status route builds `lastTest: null` on an install that has never run
    // a test, and masking must not turn that into a crash.
    it("passes a missing row through", () => {
        assert.equal(stripConnectionIdentity(null), null);
        assert.equal(stripConnectionIdentity(undefined), undefined);
    });
});

/**
 * The address of a server the operator runs, which reaches a viewer by the row
 * rather than by the target.
 *
 * GET /api/targets already withholds `endpoint` and `serverId` from an
 * untrusted reader, for the reason its own comment gives: the endpoint can
 * carry a credential in its userinfo, and a server id says where the line is.
 * But an iperf3 run copies that same host:port into the row's `serverHost`, and
 * a custom librespeed run copies its backend URL there - so the address the
 * targets route refuses to give a viewer was handed to the same viewer by
 * /api/speedtests, by the CSV export, and by the dashboard's own status
 * payload.
 *
 * Only the two providers whose "server" is a machine the operator runs. An
 * ookla or cloudflare host is a public endpoint out of a published list, and
 * masking it would withhold something a viewer can read off the provider's own
 * website while telling them a measurement was hidden.
 */
describe("the server address a viewer may know", () => {
    const withHost = (provider, serverHost) =>
        stripConnectionIdentity({id: 1, ping: 10, provider, serverHost});

    it("withholds an iperf3 host, which is always a machine the operator runs", () => {
        assert.equal(withHost("iperf3", "10.0.0.4:5201").serverHost, null);
    });

    it("withholds a librespeed backend, which can carry a credential", () => {
        assert.equal(withHost("libre", "https://user:pass@speed.internal").serverHost, null);
    });

    it("leaves a public provider's server alone", () => {
        assert.equal(withHost("ookla", "speedtest.arcade.ch").serverHost, "speedtest.arcade.ch");
        assert.equal(withHost("cloudflare", "speed.cloudflare.com").serverHost, "speed.cloudflare.com");
    });

    /**
     * Nulled rather than deleted, for the reason the two above it are: a masked
     * row must look exactly like one whose provider reported no host, or the
     * shape of the response says something was withheld.
     */
    it("nulls the host rather than removing it", () => {
        const stripped = withHost("iperf3", "10.0.0.4:5201");

        assert.equal("serverHost" in stripped, true);
        assert.equal(stripped.serverHost, null);
    });

    // Rows from before targets existed carry no provider at all, and a row that
    // measured nothing carries no host. Neither may throw.
    it("passes a row with no provider or no host through", () => {
        assert.equal(stripConnectionIdentity({id: 1, serverHost: "speedtest.arcade.ch"}).serverHost,
            "speedtest.arcade.ch");
        assert.equal(stripConnectionIdentity({id: 1, provider: "iperf3"}).serverHost, null);
    });
});
