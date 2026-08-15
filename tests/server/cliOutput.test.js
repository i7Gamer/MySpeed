import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseCliOutput, MAX_ERROR_LENGTH } from "../../server/util/providers/cliOutput.js";

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

    /**
     * The whole of stderr used to go straight into the database. A run can
     * spend its full three-minute timeout logging one line per unreachable
     * candidate server, and the column it lands in is bounded - so the insert
     * that records the failure could itself fail, inside the very handler that
     * exists to record failures. The column is now TEXT, and this keeps a
     * runaway CLI from writing megabytes into it either way.
     */
    describe("an error far longer than the column", () => {
        const NOISE = "Error: [0] Cannot open socket to 2001:db8::1 port 8080\n".repeat(500);

        it("caps the stderr fallback", () => {
            const parsed = parseCliOutput("ookla", "", NOISE);

            assert.ok(parsed.error.length <= MAX_ERROR_LENGTH,
                `stored ${parsed.error.length} characters`);
        });

        it("caps an error the CLI printed on stdout", () => {
            const parsed = parseCliOutput("ookla", JSON.stringify({error: NOISE}), "");

            assert.ok(parsed.error.length <= MAX_ERROR_LENGTH);
        });

        // Truncation has to be visible, or a cut-off message reads as the whole
        // of what the CLI said.
        it("says that it truncated", () => {
            assert.match(parseCliOutput("ookla", "", NOISE).error, /…$/);
        });

        it("keeps the beginning, which is where the reason is", () => {
            assert.match(parseCliOutput("ookla", "", NOISE).error, /^Error: \[0\] Cannot open socket/);
        });

        it("leaves an error that fits exactly as the CLI printed it", () => {
            assert.equal(parseCliOutput("ookla", "", "Cannot open socket").error, "Cannot open socket");
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

        /**
         * JSON that parses to nothing usable, which is not the same as JSON
         * that does not parse.
         *
         * The array unwrap happened inside the try and the `data.error` read
         * outside it, so `[]` - which librespeed prints when its backend is
         * down, and which is perfectly valid JSON - dereferenced undefined and
         * threw a TypeError the parse handler never saw. The only caller runs
         * this from a child process's 'close' listener, so it escaped as an
         * uncaughtException rather than as a rejected promise: the whole server
         * went down because one speedtest found no server.
         */
        describe("a line that parses to nothing usable", () => {
            const UNUSABLE = {
                "an empty array": "[]",
                "an array whose first element is null": "[null]",
                "an array of scalars": "[1,2,3]",
                "a bare null": "{}".replace("{}", "null")
            };

            for (const [name, line] of Object.entries(UNUSABLE)) {
                it(`skips ${name} instead of throwing`, () => {
                    assert.doesNotThrow(() => parseCliOutput("libre", line, ""));
                });
            }

            it("reports the stderr reason rather than dying on the empty array", () => {
                const parsed = parseCliOutput("libre", "[]", "no server found");

                assert.equal(parsed.error, "no server found");
            });

            // And the line is skipped, not accepted: an empty array is not a
            // measurement of nought.
            it("does not take it as a result", () => {
                assert.deepEqual(parseCliOutput("libre", "[]", ""), {});
            });

            it("still unwraps a real single-element array beside it", () => {
                const parsed = parseCliOutput("libre", '[]\n[{"ping":12,"download":940}]', "");

                assert.equal(parsed.ping, 12);
            });
        });
    });

    describe("the other providers", () => {
        it("unwraps the single-element array librespeed prints", () => {
            const parsed = parseCliOutput("libre", '[{"ping":12,"download":940}]', SOCKET_NOISE);

            assert.equal(parsed.error, undefined);
            assert.equal(parsed.ping, 12);
        });

        // The real CLI reports one object - {metadata, latency_measurement,
        // speed_measurements} - which is what parseCloudflare destructures.
        it("takes the cloudflare object as the result", () => {
            const parsed = parseCliOutput("cloudflare",
                '{"latency_measurement":{"avg_latency_ms":31.9},"speed_measurements":[{"test_type":"Download"}]}', "");

            assert.equal(parsed.latency_measurement.avg_latency_ms, 31.9);
        });

        /**
         * A top-level array is not something the cloudflare CLI produces, and
         * accepting one was actively harmful: speedtest.js returns
         * `{...result, elapsed}`, and spreading an array yields an object keyed
         * by index. parseCloudflare matches neither of its branches on that and
         * falls through to its zeroed result - so the run would have been stored
         * as a genuine measurement of 0/0/0 rather than reported as a failure.
         */
        it("refuses a top-level array as a cloudflare result", () => {
            const parsed = parseCliOutput("cloudflare", '[{"test_type":"Download"}]', "no usable output");

            assert.ok(!Array.isArray(parsed), "an array was accepted as a result");
            assert.equal(parsed.error, "no usable output");
        });

        it("still reports a librespeed failure from stderr", () => {
            const parsed = parseCliOutput("libre", "", "no server found");

            assert.equal(parsed.error, "no server found");
        });
    });

    /**
     * A CLI that explains itself on stdout, in plain text, with nothing on
     * stderr at all.
     *
     * stderr was the only stream a failure could come from, so this parsed as
     * neither a result nor an error and returned {}. speedtest.js then added
     * `elapsed` and handed it on, and tasks/speedtest.js reached its
     * `Object.keys(speedtest).length <= 1` guard and reported "No response,
     * even after trying again, test timed out." - a run that had failed in the
     * first second, blamed on a three-minute timeout that never happened, with
     * the CLI's own sentence discarded on the way past.
     */
    describe("a failure the CLI printed to stdout", () => {
        it("reports plain text from stdout when stderr is silent", () => {
            const parsed = parseCliOutput("ookla", "Fatal: host unreachable", "");

            assert.equal(parsed.error, "Fatal: host unreachable");
        });

        it("recognises rate limiting there too", () => {
            const parsed = parseCliOutput("ookla", "Too many requests, slow down", "");

            assert.match(parsed.error, /try again later/);
        });

        it("still prefers stderr, which is where a failure usually is", () => {
            const parsed = parseCliOutput("ookla", "Fatal: host unreachable", "the real reason");

            assert.equal(parsed.error, "the real reason");
        });

        it("keeps a result that happens to sit beside chatter on stdout", () => {
            const parsed = parseCliOutput("ookla", `Connecting...\n${OOKLA_RESULT}`, "");

            assert.equal(parsed.error, undefined);
            assert.equal(parsed.download.bandwidth, 291995750);
        });

        /**
         * Progress records are not a failure. They are JSON, so they are
         * skipped rather than mistaken for the plain-text explanation this
         * looks for - otherwise every run that was cut short mid-measurement
         * would report its own progress log as the reason.
         */
        it("does not mistake unparsed json chatter for an explanation", () => {
            const progress = JSON.stringify({type: "download", download: {bandwidth: 100}});
            const parsed = parseCliOutput("ookla", progress, "");

            assert.equal(parsed.error, undefined);
        });

        it("says nothing at all when both streams are empty", () => {
            assert.equal(parseCliOutput("ookla", "", "").error, undefined);
        });
    });
});
