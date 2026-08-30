import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { bodyIn } from "../helpers/source.js";
import { memberHeld, roundFullyHeld } from "../../server/tasks/speedtest.js";
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

    /**
     * On every provider, not only the one whose isResult is strict enough to
     * hide the bug.
     *
     * ookla adopts a JSON record as the result only when it says
     * `type: "result"`, so a record carrying nothing but an error never became
     * one and the normalised wording survived. libre adopts any object and
     * cloudflare adopts anything that is not an array - so for both of them the
     * record carrying the error *was* the result, and assigning it over `result`
     * put the wording of the CLI straight back. Every case above used ookla,
     * which is why nothing noticed.
     */
    it("normalises one on every provider, not just the strict one", () => {
        for (const mode of ["ookla", "libre", "cloudflare"])
            assert.equal(
                parseCliOutput(mode, JSON.stringify({error: "Too many requests received, try again later."}), "").error,
                RATE_LIMIT_MESSAGE, `${mode} kept the wording of the CLI`);
    });

    it("still keeps an unrelated error verbatim on those providers", () => {
        for (const mode of ["libre", "cloudflare"])
            assert.equal(parseCliOutput(mode, JSON.stringify({error: "Latency test failed"}), "").error,
                "Latency test failed", mode);
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
        // Three refusals for one escalation. The first two are a whole wait
        // apart, which is what earns the doubling this case exists to see
        // cleared: back to back they are one refusal reaching two callers -
        // three Ookla targets in a round all being told the same no - and the
        // module now answers those with the standing hold rather than a longer
        // one, so there would be nothing left for clearBackoff to undo and the
        // assertion below would pass on a module that never doubled at all.
        // The third call is exactly that repeat, and must change nothing.
        recordRateLimit(PROVIDER, NOW - FIRST_BACKOFF_MS);
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

    /**
     * The escalation is about waits, not about callers.
     *
     * Several targets can share a provider - two Ookla targets pinned to
     * different servers is the point of the feature - and a round started by
     * hand consults no hold at all, deliberately. So one press of "Run test" on
     * an instance with three Ookla targets recorded three refusals within
     * seconds and doubled the wait three times: a quarter of an hour became an
     * hour, and the automatic schedule went quiet for it, from one click.
     */
    it("does not escalate for a refusal that arrives inside a standing hold", () => {
        recordRateLimit(PROVIDER, NOW);
        const inside = NOW + FIRST_BACKOFF_MS / 3;

        assert.equal(recordRateLimit(PROVIDER, inside), FIRST_BACKOFF_MS * 2 / 3,
            "the repeat was answered with a fresh wait rather than what is left of the standing one");
        assert.equal(backoffRemainingMs(PROVIDER, inside), FIRST_BACKOFF_MS * 2 / 3);
        assert.equal(isBackingOff(PROVIDER, NOW + FIRST_BACKOFF_MS), false,
            "a repeat pushed out the moment the schedule is next allowed to try");
    });

    it("is not escalated by a whole round of targets sharing one provider", () => {
        for (let target = 0; target < 3; target++) recordRateLimit(PROVIDER, NOW);

        assert.equal(backoffRemainingMs(PROVIDER, NOW), FIRST_BACKOFF_MS,
            "one click on an instance with three Ookla targets silenced the schedule for an hour");
    });

    /**
     * The control. Without it the two cases above would pass just as happily on
     * a module that had stopped escalating altogether.
     */
    it("still doubles once the wait it set has run out", () => {
        recordRateLimit(PROVIDER, NOW);

        assert.equal(recordRateLimit(PROVIDER, NOW + FIRST_BACKOFF_MS), FIRST_BACKOFF_MS * 2);
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
/**
 * The round that has nothing left to run.
 *
 * The hold used to be consulted in timer.js, above the call that started the
 * round. On this branch it is consulted inside the round, per member, so that
 * an Ookla refusal does not skip the iperf3 box standing next to it - but the
 * announcement stayed above it: executeRound called setRunning(true) for a
 * round whose every member it was about to skip, and setRunning(true) fires
 * testStarted at every notifier. On a minutely cron a held provider then sent
 * healthchecks.io a /start a minute that nothing ever completed, and every
 * webhook a TEST_STARTED a minute, for up to two hours - the storm this module
 * exists to end, moved rather than stopped.
 *
 * The judgement is read here rather than through a booted round: this suite has
 * no module mocking, so the predicate is a parameter and both helpers are pure.
 * What no unit assertion can see - that the question is asked *before* the
 * announcement, and still asked *again* per member - is read from the source,
 * the way previewProgress.test.js reads the same function.
 */
describe("a round with nothing it may run", () => {
    const ookla = {provider: "ookla"};
    const iperf = {provider: "iperf3"};
    const everythingHeld = () => true;

    it("holds a scheduled member whose provider is refusing", () => {
        assert.equal(memberHeld(ookla, "auto", everythingHeld), true);
    });

    it("holds nothing on a round somebody started by hand", () => {
        assert.equal(memberHeld(ookla, "custom", everythingHeld), false,
            "the run button was taken away from somebody asking for a test now");
    });

    it("is fully held only when every member is", () => {
        assert.equal(roundFullyHeld([ookla, ookla], "auto", everythingHeld), true);
        assert.equal(roundFullyHeld([ookla, iperf], "auto", (provider) => provider === "ookla"), false,
            "one provider's limiter took the round away from a target on another");
    });

    it("is not fully held when somebody started it by hand", () => {
        assert.equal(roundFullyHeld([ookla, ookla], "custom", everythingHeld), false);
    });

    // "every" is true of nothing, and executeRound answers 400 for an empty
    // round long before it asks this - but a helper that called an empty round
    // held would be a trap for whoever asks it next.
    it("does not call an empty round held", () => {
        assert.equal(roundFullyHeld([], "auto", everythingHeld), false);
    });

    describe("and the round that reads it", () => {
        const round = bodyIn("server/tasks/speedtest.js", "const executeRound =");

        /**
         * Both positions are checked against -1 before they are compared.
         * indexOf answers -1 for something that is not there at all, and -1 is
         * below every real index - so an ordering assertion on its own is
         * satisfied by a round that asks the question nowhere, which is the
         * unfixed code. helpers/source.js says the same thing at length in
         * blockEnd's docstring.
         */
        it("asks before it announces the run", () => {
            const asked = round.indexOf("roundFullyHeld(");
            const announced = round.indexOf("setRunning(true");

            assert.notEqual(asked, -1, "the round never asks whether every one of its members is held");
            assert.notEqual(announced, -1, "the round no longer announces itself at all");
            assert.ok(asked < announced,
                "the round tells every notifier a test started and only then finds it has nobody to run");
        });

        it("asks again as it reaches each member", () => {
            const loop = round.indexOf("for (const");
            // Asked of the fresh re-read, not the round-start snapshot: the
            // hold is per provider, and the provider is one of the fields a
            // mid-round edit can change.
            const perMember = round.indexOf("memberHeld(fresh");

            assert.notEqual(loop, -1, "the round no longer walks its members");
            assert.notEqual(perMember, -1,
                "the round decides once up front, so a hold its first member earns no longer skips the rest");
            assert.ok(loop < perMember,
                "the per-member skip was hoisted out of the loop it has to be re-asked in");
        });
    });
});

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
