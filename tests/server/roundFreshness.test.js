import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { bodyOf, readSource, withoutJsComments } from "../helpers/source.js";
import { cancelReservation, isRunning, staleMemberReason, tryReserve }
    from "../../server/tasks/speedtest.js";

/**
 * The member as the round reaches it, not as the round snapshot had it.
 *
 * The member list is read once at round start, so a target edited, disabled or
 * deleted mid-round used to be measured with its old configuration and the row
 * filed under its id - the old box's numbers attributed to whatever the id
 * names now. The loop re-reads each member as it arrives; this is the judgement
 * it applies to what it finds.
 */
describe("staleMemberReason", () => {
    const fresh = {id: 3, name: "WAN", provider: "ookla", enabled: true};

    it("skips a member that was deleted mid-round", () => {
        assert.equal(typeof staleMemberReason(null, false), "string");
        assert.equal(typeof staleMemberReason(undefined, false), "string");
    });

    it("skips a member a scheduled round reached after it left the schedule", () => {
        assert.equal(typeof staleMemberReason({...fresh, enabled: false}, false), "string");
    });

    // sqlite hands booleans back as 0/1 under the global raw:true, and a 0
    // read as "still scheduled" would defeat the check exactly where it runs.
    it("reads the flag the way the database spells it", () => {
        assert.equal(typeof staleMemberReason({...fresh, enabled: 0}, false), "string");
        assert.equal(staleMemberReason({...fresh, enabled: 1}, false), null);
    });

    // A named run of a disabled target is the manual-only shape working as
    // designed - the one way such a target ever runs.
    it("still runs a disabled target when it was asked for by name", () => {
        assert.equal(staleMemberReason({...fresh, enabled: false}, true), null);
    });

    it("passes a live scheduled member through", () => {
        assert.equal(staleMemberReason(fresh, false), null);
    });
});

/**
 * The round latch, taken synchronously by the route that cannot await the
 * round.
 *
 * POST /speedtests/run answers before the round ends - a proxy would time out
 * otherwise - and create() *returns* its refusals rather than throwing, so a
 * second click landing between the route's awaits got a success toast for a
 * round create() then refused into the void. The route takes the latch before
 * it answers; a caller that cannot take it is told 409 instead of 200.
 */
describe("the round reservation", () => {
    it("is exclusive until cancelled", () => {
        assert.equal(tryReserve(), true);
        assert.equal(isRunning(), true);
        assert.equal(tryReserve(), false, "two callers hold the round at once");

        cancelReservation();
        assert.equal(isRunning(), false);
        assert.equal(tryReserve(), true, "a cancelled reservation could not be retaken");

        cancelReservation();
    });
});

/**
 * The wiring, read rather than exercised - the way sessionRevocation.test.js
 * reads factoryReset - because driving a real round through these branches
 * spawns real CLIs on timing the test cannot hold still.
 */
