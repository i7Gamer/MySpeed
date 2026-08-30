import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { iperfHostAccepted } from "@/common/components/TargetsDialog/providerFields.js";
import { iperfEndpointProblem } from "../../server/controller/targets.js";

/**
 * The client's question and the server's answer, held to be the same question.
 *
 * The wizard's provider step and the target editor both used to ask only "is
 * the host non-empty", while the server holds it to iperfEndpointProblem's
 * shape - so any host the server refuses trapped the operator behind a Done
 * button that always fails, on a step where the offending field was no longer
 * rendered and there was no Back. iperfHostAccepted is a copy of the server's
 * algorithm, and a copy can go stale; this table is what stops that, the way
 * quietHoursParity holds the two isQuietHour implementations together.
 */

// Hosts judged whole, with no port appended: names, literals, and every
// spelling of junk the two sides must refuse identically - the bracket-misuse
// spellings included, which both sides used to accept and splitEndpoint then
// dialled verbatim.
const WHOLE_HOSTS = ["10.0.0.5", "nas.lan", "localhost", "fd00::1", "fd00::1:5201",
    "[fd00::1]", "[fd00::1", "[fd00::1:5201", "fd00::1]", "nas[0].lan",
    "[fd00::1]x:5201", "[[fd00::1]]", "[]", "[]:5201", ":5201", "", "   ", "nas lan",
    "http://iperf.lan:5201", "iperf.lan/path", "user@nas.lan", " 10.0.0.5:5201 "];

/**
 * The port half as a cross product rather than a hand-written list.
 *
 * The mutation this shape exists to catch: the first version listed port cases
 * only for a bare host, so the bracketed branch of the port rule - the single
 * line that separates "[fd00::1]:0" from "[fd00::1]" - had no case at all, and
 * deleting it left the suite green. Crossing every port shape with every host
 * spelling means adding a port case asks it of the bracketed host
 * automatically, so that gap cannot reopen by someone adding a case in the
 * obvious place.
 */
const HOSTS_TAKING_A_PORT = ["10.0.0.5", "nas.lan", "[fd00::1]"];
const PORTS = ["5201", "1", "65535", "0", "65536", "000005", "", "52a1", "-1",
    "0x10", "5e3", "+5201", "5201.5"];

// Floors, so the table cannot be quietly emptied. They cannot make it
// complete - only keep it from vanishing.
const MIN_WHOLE_HOSTS = 12;
const MIN_HOSTS_TAKING_A_PORT = 2;
const MIN_PORTS = 8;

const HOSTS = [...WHOLE_HOSTS,
    ...HOSTS_TAKING_A_PORT.flatMap((host) => PORTS.map((port) => `${host}:${port}`))];

describe("the iperf3 host rule, asked on both sides", () => {
    it("answers every host the way the server would", () => {
        for (const host of HOSTS)
            assert.equal(iperfHostAccepted(host), iperfEndpointProblem(host) === null,
                `the two disagree about ${JSON.stringify(host)}`);
    });

    // The one deliberate difference: the client's form state can hold nothing
    // at all, which the server never sees - a missing endpoint is refused
    // earlier, by requiresEndpoint. A field that was never filled in is no
    // host, not a crash.
    it("reads a field that was never filled in as no host at all", () => {
        assert.equal(iperfHostAccepted(undefined), false);
        assert.equal(iperfHostAccepted(null), false);
    });

    it("asks about every host spelling and every port shape", () => {
        assert.ok(WHOLE_HOSTS.length >= MIN_WHOLE_HOSTS, "the whole-host table was emptied");
        assert.ok(HOSTS_TAKING_A_PORT.length >= MIN_HOSTS_TAKING_A_PORT, "the port cross product lost its hosts");
        assert.ok(PORTS.length >= MIN_PORTS, "the port cross product lost its shapes");
        assert.ok(HOSTS_TAKING_A_PORT.some((host) => host.startsWith("[")),
            "no bracketed host takes a port, so the bracketed port branch is untested again");
    });
});
