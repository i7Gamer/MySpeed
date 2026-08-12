import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { Sequelize } from "sequelize";

/**
 * The DATE override that decides what a date column actually stores.
 *
 * config/database.js replaces Sequelize.DATE.prototype._stringify so every DATE
 * is written as an ISO-8601 UTC string rather than in whatever local form the
 * dialect would pick. It falls back to "now" for a value that is not a date,
 * which is right for a garbage string - but `new Date(null)` is not garbage to
 * JavaScript. It is the epoch, a perfectly valid time, so a null sailed past
 * the isNaN guard and was stored as 1970-01-01. `undefined` did hit the guard
 * and was stored as the moment of the write.
 *
 * integration_data.lastActivity is nullable and means "has never run". Both
 * paths destroyed that: a fresh integration came back claiming it had just run,
 * and one whose activity was cleared came back having last run in 1970.
 */

let stringify;

before(async () => {
    // Imported for its side effect - the prototype override is installed at
    // module scope. Defining the models does not open the database.
    await import("../../server/config/database.js");
    stringify = Sequelize.DATE.prototype._stringify;
});

describe("the DATE column stringifier", () => {
    it("is installed by the database module", () => {
        assert.equal(typeof stringify, "function");
    });

    it("writes a Date as an ISO-8601 UTC string", () => {
        const date = new Date("2024-03-01T10:00:00.000Z");

        assert.equal(stringify(date), "2024-03-01T10:00:00.000Z");
    });

    it("passes an ISO string through unchanged", () => {
        assert.equal(stringify("2024-03-01T10:00:00.000Z"), "2024-03-01T10:00:00.000Z");
    });

    it("normalises a local-form date to UTC", () => {
        assert.equal(stringify("2024-03-01T10:00:00+02:00"), "2024-03-01T08:00:00.000Z");
    });

    describe("a column that holds no date at all", () => {
        it("keeps null as null rather than inventing the epoch", () => {
            assert.equal(stringify(null), null,
                "null was stored as a real timestamp, so 'never' became 1970-01-01");
        });

        it("keeps undefined as undefined rather than inventing now", () => {
            assert.equal(stringify(undefined), undefined,
                "undefined was stored as the moment of the write, so 'never' became 'just now'");
        });
    });

    /**
     * Kept deliberately. A string that is not a date at all cannot be written
     * to a date column, and "now" is what the column meant before this override
     * existed - better than writing an invalid string and failing the insert
     * from inside the handler that records failures.
     */
    it("still falls back to now for a value that is not a date", () => {
        const before = Date.now();
        const written = new Date(stringify("not a date at all")).getTime();

        assert.ok(!Number.isNaN(written), "an unparseable value produced an unparseable column");
        assert.ok(written >= before - 1000 && written <= Date.now() + 1000);
    });
});
