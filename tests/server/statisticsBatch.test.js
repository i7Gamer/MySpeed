import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Op } from "sequelize";
import { MAX_BATCH_TARGETS, parseTargetsParam } from "../../server/routes/speedtests.js";
import { targetFilter } from "../../server/controller/speedtests.js";

/**
 * The `targets` parameter: one request that answers for every target the
 * comparison panel draws a column for.
 *
 * The panel used to ask per target, which is where this came from - the
 * statistics family is rate limited at sixty a minute, and a dozen targets
 * stepped through five timeframes is sixty-five requests, so the panel earned a
 * 429 and blanked itself for a reader who was only clicking around. That is
 * also why the panel's fetch was lazy: the cost was per target rather than per
 * page. One request makes it a page cost again, so the panel can be eager.
 */
describe("parseTargetsParam", () => {
    it("reads a comma-separated list of ids", () => {
        assert.deepEqual(parseTargetsParam("1,4,7"), {valid: true, ids: [1, 4, 7]});
    });

    it("reads a list of one, which is the ordinary case on a small instance", () => {
        assert.deepEqual(parseTargetsParam("3"), {valid: true, ids: [3]});
    });

    /**
     * Absent is not the same as empty, and only the first is a request that can
     * be answered without the parameter at all: undefined leaves the route on
     * its existing single-answer path, where `targets` was never mentioned.
     */
    it("answers undefined when the parameter is absent", () => {
        assert.equal(parseTargetsParam(undefined), undefined);
    });

    /**
     * The same notion of a usable id the single `target` filter has, applied to
     * every element - a list is not a place where "12abc" starts meaning
     * something it does not mean on its own.
     */
    it("refuses an id that is not a plain number", () => {
        for (const value of ["1,abc", "abc", "1,-2", "1.5", "1, 2", "0x4", "1,,2", "1,"]) {
            const parsed = parseTargetsParam(value);

            assert.equal(parsed.valid, false, `targets=${JSON.stringify(value)} was accepted`);
            assert.match(parsed.message, /targets parameter/);
        }
    });

    /**
     * Digits alone are not enough. `Number("9".repeat(400))` is Infinity, which
     * reaches the driver as a bind parameter no dialect can compare an INTEGER
     * column against - the request comes back a 500 saying only that it could
     * not be processed.
     *
     * The single `target` filter has the same hole and answers 500 for the same
     * input, which is a bug of its own and left alone here. A batch is the worse
     * place for it: one unusable id in a list of fifty loses the figures of the
     * other forty-nine, so this refusal is worth making whether or not the
     * single filter ever catches up.
     */
    it("refuses an id too large to be an id", () => {
        const parsed = parseTargetsParam(`1,${"9".repeat(400)}`);

        assert.equal(parsed.valid, false, "an id that reads as Infinity reached the database");
        assert.match(parsed.message, /targets parameter/);
    });

    /**
     * `?targets=1&targets=2` is the other way a caller might write a list, and
     * Express hands a repeated parameter over as an array - a string for one id
     * and an array for two, which is exactly the shape the comma-separated list
     * exists to avoid. Unguarded it is not a wrong answer but a 500: nothing but
     * a string has `split`.
     */
    it("refuses a repeated parameter rather than throwing on it", () => {
        const parsed = parseTargetsParam(["1", "2"]);

        assert.equal(parsed.valid, false);
        assert.match(parsed.message, /comma-separated/);
    });

    // A list nobody filled in is not a request for every target, and it is not
    // a request for none either - it is a caller that built its URL wrong, and
    // saying so is better than answering an empty object it will read as "this
    // instance has no targets".
    it("refuses an empty value rather than answering an empty batch", () => {
        const parsed = parseTargetsParam("");

        assert.equal(parsed.valid, false);
        assert.match(parsed.message, /at least one/i);
    });

    /**
     * Collapsed rather than refused: a repeated id is a caller building its
     * list from a page that names a target twice, not a request that cannot be
     * answered - and the answer for one id is the same answer however often it
     * was asked for.
     */
    it("collapses duplicate ids into one", () => {
        assert.deepEqual(parseTargetsParam("2,2,5,2"), {valid: true, ids: [2, 5]});
    });

    /**
     * The ceiling exists so one URL cannot ask for a payload of unbounded size.
     * It is counted after the duplicates collapse, because the work and the
     * bytes are both per distinct target.
     */
    it("refuses more distinct targets than the cap", () => {
        const withinCap = Array.from({length: MAX_BATCH_TARGETS}, (unused, index) => index + 1);

        assert.equal(parseTargetsParam(withinCap.join(",")).valid, true,
            "the cap itself has to be answerable, or it is a cap of one less");

        const overCap = parseTargetsParam([...withinCap, MAX_BATCH_TARGETS + 1].join(","));

        assert.equal(overCap.valid, false);
        assert.match(overCap.message, new RegExp(String(MAX_BATCH_TARGETS)),
            "the refusal has to say what the limit is, or the caller cannot correct it");
    });

    it("counts the cap against distinct ids, not against a repetitive list", () => {
        const repeated = Array.from({length: MAX_BATCH_TARGETS + 10}, () => "7").join(",");

        assert.deepEqual(parseTargetsParam(repeated), {valid: true, ids: [7]},
            "one target asked for many times is one target's worth of work");
    });
});

/**
 * How a read is narrowed to a target, to several, or to none at all.
 *
 * The list arm is the whole point of the batch: a request naming twelve targets
 * must read the range once with an IN, not twelve times with an equality. That
 * is a promise about the database, and the only place it is visible without
 * counting queries is here, in the fragment the read is built from.
 */
describe("targetFilter", () => {
    it("narrows to nothing at all when no target is named", () => {
        assert.deepEqual(targetFilter(undefined), {});
    });

    it("narrows to one target by equality", () => {
        assert.deepEqual(targetFilter(4), {targetId: 4});
    });

    it("narrows to several targets with a single IN", () => {
        assert.deepEqual(targetFilter([1, 4, 7]), {targetId: {[Op.in]: [1, 4, 7]}},
            "a filter per target is a scan per target, which is the cost the batch exists to remove");
    });
});
