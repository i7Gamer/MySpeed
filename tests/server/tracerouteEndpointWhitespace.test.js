import {describe, it} from "node:test";
import assert from "node:assert/strict";
import {traceHost} from "../../server/util/traceroute.js";

describe("historical whitespace-padded traceroute destinations", () => {
    it("uses the same URL host with or without padding, including IPv6", () => {
        for (const provider of ["openspeedtest", "libre"])
            for (const [endpoint, expected] of [["http://speed.lan:3000/base", "speed.lan"],
                ["https://speed.lan:3001", "speed.lan"], ["https://[fd00::1]:3001/base", "fd00::1"]]) {
                assert.equal(traceHost({provider, endpoint}), expected);
                assert.equal(traceHost({provider, endpoint: ` \t${endpoint}\r\n `}), expected);
            }
    });
    it("also trims parsed result hosts without accepting malformed destinations", () => {
        assert.equal(traceHost({provider: "openspeedtest"}, {serverHost: "  https://speed.lan:3001  "}), "speed.lan");
        assert.equal(traceHost({provider: "iperf3", endpoint: "  [fd00::2]:5201  "}), "fd00::2");
        for (const endpoint of ["  ", " https://[broken ", " https://speed .lan "])
            assert.equal(traceHost({provider: "openspeedtest", endpoint}), null);
    });
});
