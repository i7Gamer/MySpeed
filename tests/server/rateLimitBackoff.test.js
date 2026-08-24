import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { bodyIn } from "../helpers/source.js";
import { parseCliOutput, RATE_LIMIT_MESSAGE, isRateLimitMessage } from "../../server/util/providers/cliOutput.js";
import {
    FIRST_BACKOFF_MS,
    MAX_BACKOFF_MS,
    backoffRemainingMs,
    clearBackoff,
    forgetAllBackoff,
    isBackingOff,
    recordRateLimit
} from "../../server/util/rateLimitBackoff.js";

/**
 * Being told "too many requests" and answering with another request.
 *
 * Upstream #846 and #1092. The crash half of those is already fixed - an
 * unhandled rejection no longer ends the process - but the request half was
 * untouched, and it is the half that keeps the limiter closed: a refusal was
 * thrown like any other failure, so the catch in tasks/speedtest.js retried it
 * on the spot, and every following tick of the cron asked again. On the minutely
 * schedule the installer scripts hand out that is one refusal per minute for as
 * long as the limit stands, each one recorded as a failed test and sent to every
 * notifier.
 *
 * The two are separate mistakes and are fixed separately: the immediate retry is
 * a decision about *this* run, and the hold is a decision about the runs after
 * it.
 */
describe("recognising a refusal", () => {
    it("knows the message the CLIs are refused with", () => {
        assert.equal(isRateLimitMessage("Too many requests. Please try again later"), true);
    });

    /**
     * Matched rather than compared. The normalised constant is what the stderr
     * path stores, but a CLI that reports the same refusal as JSON on stdout is
     * read by a different branch, and the wording differs between the three
     * providers and between their versions.
     */
    it("does not depend on the exact wording or case", () => {
        assert.equal(isRateLimitMessage("Error: TOO MANY REQUESTS received, retry later"), true);
        assert.equal(isRateLimitMessage("429 too many requests"), true);
    });

    it("does not read an ordinary failure as a refusal", () => {
        assert.equal(isRateLimitMessage("Cannot open socket"), false);
        assert.equal(isRateLimitMessage("The speedtest did not finish within 180 seconds"), false);
        assert.equal(isRateLimitMessage(""), false);
    });

    // It is handed whatever was thrown, and a thrown object has no message.
    it("survives being asked about something that is not a string", () => {
        assert.equal(isRateLimitMessage(undefined), false);
        assert.equal(isRateLimitMessage(null), false);
        assert.equal(isRateLimitMessage({message: "Too many requests"}), false);
    });
});

/**
 * The two paths a refusal can arrive by have to agree, because only one thing
 * reads the answer: the backoff. A refusal that stored its own wording would be
 * recorded as a failed test and then asked for again a minute later, which is
 * the whole behaviour being fixed.
 */
describe("normalising a refusal", () => {
    it("normalises one reported on stderr", () => {
        const parsed = parseCliOutput("ookla", "", "Too many requests - please retry");

        assert.equal(parsed.error, RATE_LIMIT_MESSAGE);
    });

    it("normalises one the CLI reported as JSON on stdout", () => {
        const parsed = parseCliOutput("ookla", '{"error":"Too many requests received, try again later."}', "");

        assert.equal(parsed.error, RATE_LIMIT_MESSAGE);
    });

    it("leaves an unrelated error alone on both paths", () => {
        assert.equal(parseCliOutput("ookla", "", "Cannot open socket").error, "Cannot open socket");
        assert.equal(parseCliOutput("ookla", '{"error":"Latency test failed"}', "").error, "Latency test failed");
    });
});

/**
 * The hold itself.
 *
 * `now` is passed in rather than read from the clock so that the escalation can
 * be walked without waiting hours for it. Every reader takes it, which is also
 * what lets runTask judge one moment consistently across the two questions it
 * asks.
 */
