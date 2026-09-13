import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { assertOwnedListener, systemListeners } from "../../scripts/qualification/safety.mjs";

const CHECKER_PID = 7_101;
const OWNED_PID = 8_123;
const FOREIGN_PID = 9_123;
const TEST_PORT = 43_127;
const DARWIN = "darwin";
const EXPECTED_COMMAND_TIMEOUT_MS = 2_000;
const EXPECTED_MAX_BUFFER_BYTES = 1_048_576;

const commandResult = ({status = 0, stdout = "", stderr = "", error, signal = null} = {}) => ({
    status,
    stdout,
    stderr,
    error,
    signal
});

const inspectMac = (result, calls = []) => systemListeners(CHECKER_PID, DARWIN, (...args) => {
    calls.push(args);
    return result;
});

describe("macOS listener inspection", () => {
    it("accepts lsof status 1 only for an exactly empty no-match result", () => {
        assert.deepEqual(inspectMac(commandResult({status: 1})), []);

        for (const result of [
            commandResult({status: 1, stderr: "lsof: permission denied\n"}),
            commandResult({status: 1, stdout: "\n"}),
            commandResult({status: 2}),
            commandResult({status: 0, stderr: "unexpected warning\n"}),
            commandResult()
        ]) assert.throws(() => inspectMac(result), /lsof/i);
    });

    it("enumerates all listeners and preserves each lsof process owner", () => {
        const calls = [];
        const listeners = inspectMac(commandResult({
            stdout: [
                `p${OWNED_PID}`,
                "f0",
                `n127.0.0.1:${TEST_PORT}`,
                `p${FOREIGN_PID}`,
                "f21",
                `n*:${TEST_PORT}`,
                "f22",
                `n[::1]:${TEST_PORT + 1}`,
                ""
            ].join("\n")
        }), calls);

        assert.deepEqual(listeners, [
            {address: "127.0.0.1", port: TEST_PORT, pid: OWNED_PID},
            {address: "*", port: TEST_PORT, pid: FOREIGN_PID},
            {address: "::1", port: TEST_PORT + 1, pid: FOREIGN_PID}
        ]);
        assert.deepEqual(calls, [[
            "lsof",
            ["-nP", "-iTCP", "-sTCP:LISTEN", "-F", "pfn"],
            {encoding: "utf8", maxBuffer: EXPECTED_MAX_BUFFER_BYTES, timeout: EXPECTED_COMMAND_TIMEOUT_MS}
        ]]);
    });

    it("accepts the p/f/n record shape emitted by Apple's lsof 4.91", () => {
        const output = [
            `p${OWNED_PID}`,
            "f17",
            `n127.0.0.1:${TEST_PORT}`,
            "f18",
            `n[::1]:${TEST_PORT + 1}`,
            ""
        ].join("\n");

        assert.deepEqual(inspectMac(commandResult({stdout: output})), [
            {address: "127.0.0.1", port: TEST_PORT, pid: OWNED_PID},
            {address: "::1", port: TEST_PORT + 1, pid: OWNED_PID}
        ]);
    });

    it("makes foreign and wildcard macOS listeners visible to the ownership gate", () => {
        const foreign = inspectMac(commandResult({
            stdout: `p${FOREIGN_PID}\nf17\nn127.0.0.1:${TEST_PORT}\n`
        }));
        assert.throws(() => assertOwnedListener({
            listeners: foreign,
            host: "127.0.0.1",
            port: TEST_PORT,
            pid: OWNED_PID
        }), /not owned/i);

        const wildcard = inspectMac(commandResult({
            stdout: `p${FOREIGN_PID}\nf17\nn*:${TEST_PORT}\n`
        }));
        assert.throws(() => assertOwnedListener({
            listeners: wildcard,
            host: "127.0.0.1",
            port: TEST_PORT,
            pid: OWNED_PID
        }), /wildcard/i);
    });

    it("fails closed for command launch failures and malformed field records", () => {
        const unavailable = Object.assign(new Error("spawn lsof ENOENT"), {code: "ENOENT"});
        const timedOut = Object.assign(new Error("spawn lsof ETIMEDOUT"), {code: "ETIMEDOUT"});
        const tooLarge = Object.assign(new Error("spawn lsof ENOBUFS"), {code: "ENOBUFS"});
        assert.throws(() => inspectMac(commandResult({status: null, error: unavailable})), /lsof.*ENOENT/i);
        assert.throws(() => inspectMac(commandResult({status: null, error: timedOut})), /lsof.*ETIMEDOUT/i);
        assert.throws(() => inspectMac(commandResult({status: null, error: tooLarge})), /lsof.*ENOBUFS/i);
        assert.throws(() => inspectMac(commandResult({status: null, signal: "SIGKILL"})), /lsof.*SIGKILL/i);

        for (const stdout of [
            `n127.0.0.1:${TEST_PORT}\n`,
            `pnot-a-pid\nf17\nn127.0.0.1:${TEST_PORT}\n`,
            `p${OWNED_PID}\nnot-a-file-record\n`,
            `p${OWNED_PID}\nfcwd\nn127.0.0.1:${TEST_PORT}\n`,
            `p${OWNED_PID}\nf17\nnbad-endpoint\n`,
            `p${OWNED_PID}\nf17\n`,
            `p${OWNED_PID}\nf17\nf18\nn127.0.0.1:${TEST_PORT}\n`,
            `p${OWNED_PID}\nf17\nn127.0.0.1:${TEST_PORT}\nn127.0.0.1:${TEST_PORT}\n`,
            `p${OWNED_PID}\n`,
            `p${OWNED_PID}\nf17\nxunexpected\n`
        ]) assert.throws(() => inspectMac(commandResult({stdout})), /malformed lsof/i);
    });
});
