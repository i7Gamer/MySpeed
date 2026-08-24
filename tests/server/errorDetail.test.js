import { describe, it } from "node:test";
import assert from "node:assert/strict";
import Sequelize from "sequelize";
import { readSource } from "../helpers/source.js";
import { describeError } from "../../server/util/errorDetail.js";

const {ValidationError, ValidationErrorItem, UniqueConstraintError, DatabaseError} = Sequelize;

/**
 * "An error occurred: Validation error", and nothing else, for 138 restarts.
 *
 * Upstream #1549: a boot that got as far as opening the database and then failed
 * with those three words, and the reporter's only way out was to delete the
 * database and lose the history. The message is the whole of what sequelize
 * volunteers - the columns, the rule and the constraint that actually failed all
 * live on properties of the error that nothing here read - so the operator was
 * told that something was invalid and given no way to find out what.
 *
 * The same fix importConfig already got in 1.3.5, applied to the other end: a
 * refusal that names what it refused.
 */
describe("describeError", () => {
    /**
     * The realistic shape of #1549, and the worst one: with no items to build a
     * message from, sequelize's ValidationError constructor falls back to the
     * two bare words, and a unique-constraint failure from the driver arrives
     * exactly like that.
     */
    describe("a validation error carrying no items", () => {
        it("names the class of error, which is all there is to name", () => {
            const described = describeError(new UniqueConstraintError({}));

            assert.match(described, /SequelizeUniqueConstraintError/,
                "the operator is told 'Validation Error' and not which kind");
        });

        it("names the driver's own code when there is one", () => {
            const parent = new Error("UNIQUE constraint failed: nodes.url");
            parent.code = "SQLITE_CONSTRAINT";

            const described = describeError(new UniqueConstraintError({parent}));

            assert.match(described, /SQLITE_CONSTRAINT/);
        });

        /**
         * `fields` is where UniqueConstraintError puts the columns that clashed.
         * The keys only - see the note about values below.
         */
        it("names the columns that clashed", () => {
            const described = describeError(new UniqueConstraintError({fields: {url: "http://node.example"}}));

            assert.match(described, /\burl\b/, "the clashing column is not named");
        });
    });

    describe("a validation error carrying items", () => {
        const items = [
            new ValidationErrorItem("speedtests.ping cannot be null", "notNull Violation", "ping", null),
            new ValidationErrorItem("Validation isNumeric on download failed", "Validation error", "download", "abc")
        ];

        it("names every column and the rule each one broke", () => {
            const described = describeError(new ValidationError("Validation error", items));

            assert.match(described, /ping/);
            assert.match(described, /download/);
            assert.match(described, /notNull Violation/);
        });

        /**
         * Sequelize builds a detailed message itself when it is handed no
         * message argument, and several of its own paths do exactly that. The
         * details must not then be printed twice.
         */
        it("does not repeat what the message already said", () => {
            const described = describeError(new ValidationError(null, items));
            const occurrences = described.split("notNull Violation").length - 1;

            assert.equal(occurrences, 1, "the same detail is reported twice in one line");
        });
    });

    /**
     * The 1.3.4 rule - integration credentials stay out of the log - applies
     * here too, and it is why the *value* is never reported. A validation error
     * is as likely to fire on the password hash, a node password or an
     * integration token as on a measurement, and this text is written to
     * data/logs/error.log, which is what bug reports get attached to.
     *
     * The path and the rule are enough to find the row by hand; the value is
     * not needed to do it.
     */
    describe("what it refuses to say", () => {
        it("never reports the value that was refused", () => {
            const secret = "s3cr3t-telegram-token";
            const item = new ValidationErrorItem("Validation len on token failed", "Validation error", "token", secret);

            const described = describeError(new ValidationError("Validation error", [item]));

            assert.ok(!described.includes(secret), "a refused credential was written to the log");
        });

        it("never reports the value a unique constraint clashed on", () => {
            const secret = "https://hooks.example/T000/B000/xxxxx";

            const described = describeError(new UniqueConstraintError({fields: {url: secret}}));

            assert.ok(!described.includes(secret), "a refused webhook URL was written to the log");
        });
    });

    /**
     * An ordinary error has nothing hidden behind it, and must come back exactly
     * as it went in - this sits on the uncaughtException path, where almost
     * everything that arrives is an ordinary error.
     */
    describe("an error with nothing to add", () => {
        it("is left alone", () => {
            assert.equal(describeError(new Error("No interfaces found")), "No interfaces found");
        });

        it("does not announce the base Error class", () => {
            assert.ok(!describeError(new Error("boom")).includes("Error ("),
                "every ordinary error now carries a parenthetical saying it is an Error");
        });
    });

    /**
     * It is reached from the uncaughtException handler, so it is handed whatever
     * was thrown. A throw in here would end the process with neither the
     * original error nor this one written down, which is the one failure the
     * last line of defence cannot have.
     */
    describe("being handed something that is not an error", () => {
        const survives = (value) => assert.equal(typeof describeError(value), "string");

        it("survives a bare string", () => survives("just a string"));
        it("survives null and undefined", () => {
            survives(null);
            survives(undefined);
        });
        it("survives a plain object", () => survives({message: "plain"}));
        it("survives an object with no prototype", () => survives(Object.create(null)));

        it("survives properties that throw when read", () => {
            const hostile = new Error("hostile");
            Object.defineProperty(hostile, "errors", {get: () => { throw new Error("no"); }});

            survives(hostile);
        });

        it("survives errors whose items are not items", () => {
            const wrong = new ValidationError("Validation error", ["not an item", null, 7]);

            survives(wrong);
        });
    });

    // A DatabaseError's own message already carries the driver's text, so the
    // parent must not be appended a second time.
    describe("a database error", () => {
        it("does not repeat the driver message it already quotes", () => {
            const parent = new Error("SQLITE_CORRUPT: database disk image is malformed");
            parent.code = "SQLITE_CORRUPT";

            const described = describeError(new DatabaseError(parent));
            const occurrences = described.split("database disk image is malformed").length - 1;

            assert.equal(occurrences, 1);
        });
    });
});

/**
 * The two places an operator actually reads one of these.
 *
 * Asserted by reading, because firing them means an uncaught exception or a
 * failed migration inside a live boot - and both end the process, which is the
 * behaviour the assertion is not about.
 */
describe("where the detail is used", () => {
    it("is what the startup failure reports", () => {
        const source = readSource("server/index.js");

        assert.match(source, /describeError/,
            "a boot that cannot finish still reports only what sequelize volunteers");
        assert.ok(!/could not finish starting up: "\s*\+\s*\(err\?\.message/.test(source),
            "the startup failure still prints the bare message");
    });

    it("is what the error log records", () => {
        assert.match(readSource("server/util/errorHandler.js"), /describeError/,
            "data/logs/error.log still records only what sequelize volunteers");
    });
});