describe("the backoff", () => {
    const PROVIDER = "ookla";
    const NOW = 1_700_000_000_000;

    beforeEach(() => forgetAllBackoff());

    it("holds nothing until a refusal is recorded", () => {
        assert.equal(isBackingOff(PROVIDER, NOW), false);
        assert.equal(backoffRemainingMs(PROVIDER, NOW), 0);
    });

    it("holds the schedule for the first wait after one refusal", () => {
        assert.equal(recordRateLimit(PROVIDER, NOW), FIRST_BACKOFF_MS);

        assert.equal(isBackingOff(PROVIDER, NOW), true);
        assert.equal(backoffRemainingMs(PROVIDER, NOW), FIRST_BACKOFF_MS);
    });

    it("counts down and then lets go", () => {
        recordRateLimit(PROVIDER, NOW);

        assert.equal(backoffRemainingMs(PROVIDER, NOW + FIRST_BACKOFF_MS / 2), FIRST_BACKOFF_MS / 2);
        assert.equal(isBackingOff(PROVIDER, NOW + FIRST_BACKOFF_MS), false);
        assert.equal(backoffRemainingMs(PROVIDER, NOW + FIRST_BACKOFF_MS), 0);
    });

    /**
     * The point of doubling rather than waiting a fixed period: a limit that
     * outlasts the first wait would otherwise go on producing one failed row
     * and one alert per wait, for as long as it stands. Doubling thins them out
     * until the cap, and the cap keeps the schedule from going quiet for a day
     * because of an afternoon.
     */
    it("doubles the wait for each consecutive refusal, up to the cap", () => {
        let moment = NOW;
        let previous = 0;

        for (let refusal = 0; refusal < 12; refusal++) {
            const wait = recordRateLimit(PROVIDER, moment);

            assert.ok(wait <= MAX_BACKOFF_MS, `refusal ${refusal} asked for longer than the cap`);
            if (previous !== 0 && previous < MAX_BACKOFF_MS)
                assert.equal(wait, Math.min(previous * 2, MAX_BACKOFF_MS),
                    `refusal ${refusal} did not double the wait before it`);

            previous = wait;
            moment += wait;
        }

        assert.equal(previous, MAX_BACKOFF_MS, "the escalation never reached the cap");
    });

    it("starts over once a test gets through", () => {
        recordRateLimit(PROVIDER, NOW);
        recordRateLimit(PROVIDER, NOW);

        clearBackoff(PROVIDER);

        assert.equal(isBackingOff(PROVIDER, NOW), false);
        assert.equal(recordRateLimit(PROVIDER, NOW), FIRST_BACKOFF_MS,
            "a provider that answered again is still held to the escalation it earned before");
    });

    /**
     * The limiter belongs to the provider, not to the instance. Switching away
     * from a provider that is refusing is exactly what somebody does about it -
     * it is what two of the upstream reports did - and holding the schedule for
     * up to the cap afterwards would punish the fix.
     */
    it("holds each provider on its own", () => {
        recordRateLimit("ookla", NOW);

        assert.equal(isBackingOff("ookla", NOW), true);
        assert.equal(isBackingOff("libre", NOW), false);
        assert.equal(isBackingOff("cloudflare", NOW), false);
    });

    it("holds nothing when it is asked about no provider at all", () => {
        recordRateLimit("ookla", NOW);

        assert.equal(isBackingOff(undefined, NOW), false);
        assert.equal(isBackingOff("none", NOW), false);
    });
});

/**
 * The retry, which is the other half and lives where the failure is caught.
 *
 * Read rather than run, for the reason retryShutdown.test.js gives about the
 * same line: reaching it needs a spawned CLI and a provider that refuses, and
 * the assertion is about the shape of the guard.
 */
describe("the immediate retry", () => {
    const catchBlock = bodyIn("server/tasks/speedtest.js", "} catch (e) {");

    it("is not taken when the failure was a refusal", () => {
        assert.match(catchBlock, /!retried\s*&&\s*!isShuttingDown\(\)\s*&&\s*!rateLimited/,
            "a refused run answers the limiter with a second request");
    });

    it("still records the refusal it declined to retry", () => {
        assert.match(catchBlock, /recordRateLimit\(/,
            "the refusal is not recorded, so the schedule asks again on the next tick");
    });
});
