import {describe, it} from "node:test";
import assert from "node:assert/strict";
import {describeChange, storableAddress} from "../../server/util/connectionChange.js";
import {connectionChange} from "../../client/src/common/utils/TestUtil.js";

const EQUIVALENT = [
    ["2001:db8:0:0:0:0:0:1", "2001:db8::1"],
    ["2001:DB8:ABCD::F", "2001:db8:abcd::f"],
    ["2001:0db8:0000:0000:0000:0000:0000:0001", "2001:db8::1"],
    ["::ffff:192.0.2.1", "::ffff:c000:201"],
    ["fe80:0:0:0:0:0:0:1%eth0", "fe80::1%eth0"],
    ["fe80:0:0:0:0:0:0:1%en-0", "fe80::1%en-0"],
    ["fe80:0:0:0:0:0:0:1%en.0", "fe80::1%en.0"],
    ["fe80:0:0:0:0:0:0:1%en:0", "fe80::1%en:0"],
    ["fe80:0:0:0:0:0:0:1%12", "fe80::1%12"],
    ["203.0.113.10", "203.0.113.10"]
];
const DIFFERENT = [
    ["2001:db8::1", "2001:db8::2"],
    ["::ffff:192.0.2.1", "::ffff:c000:202"],
    ["fe80::1%eth0", "fe80::1%eth1"],
    ["fe80::1%ETH0", "fe80::1%eth0"],
    ["fe80::1", "fe80::1%eth0"],
    ["203.0.113.10", "203.0.113.11"]
];

describe("full-address equality in connection changes", () => {
    for (const [previous, current] of EQUIVALENT) {
        it(`server does not report ${previous} as changing to ${current}`, () => {
            assert.equal(describeChange({externalIp: current}, {externalIp: previous}), null);
            assert.equal(storableAddress(previous), previous, "comparison must not migrate stored spelling");
        });
        it(`UI does not report ${previous} as changing to ${current}`, () => {
            assert.equal(connectionChange({externalIp: current}, {externalIp: previous}), null);
        });
    }
    for (const [previous, current] of DIFFERENT) {
        it(`still reports ${previous} changing to ${current}`, () => {
            assert.deepEqual(describeChange({externalIp: current}, {externalIp: previous}), {
                previousIp: previous, ip: current, previousIsp: null, isp: null
            });
            assert.deepEqual(connectionChange({externalIp: current}, {externalIp: previous}), {
                isp: false, externalIp: true
            });
        });
    }
    it("uses the same cross-family rule on the server and UI", () => {
        const current = {externalIp: "2001:db8::1"};
        const previous = {externalIp: "192.0.2.1"};
        assert.equal(describeChange(current, previous), null);
        assert.equal(connectionChange(current, previous), null);
    });
    it("retains the server and UI's existing ISP spelling rules", () => {
        const current = {externalIp: "2001:db8::1", isp: "NET"};
        const previous = {externalIp: "2001:db8::1", isp: "Net"};
        assert.equal(describeChange(current, previous), null);
        assert.deepEqual(connectionChange(current, previous), {isp: true, externalIp: false});
    });
    it("does not mistake two malformed addresses for the same canonical address", () => {
        const current = {externalIp: "2001::broken"};
        const previous = {externalIp: "2001::other"};
        assert.notEqual(describeChange(current, previous), null);
        assert.deepEqual(connectionChange(current, previous), {isp: false, externalIp: true});
    });
    for (const [previous, current] of [
        ["2001:db8::1]/first", "2001:db8::1]/second"],
        ["2001:db8::1%", "2001:0db8::1%"],
        ["2001:db8::1%eth0%extra", "2001:0db8::1%eth0%extra"]
    ]) {
        it(`does not canonicalize malformed literal ${previous}`, () => {
            assert.notEqual(describeChange({externalIp: current}, {externalIp: previous}), null);
            assert.deepEqual(connectionChange({externalIp: current}, {externalIp: previous}), {
                isp: false, externalIp: true
            });
        });
    }
    it("does not hide a malformed UI address behind a parsed URL hostname", () => {
        assert.deepEqual(connectionChange({externalIp: "2001:db8::1]/path"}, {externalIp: "2001:db8::1"}), {
            isp: false, externalIp: true
        });
    });
    it("continues to ignore absent addresses", () => {
        for (const absent of [null, undefined, ""]) {
            for (const compare of [describeChange, connectionChange]) {
                assert.equal(compare({externalIp: absent}, {externalIp: "2001:db8::1"}), null);
                assert.equal(compare({externalIp: "2001:db8::1"}, {externalIp: absent}), null);
            }
        }
    });
});
