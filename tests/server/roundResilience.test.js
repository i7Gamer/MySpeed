import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { bodyIn, withoutJsComments } from "../helpers/source.js";
import { causesOf } from "../../server/util/databaseIntegrity.js";
import { outageFrom } from "../../server/util/databaseOutage.js";
import { memberFailure } from "../../server/tasks/speedtest.js";

/**
 * A round member that cannot even record its own failure used to take every
 * later member with it.
 *
 * executeTarget's catch ends on an unguarded write - the row that says the test
 * failed - and nothing between the loop body and the round's finally caught the
 * rejection. Targets three, four and five of a five-member round were never
 * measured and recorded nothing: no row, no error, no notification, and one line
 * from timer.js naming neither the round nor the members it dropped.
 *
 * Containing it is half the fix. The other half is that containment must not
 * keep a round running for minutes against a database that has gone.
 */
describe("what a failure that escaped a member says about the database", () => {
    it("reads sequelize's connection family as the database going away", () => {
        for (const name of ["SequelizeConnectionError", "SequelizeConnectionRefusedError",
            "SequelizeAccessDeniedError", "SequelizeHostNotReachableError"])
            assert.equal(outageFrom(Object.assign(new Error("boom"), {name})), true, `${name} was read as a bad row`);
    });

    // The driver's error is a level down, which is the whole reason this reads
    // through databaseIntegrity's walk rather than at the error it was handed.
    it("reads mysql2's dropped socket through the wrapper sequelize puts on it", () => {
        const wrapped = Object.assign(new Error("Connection lost: The server closed the connection."),
            {name: "SequelizeDatabaseError", parent: {code: "PROTOCOL_CONNECTION_LOST"}});

        assert.equal(outageFrom(wrapped), true);
    });

    /**
     * node:sqlite carries no SQLITE_ code at all: every error it throws is
     * `ERR_SQLITE_ERROR` with the real code in a numeric `errcode`, and most of
     * those are extended - SQLITE_IOERR_WRITE is 778, whose low byte is
     * SQLITE_IOERR. A classifier reading only string codes would have called a
     * full disk an ordinary bad row.
     */
    it("reads node:sqlite's numeric result codes, extended ones included", () => {
        assert.equal(outageFrom({parent: {code: "ERR_SQLITE_ERROR", errcode: 13,
            message: "database or disk is full"}}), true, "a full disk");
        assert.equal(outageFrom({parent: {code: "ERR_SQLITE_ERROR", errcode: 778,
            message: "disk I/O error"}}), true, "an extended IOERR");
        assert.equal(outageFrom({parent: {code: "ERR_SQLITE_ERROR", errcode: 1,
            message: "no such table: speedtests"}}), false, "an ordinary SQL fault ended the round");
    });

    // Neither of these carries a code worth matching: ERR_INVALID_STATE is general
    // enough to mean anything, and sequelize's is a plain Error.
    it("reads a handle closed underneath the write", () => {
        assert.equal(outageFrom({code: "ERR_INVALID_STATE", message: "database is not open"}), true);
        assert.equal(outageFrom(new Error(
            "ConnectionManager.getConnection was called after the connection manager was closed!")), true);
    });

    it("counts a file sqlite calls unreadable, which the boot check names damage", () => {
        assert.equal(outageFrom({parent: {code: "SQLITE_CORRUPT"}}), true);
        assert.equal(outageFrom({parent: {message: "database disk image is malformed"}}), true);
    });

    /**
     * And the ones the round must survive. The refusal in the middle is the one
     * that actually happened: MySQL in strict mode rejecting a stderr longer
     * than the column, from inside the handler that records failed tests. Every
     * later member had a shorter message and recorded perfectly well.
     */
    it("does not read a refused row as a broken database", () => {
        for (const error of [
            Object.assign(new Error("Validation error"), {name: "SequelizeValidationError"}),
            {parent: {code: "ER_DATA_TOO_LONG", message: "Data too long for column 'error' at row 1"}},
            {parent: {code: "SQLITE_BUSY", message: "database is locked"}},
            null, undefined, "gone", 5, {}, new Error("something")
        ]) assert.equal(outageFrom(error), false, `${JSON.stringify(error) ?? String(error)} ended the round`);
    });

    // It is called from the handler that keeps a member from ending the round, so
    // a throw in here would cause the very thing that handler exists to prevent.
    it("cannot itself throw", () => {
        const hostile = {};
        Object.defineProperty(hostile, "parent", {get() { throw new Error("no"); }});

        assert.equal(outageFrom(hostile), false);
        assert.deepEqual(causesOf(null), []);
    });
});

