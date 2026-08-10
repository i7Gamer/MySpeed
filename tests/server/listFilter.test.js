import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Op } from "sequelize";
import { LIST_ORDER, listFilter } from "../../server/controller/speedtests.js";

const RANGE = {
    from: new Date(Date.UTC(2026, 7, 1, 0, 0, 0, 0)),
    to: new Date(Date.UTC(2026, 7, 7, 23, 59, 59, 999))
};

const BETWEEN = [RANGE.from.toISOString(), RANGE.to.toISOString()];

const AFTER = {created: "2026-08-05T09:30:00.000Z", id: 42};

/**
 * The list is ordered by `created` and used to be paged by `id < afterId`.
 * Those two only agree while ids ascend with time, which an import does not
 * guarantee: the history export is ordered by `created` descending and the
 * import inserts in that order, so a restored instance ends up with id 1 on its
 * NEWEST test. Every "load more" then asked for `id < 3` of a list whose next
 * rows were ids 40, 41, 42 - serving pages that repeated rows already on screen
 * while the rest were unreachable. The client deduplicates by id, so the reader
 * saw "Loading more" produce nothing at all, forever.
 *
 * Paging now follows the column the list is actually sorted by, with the id as
 * the tiebreaker for two tests written in the same millisecond.
 */
describe("listFilter", () => {
    it("asks for everything when nothing is selected", () => {
        assert.equal(listFilter({}), undefined);
        assert.equal(listFilter({after: null, range: null}), undefined);
    });

    it("bounds the range alone", () => {
        assert.deepEqual(listFilter({range: RANGE}), {created: {[Op.between]: BETWEEN}});
    });

    describe("the scroll cursor", () => {
        it("takes everything older than the last row it was given", () => {
            assert.deepEqual(listFilter({after: AFTER}), {
                [Op.or]: [
                    {created: {[Op.lt]: AFTER.created}},
                    {created: AFTER.created, id: {[Op.lt]: AFTER.id}}
                ]
            });
        });

        // Without the tiebreaker, two tests sharing a timestamp either both
        // appear on both pages or the second is skipped entirely.
        it("breaks a tie on the same timestamp by id", () => {
            const tie = listFilter({after: AFTER})[Op.or][1];

            assert.equal(tie.created, AFTER.created);
            assert.deepEqual(tie.id, {[Op.lt]: AFTER.id});
        });

        it("never pages by id alone again", () => {
            const clause = listFilter({after: AFTER});

            assert.equal(clause.id, undefined, "the cursor still constrains the id on its own");
        });
    });

    /**
     * Both halves constrain `created`, so written into one object the second
     * silently replaces the first - the range would vanish and the filtered
     * list would page straight out of its own window.
     */
    describe("a cursor inside a range", () => {
        const clause = listFilter({after: AFTER, range: RANGE});

        it("keeps both rather than one replacing the other", () => {
            assert.equal(Array.isArray(clause[Op.and]), true, "the two halves are not joined");
            assert.equal(clause[Op.and].length, 2);
        });

        it("still bounds the range", () => {
            assert.deepEqual(clause[Op.and][0], {created: {[Op.between]: BETWEEN}});
        });

        it("still carries the cursor", () => {
            assert.equal(Array.isArray(clause[Op.and][1][Op.or]), true);
        });
    });

    /**
     * A parent instance proxies these requests to its nodes, and a node may be
     * running a version that only understands `afterId`. The client sends both,
     * so the old node keeps working - and this one still answers a caller that
     * sends only the id, rather than dropping the cursor and restarting the
     * list from the newest test on every page.
     */
    describe("a caller that only knows the old id cursor", () => {
        it("pages by the id it was given", () => {
            assert.deepEqual(listFilter({afterId: 42}), {id: {[Op.lt]: 42}});
        });

        it("keeps the range beside it", () => {
            const clause = listFilter({afterId: 42, range: RANGE});

            assert.deepEqual(clause[Op.and][0], {created: {[Op.between]: BETWEEN}});
            assert.deepEqual(clause[Op.and][1], {id: {[Op.lt]: 42}});
        });

        // A cursor of 0 is not a cursor: `id < 0` matches nothing.
        it("ignores a cursor of zero rather than paging past the end", () => {
            assert.equal(listFilter({afterId: 0}), undefined);
        });

        it("gives way to the real cursor when both are present", () => {
            assert.deepEqual(listFilter({after: AFTER, afterId: 42}), listFilter({after: AFTER}));
        });
    });
});

/**
 * The cursor and the ordering are one design: paging by `created` with the id
 * as a tiebreaker only produces stable pages if the query sorts by exactly
 * those two, in that order.
 */
describe("LIST_ORDER", () => {
    it("sorts by the column the cursor walks, newest first", () => {
        assert.deepEqual(LIST_ORDER[0], ["created", "DESC"]);
    });

    it("settles ties the same way the cursor does", () => {
        assert.deepEqual(LIST_ORDER[1], ["id", "DESC"]);
    });
});
