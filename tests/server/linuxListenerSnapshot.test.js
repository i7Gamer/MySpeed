import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
    assertOwnedListener,
    systemListeners,
    waitForListenerFreeExit
} from "../../scripts/qualification/safety.mjs";

const OWNED_PID = 8_123;
const TEST_PORT = 43_127;
const TEST_PORT_HEX = TEST_PORT.toString(16).toUpperCase();
const IPV4_LOOPBACK_HEX = "0100007F";
const IPV6_LOOPBACK_HEX = "00000000000000000000000001000000";
const OWNED_SOCKET_INODE = "12345";
const FOREIGN_SOCKET_INODE = "54321";
const LISTENER_FREE_EXIT_CODE = 113;
const LISTENER_FREE_POLL_MS = 5;
const LISTENER_FREE_TIMEOUT_MS = 100;
const OWNED_DESCRIPTOR = "17";
const TCP_TABLE_PATHS = ["/proc/net/tcp", "/proc/net/tcp6"];
const TCP_HEADER = "sl local_address rem_address st tx_queue rx_queue tr tm->when retrnsmt uid timeout inode";

const procTable = (address, inode) => [
    TCP_HEADER,
    `0: ${address}:${TEST_PORT_HEX} 00000000:0000 0A 00000000:00000000 00:00000000 00000000 1000 0 ${inode}`,
    ""
].join("\n");

describe("Linux listener snapshot ordering", () => {
    it("captures both IPv4 and IPv6 tables before resolving the target PID socket inodes", (t) => {
        const calls = [];
        const capturedTables = new Set();

        t.mock.method(fs, "readFileSync", (file) => {
            calls.push(["table", file]);
            capturedTables.add(file);
            if (file === "/proc/net/tcp") return procTable(IPV4_LOOPBACK_HEX, OWNED_SOCKET_INODE);
            if (file === "/proc/net/tcp6") return procTable(IPV6_LOOPBACK_HEX, OWNED_SOCKET_INODE);
            throw new Error(`Unexpected table ${file}`);
        });
        t.mock.method(fs, "readdirSync", (directory) => {
            calls.push(["fds", directory]);
            return capturedTables.size === TCP_TABLE_PATHS.length ? [OWNED_DESCRIPTOR] : [];
        });
        t.mock.method(fs, "readlinkSync", (file) => {
            calls.push(["fd", file]);
            return `socket:[${OWNED_SOCKET_INODE}]`;
        });

        assert.deepEqual(systemListeners(OWNED_PID, "linux"), [
            {address: "127.0.0.1", port: TEST_PORT, pid: OWNED_PID},
            {address: "0:0:0:0:0:0:0:1", port: TEST_PORT, pid: OWNED_PID}
        ]);
        assert.deepEqual(calls.slice(0, TCP_TABLE_PATHS.length), TCP_TABLE_PATHS.map((file) => ["table", file]));
        assert.deepEqual(calls[TCP_TABLE_PATHS.length], ["fds", `/proc/${OWNED_PID}/fd`]);
    });

    it("keeps a listener unknown when its inode is absent from the target PID snapshot", (t) => {
        t.mock.method(fs, "readFileSync", (file) => file === "/proc/net/tcp"
            ? procTable(IPV4_LOOPBACK_HEX, FOREIGN_SOCKET_INODE)
            : `${TCP_HEADER}\n`);
        t.mock.method(fs, "readdirSync", () => [OWNED_DESCRIPTOR]);
        t.mock.method(fs, "readlinkSync", () => `socket:[${OWNED_SOCKET_INODE}]`);

        const listeners = systemListeners(OWNED_PID, "linux");
        assert.deepEqual(listeners, [{address: "127.0.0.1", port: TEST_PORT, pid: null}]);
        assert.throws(() => assertOwnedListener({
            listeners,
            host: "127.0.0.1",
            port: TEST_PORT,
            pid: OWNED_PID
        }), /reported owner: unknown/i);
    });
});

describe("listener-free process observation", () => {
    it("waits for child exit metadata after the stable observer sees no listener", async () => {
        const child = {pid: OWNED_PID, exitCode: null, signalCode: null};
        const inspectedPids = [];
        const delays = [];
        const exitCode = await waitForListenerFreeExit({
            child,
            port: TEST_PORT,
            timeoutMs: LISTENER_FREE_TIMEOUT_MS,
            pollMs: LISTENER_FREE_POLL_MS,
            inspect: (pid) => {
                inspectedPids.push(pid);
                return [];
            },
            delay: async (milliseconds) => {
                delays.push(milliseconds);
                child.exitCode = LISTENER_FREE_EXIT_CODE;
            }
        });

        assert.equal(exitCode, LISTENER_FREE_EXIT_CODE);
        assert.deepEqual(inspectedPids, [process.pid]);
        assert.deepEqual(delays, [LISTENER_FREE_POLL_MS]);
    });

    it("uses the verifier PID and rejects a child listener even when its owner is unknown", async () => {
        const observedPids = [];

        await assert.rejects(waitForListenerFreeExit({
            child: {pid: OWNED_PID, exitCode: null, signalCode: null},
            port: TEST_PORT,
            timeoutMs: LISTENER_FREE_TIMEOUT_MS,
            inspect: (pid) => {
                observedPids.push(pid);
                return [{address: "127.0.0.1", port: TEST_PORT, pid: null}];
            }
        }), /listener-free process opened/i);
        assert.deepEqual(observedPids, [process.pid]);
    });

    it("fails closed when inspection through the stable verifier PID fails", async () => {
        const inspectionFailure = Object.assign(new Error("proc socket inspection failed"), {code: "EACCES"});

        await assert.rejects(waitForListenerFreeExit({
            child: {pid: OWNED_PID, exitCode: null, signalCode: null},
            port: TEST_PORT,
            timeoutMs: LISTENER_FREE_TIMEOUT_MS,
            inspect: (pid) => {
                assert.equal(pid, process.pid);
                throw inspectionFailure;
            }
        }), (error) => error === inspectionFailure);
    });

    it("returns an already observed child exit without inspecting sockets", async () => {
        let inspections = 0;
        const exitCode = await waitForListenerFreeExit({
            child: {pid: OWNED_PID, exitCode: LISTENER_FREE_EXIT_CODE, signalCode: null},
            port: TEST_PORT,
            timeoutMs: LISTENER_FREE_TIMEOUT_MS,
            inspect: () => {
                inspections += 1;
                return [];
            }
        });

        assert.equal(exitCode, LISTENER_FREE_EXIT_CODE);
        assert.equal(inspections, 0);
    });
});