describe("what the round loop consults between members", () => {
    const source = readSource("server/tasks/speedtest.js");

    const loop = () => {
        const start = source.indexOf("for (const [index, target] of members.entries())");
        assert.notEqual(start, -1, "the round no longer walks its members in the loop this reads");

        const end = source.indexOf("executeTarget(", start);
        assert.notEqual(end, -1);

        return source.slice(start, end);
    };

    it("re-reads each member from the table as the round reaches it", () => {
        assert.match(loop(), /targetsController\.getOne\(target\.id\)/,
            "the round still measures the snapshot, so a mid-round edit runs the old endpoint");
        assert.match(loop(), /staleMemberReason\(/,
            "the fresh read is not judged, so a deleted member still runs");
    });

    it("hands the fresh row on, not the snapshot", () => {
        assert.match(source, /await executeTarget\(fresh, type\)/,
            "executeTarget still receives the round-start snapshot");
        assert.match(loop(), /beginTarget\(fresh/,
            "/status names the snapshot while the run measures the fresh row");
    });

    it("stops for a pause, whoever started the round", () => {
        assert.match(loop(), /pauseController\.currentState/,
            "a pause mid-round keeps spawning CLIs until the members run out");
    });

    /**
     * A held member is skipped before /status is told about it. beginTarget is
     * what the status bar reads to name the target measuring, and announcing a
     * member the very next line then skips left the bar advertising a run that
     * never started - for the whole of the next member's guards, two of which
     * await the database. isShuttingDown and the stale re-read already sit
     * above the announcement for exactly this reason.
     */
    it("skips a held member before announcing it", () => {
        const body = loop();
        const held = body.indexOf("memberHeld(fresh");
        const announced = body.indexOf("beginTarget(fresh");

        assert.notEqual(held, -1, "the loop no longer consults the provider hold");
        assert.notEqual(announced, -1, "the loop no longer announces its members");
        assert.ok(held < announced,
            "/status names a member the provider hold then skips");
    });

    it("stops a scheduled round when the quiet hours begin", () => {
        assert.match(loop(), /type === "auto" && await withinQuietHours\(\)/,
            "quiet hours beginning mid-round do not stop the members still queued");
    });
});

describe("what the manual-run route does before it answers", () => {
    const route = readSource("server/routes/speedtests.js");

    it("takes the round latch before promising a round", () => {
        assert.match(route, /if \(!testTask\.tryReserve\(\)\)/,
            "the route still answers 200 on a latch create() will refuse into the void");
        assert.match(route, /\{reserved: true}/,
            "the route reserves and create() then latches a second time");
    });
});

/**
 * The round's one completion event, read the way the loop guards above are.
 *
 * healthchecks.io models one check as one monitored thing: /start opens a run
 * and the next ping closes it. testStarted fires once per round while the
 * member events fire once per target, so a multi-target round answered one
 * /start with N pings and the last member won - a watched failure taken back
 * seconds later by the next member's success. roundFinished is the pairing:
 * fired once, in the finally, carrying whether anything watched failed.
 */
describe("what the round says when it ends", () => {
    const source = readSource("server/tasks/speedtest.js");

    // Through bodyOf, which balances the braces and throws when the
    // declaration is gone. Sliced to the next declaration by name, this
    // silently widened to the end of the file the moment that name moved -
    // and every assertion below then passed against whatever text happened
    // to be down there, which helpers/source.js warns about at length.
    const round = () => bodyOf(source, "const executeRound");

    it("announces and completes under the same judgement", () => {
        assert.match(round(), /const announce = members\[0]\.provider !== "preview"/,
            "the completion cannot mirror an announcement judged inline");
        assert.match(round(), /setRunning\(true, announce\)/,
            "testStarted is no longer gated the way roundFinished is");
    });

    /**
     * And it reads its verdict while it is still the round.
     *
     * roundOutcome asks the stored rows a question, and the read used to be
     * started and left: the finally returned, the latch dropped, and the answer
     * arrived afterwards - against a database a shutdown may have closed, or
     * one the next round has already begun writing to. The read belongs to the
     * round; only the ping it feeds is allowed to outlive it, because a
     * notifier must not hold a round open.
     */
    it("answers its one start with one completion, however the round ends", () => {
        // Comments stripped before anything is anchored: the finally explains
        // roundOutcome in prose right beside the call, and an anchor that a
        // sentence can satisfy stops meaning the code.
        const ending = withoutJsComments(round().slice(round().indexOf("} finally {")));

        assert.match(ending, /const outcome = announce/,
            "a round that announced itself can end without answering the /start it opened");
        // Awaited behind its deadline race now - runStateRelease.test.js owns
        // the deadline's own pins; what matters here is that the verdict is
        // still read, and awaited, inside the finally.
        assert.match(ending, /await Promise\.race\(\[\s*roundOutcome\(/,
            "the round no longer reads its own verdict");
        assert.match(ending, /sendRoundFinished\(outcome\)/,
            "the verdict is read and then not sent");
    });

    /**
     * And the verdict is read while the latch still holds.
     *
     * roundOutcome queries the rows this round just wrote, and on a driver
     * whose awaits yield the event loop (MySQL, not the sqlite shim) a manual
     * run can tryReserve() during that read - _isRunning having already been
     * cleared - start its own round, and then create()'s finally drops the
     * latch a second time, out from under the new round. So the read comes
     * before the latch is dropped; only the ping it feeds is detached.
     */
    it("reads its verdict before it drops the latch", () => {
        // Stripped for the reason above: a parenthesised prose mention of
        // roundOutcome ahead of the real call would satisfy this anchor while
        // the call itself moved below the release - the exact drift the
        // ordering assertion exists to catch.
        const ending = withoutJsComments(round().slice(round().indexOf("} finally {")));
        const reads = ending.indexOf("roundOutcome(");
        const drops = ending.indexOf("setRunning(false, false)");

        assert.notEqual(reads, -1, "the round no longer reads its verdict in the finally");
        assert.notEqual(drops, -1, "the round no longer drops the latch in its finally");
        assert.ok(reads < drops,
            "the latch is dropped before the verdict is read, so a manual run can slip into the read");
    });

    it("counts a watched member's failure however it failed", () => {
        assert.match(round(), /if \(fresh\.alerts && outcome\.failed\) roundFailures\+\+/,
            "a recorded failure of a watched member does not reach the round's outcome");
        assert.match(round(), /if \(reached && member\.alerts\) roundFailures\+\+/,
            "a member that could not even record is not counted as the failure it is");
    });

    /**
     * But only for a member the round actually reached.
     *
     * The guards moved inside the per-member handler so that a failing one
     * could not drop the rest of the round - and every one of them is a
     * database read, so a transient refusal from the quiet-hours config was
     * then counted as the line failing. One flaky read pinged healthchecks
     * /fail on an instance whose every stored row was a success.
     */
    it("counts nothing for a member whose run never started", () => {
        const body = round();
        const marked = body.indexOf("reached = true");
        const runs = body.indexOf("await executeTarget(fresh, type)");

        assert.notEqual(marked, -1, "nothing records whether the member's run began");
        assert.match(body, /if \(reached && member\.alerts\)/,
            "the mark is set and then not consulted");

        // Named one by one rather than by slicing the text between the try and
        // the mark: measured that way, a mark moved above the guards leaves an
        // empty slice, and an empty slice contains nothing to object to.
        for (const guard of ["pauseController.currentState", "withinQuietHours()",
            "targetsController.getOne(target.id)", "memberHeld(fresh"]) {
            const at = body.indexOf(guard);

            assert.notEqual(at, -1, `the loop no longer consults ${guard}`);
            assert.ok(at < marked,
                `${guard} runs after the member is marked as reached, so its failure is charged to the line`);
        }

        assert.ok(marked < runs,
            "the member is marked as reached only once it has already run");
    });

    it("is told the outcome by the member that ran", () => {
        assert.match(source, /return \{failed: false};/,
            "executeTarget no longer answers how the member went");
        assert.match(source, /return \{failed: true};/,
            "executeTarget's failure path no longer answers how the member went");
    });

    /**
     * The verdict is about the watched lines, not about the members this
     * round happened to reach. A hold, a pause or a stale member can leave a
     * failing line unmeasured, and a round that counted no failures of its
     * own then pinged the success URL while the keep-alive - reading the
     * stored rows a minute later - pinged /fail: one check, flapping.
     */
    it("asks the same question of the stored rows the keep-alive asks", () => {
        const outcome = bodyOf(source, "const roundOutcome");

        assert.match(outcome, /failures > 0 \|\| await watchedFailureStands\(\)/,
            "the round's verdict and the keep-alive's can disagree about the same lines");
    });

    /**
     * The guards the loop consults are database reads of their own, and a
     * read that fails is this member's failure - not a reason to leave the
     * loop through the finally with every remaining member unmeasured and
     * nothing written to error.log.
     */
    it("classifies its own guards' failures as the member's", () => {
        // From inside the loop, not from the round: the round opens a try of
        // its own around the whole loop, and measuring against that one
        // passes however the per-member guards are arranged.
        const body = round();
        const walks = body.indexOf("for (const [index, target] of members.entries())");
        assert.notEqual(walks, -1, "the round no longer walks its members in the loop this reads");

        const loop = body.slice(walks);
        const opened = loop.indexOf("try {");
        const paused = loop.indexOf("pauseController.currentState");
        const reread = loop.indexOf("targetsController.getOne(target.id)");

        assert.notEqual(opened, -1, "the loop no longer guards its members at all");
        assert.notEqual(reread, -1, "the loop no longer re-reads its members");
        assert.ok(opened < paused && opened < reread,
            "a database failure inside the loop's own guards escapes the per-member handler");
    });

    /**
     * The per-test events leave for every member; the payload says whether the
     * member alerts. Gated at the source, a target with alerting off published
     * nothing to InfluxDB, MQTT or the webhooks either - the diagnostic box
     * measured every round and no time series ever heard of it - while the
     * switch is labelled "Alerts & recommendations". suppressesEvent is where
     * the flag is judged, because notifier-versus-sink already lives there.
     */
    it("sends every member's events and lets the fan-out route them", () => {
        assert.doesNotMatch(source, /if \(target\.alerts\) send/,
            "an unwatched member's data never reaches the sinks");
        assert.equal((source.match(/alerts: Boolean\(target\.alerts\)/g) ?? []).length, 2,
            "a payload does not say whether its member alerts, so the notifiers cannot stay quiet");
    });

    /**
     * Reading the table to decide whether a member leads the round is not worth
     * failing a measured test over - the payload's own contract says an absent
     * flag reads as the primary. But degrading to `true` is not a shrug: it is
     * the claim "this member owns the base MQTT topic", and a secondary making
     * it publishes its numbers where the first line's Home Assistant sensors
     * read, which is the exact re-attribution isPrimaryMember was written to
     * stop. The last answer this member actually got is the honest fallback;
     * `true` is only for one that has never been answered at all.
     */
    it("degrades to the last answer it had rather than to a claim", () => {
        assert.equal((source.match(/primary: await wasPrimaryMember\(target\)/g) ?? []).length, 2,
            "a database blip while naming the primary is treated as a failed test and retried");
        assert.doesNotMatch(source, /isPrimaryMember\(target\)\.catch\(\(\) => true\)/,
            "a secondary member claims the base topic whenever the targets table blinks");
    });
});
