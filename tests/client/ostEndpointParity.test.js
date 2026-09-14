import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ostEndpointProblem } from "../../server/controller/targets.js";
import { ostEndpointAccepted } from "../../client/src/common/components/TargetsDialog/providerFields.js";

const acceptedByServer = (endpoint) => ostEndpointProblem(endpoint) === null;

describe("OpenSpeedTest endpoint parity", () => {
    it("keeps the client and server shape rules identical", () => {
        const cases = [
            ["http://192.168.1.50:3000", true],
            ["  https://speed.lan/base/  ", true],
            ["", false], [null, false], [undefined, false], [3000, false],
            ["speed.lan:3000", false], ["ftp://speed.lan", false],
            ["http://speed.lan/a b", false], ["http://speed.lan/\tpath", false],
            ["http://speed.lan/\u0001path", false], ["http://speed.lan/\u007fpath", false],
            ["http://user@speed.lan", false], ["http://@speed.lan", false],
            ["http://:@speed.lan", false], ["http://speed.lan/path@file", true],
            ["http://speed.lan?q=1", false],
            ["http://speed.lan?", false], ["http://speed.lan/#result", false],
            ["http://speed.lan#", false]
        ];

        for (const [endpoint, accepted] of cases) {
            assert.equal(ostEndpointAccepted(endpoint), accepted, `client: ${JSON.stringify(endpoint)}`);
            assert.equal(acceptedByServer(endpoint), accepted, `server: ${JSON.stringify(endpoint)}`);
        }
    });

    it("leaves the literal-host safety policy at the server boundary", () => {
        for (const endpoint of ["http://169.254.169.254", "http://[fe80::1]"]) {
            assert.equal(ostEndpointAccepted(endpoint), true);
            assert.notEqual(ostEndpointProblem(endpoint), null);
        }
    });
});
