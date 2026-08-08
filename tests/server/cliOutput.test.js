import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseCliOutput } from "../../server/util/providers/cliOutput.js";

// A shortened but otherwise verbatim result line from the Ookla CLI.
const OOKLA_RESULT = JSON.stringify({
    type: "result",
    ping: {jitter: 0.32, latency: 24.079},
    download: {bandwidth: 291995750, elapsed: 10211},
    upload: {bandwidth: 287879258, elapsed: 9814},
    server: {id: 49631, host: "speedtest.arcade.ch", name: "Arcade Solutions AG"},
    result: {id: "c63aac06-94e8-44f7-9163-49ac377f74f4"}
});

// What the CLI writes to stderr while it walks its candidate servers. Every one
// of these lines is emitted by a run that goes on to finish successfully.
const SOCKET_NOISE = Array.from({length: 8}, () => JSON.stringify({
    type: "log", timestamp: "2026-08-08T18:29:32Z",
    message: "Error: [0] Cannot open socket", level: "error"
})).join("\n");

describe("parseCliOutput", () => {
    describe("a run that produced a result", () => {
        /**
         * Regression: the CLI logs each candidate server it could not open a
         * socket to - which is routine when it is bound to one address family
         * and a server answers on the other - and then completes the test over
         * a server that does work. stderr was being turned into a thrown error
         * after the result had already been parsed, so every single test failed
         * with "Cannot open socket" despite having measured the line perfectly.
         */
        it("keeps the result when the CLI also logged errors to stderr", () => {
            const parsed = parseCliOutput("ookla", OOKLA_RESULT, SOCKET_NOISE);

            assert.equal(parsed.error, undefined);
            assert.equal(parsed.type, "result");
            assert.equal(parsed.download.bandwidth, 291995750);
        });

        it("keeps the result even when stderr mentions rate limiting", () => {
            const parsed = parseCliOutput("ookla", OOKLA_RESULT, "Too many requests");

            assert.equal(parsed.error, undefined);
            assert.equal(parsed.server.id, 49631);
        });

        it("does not mistake a log line for the result", () => {
            const log = JSON.stringify({type: "log", message: "Error: [0] Cannot open socket"});

            // stdout carried only chatter, so the stderr failure is the real
            // outcome and has to survive.
            const parsed = parseCliOutput("ookla", log, "Configuration - Cannot open socket");

            assert.equal(parsed.error, "Configuration - Cannot open socket");
        });
    });

    describe("a run that failed", () => {
        it("reports the error the CLI printed on stdout", () => {
            const parsed = parseCliOutput("ookla", '{"error":"Latency test failed"}', SOCKET_NOISE);

            assert.equal(parsed.error, "Latency test failed");
        });

        it("falls back to stderr when stdout said nothing", () => {
            const parsed = parseCliOutput("ookla", "", "Cannot open socket");

            assert.equal(parsed.error, "Cannot open socket");
        });

        it("translates a rate limit into something a user can act on", () => {
            const parsed = parseCliOutput("ookla", "", "Too many requests - please retry");

            assert.equal(parsed.error, "Too many requests. Please try again later");
        });

        it("is empty when the CLI printed nothing at all", () => {
            assert.deepEqual(parseCliOutput("ookla", "", ""), {});
        });

        it("ignores whitespace-only stderr", () => {
            assert.deepEqual(parseCliOutput("ookla", "", "   \n  "), {});
        });
    });

    describe("output that is not JSON", () => {
        it("skips lines that are neither an object nor an array", () => {
            const stdout = `Speedtest by Ookla\n${OOKLA_RESULT}`;
            const parsed = parseCliOutput("ookla", stdout, "");

            assert.equal(parsed.type, "result");
        });

        it("skips a malformed JSON line rather than reporting it as the failure", () => {
            const parsed = parseCliOutput("ookla", `{"type":"result"\n${OOKLA_RESULT}`, "");

            assert.equal(parsed.error, undefined);
            assert.equal(parsed.download.bandwidth, 291995750);
        });
    });

    describe("the other providers", () => {
        it("unwraps the single-element array librespeed prints", () => {
            const parsed = parseCliOutput("libre", '[{"ping":12,"download":940}]', SOCKET_NOISE);

            assert.equal(parsed.error, undefined);
            assert.equal(parsed.ping, 12);
        });

        it("leaves a cloudflare array as it found it", () => {
            const parsed = parseCliOutput("cloudflare", '[{"test_type":"Download"}]', "");

            assert.ok(Array.isArray(parsed));
        });

        it("still reports a librespeed failure from stderr", () => {
            const parsed = parseCliOutput("libre", "", "no server found");

            assert.equal(parsed.error, "no server found");
        });
    });
});
