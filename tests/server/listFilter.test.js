import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Op } from "sequelize";
import { listFilter } from "../../server/controller/speedtests.js";

const RANGE = {
    from: new Date(Date.UTC(2026, 7, 1, 0, 0, 0, 0)),
    to: new Date(Date.UTC(2026, 7, 7, 23, 59, 59, 999))
};

/**
 * The overview list gained a date range, so its where clause is now built from
 * two independent halves: the scroll cursor and the selected range. Sequelize
 * takes an object, so a second condition written carelessly replaces the first
 * rather than joining it - and the failure mode is silent, an infinite scroll
 * that quietly restarts from the newest test on every page.
 *
 * The clause is built by a function of its own so it can be checked without a
 * database, the way the rest of the server's logic is.
 */
describe("listFilter", () => {
    it("asks for everything when nothing is selected", () => {
        assert.equal(listFilter({}), undefined);
        assert.equal(listFilter({afterId: null, range: null}), undefined);
    });

    it("pages by the scroll cursor alone", () => {
        assert.deepEqual(listFilter({afterId: 42}), {id: {[Op.lt]: 42}});
    });

    it("bounds the range alone", () => {
        assert.deepEqual(listFilter({range: RANGE}), {
            created: {[Op.between]: [RANGE.from.toISOString(), RANGE.to.toISOString()]}
        });
    });

    // Both at once is the case that matters: scrolling a filtered list.
    it("keeps the cursor and the range together rather than one replacing the other", () => {
        const clause = listFilter({afterId: 42, range: RANGE});

        assert.deepEqual(clause, {
            id: {[Op.lt]: 42},
            created: {[Op.between]: [RANGE.from.toISOString(), RANGE.to.toISOString()]}
        });
    });

    // Compared as ISO-8601 UTC strings, the way findInRange already does it:
    // both writes guarantee that format, so a lexicographic BETWEEN is
    // chronological on every backend the project supports.
    it("compares the range as ISO-8601 strings, not as Date objects", () => {
        const [from, to] = listFilter({range: RANGE}).created[Op.between];

        assert.equal(typeof from, "string");
        assert.equal(typeof to, "string");
        assert.equal(from, "2026-08-01T00:00:00.000Z");
    });

    // A cursor of 0 is not a cursor: `id < 0` matches nothing, and the old
    // truthiness check treated it as absent for exactly that reason.
    it("ignores a cursor of zero rather than paging past the end", () => {
        assert.equal(listFilter({afterId: 0}), undefined);
    });
});