describe("what the round does with a member that could not record", () => {
    const refused = Object.assign(new Error("Validation error"), {name: "SequelizeValidationError"});
    const gone = Object.assign(new Error("Connection lost"), {parent: {code: "PROTOCOL_CONNECTION_LOST"}});
    const target = {id: 3, name: "Fritzbox"};

    it("carries on after the first, and says what is left", () => {
        const {abandoned, context} = memberFailure(refused, target, {escapes: 1, remaining: 3});

        assert.equal(abandoned, false, "one refused row ends a round of five");
        assert.match(context, /Fritzbox/, "the report names no target");
        assert.match(context, /remaining 3 targets/);
    });

    it("stops once two members in a row cannot record", () => {
        const {abandoned, context} = memberFailure(refused, target, {escapes: 2, remaining: 1});

        assert.equal(abandoned, true, "the round runs on measuring lines it cannot record");
        assert.match(context, /1 target unmeasured/, "a round of two is told it left '1 targets'");
    });

    it("stops at the first member when the database is what has gone", () => {
        const {abandoned, context} = memberFailure(gone, target, {escapes: 1, remaining: 2});

        assert.equal(abandoned, true);
        assert.match(context, /database is not answering/, "the operator is told it was two bad rows");
        assert.match(context, /2 targets unmeasured/);
    });

    it("does not report members it did not skip", () => {
        for (const escapes of [1, 2])
            assert.doesNotMatch(memberFailure(refused, target, {escapes, remaining: 0}).context, /0 targets/,
                "the last member of a round is reported as having stranded nothing");
    });

    // The demo target is a frozen stand-in with neither a name nor an id, and
    // "target null" in error.log tells an operator nothing at all.
    it("names the demo target", () => {
        assert.match(memberFailure(gone, {id: null, name: null}).context, /^The demo target/);
        assert.match(memberFailure(gone, {id: 7, name: null}).context, /^The target #7/);
    });
});

/**
 * And the round is wired to it. Firing the real path needs a database that
 * breaks halfway through a round, so the wiring is read - the way the failure
 * handler's is in runStateRelease.test.js.
 *
 * Read with the comments taken out first, which matters in both directions here.
 * bodyIn hands back raw source, and the guard this describes carries a comment
 * naming console.error to say why the report does not go there - so a
 * doesNotMatch over raw text finds the sentence that rejects the call and reads
 * it as the call, failing against the very code it is meant to pass. That is
 * source.js's own warning about a scan satisfied by prose, running backwards,
 * and withoutJsComments is what the suites that hit it forwards already use.
 */
describe("the round's guard", () => {
    const round = withoutJsComments(bodyIn("server/tasks/speedtest.js", "const executeRound"));
    const loop = round.slice(round.indexOf("for (const"), round.indexOf("} finally"));

    it("guards the member rather than the round", () => {
        assert.match(loop, /try\s*\{[\s\S]*?await executeTarget\(fresh, type\);[\s\S]*?\}\s*catch/,
            "a member's own failure handler can still end the round");
        assert.match(loop, /if \(abandoned\) break;/, "the round runs on whatever the failure was");
    });

    it("reports it where bug reports are read, not to the console", () => {
        assert.match(loop, /errorHandler\(error, \{fatal: false, context\}\)/,
            "a broken-database round leaves nothing in data/logs/error.log");
        assert.doesNotMatch(loop, /console\.error/,
            "the report was downgraded to a console line, which the log never sees");
    });

    it("starts the count again from a member that did record", () => {
        assert.match(loop, /await executeTarget\(fresh, type\);[\s\S]{0,400}?escapes = 0;/,
            "two unrelated bad rows a round apart end the round");
    });
});
