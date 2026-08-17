import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readSource, listSources } from "../helpers/source.js";
import IntegrationData from "../../server/models/IntegrationData.js";

const attributes = IntegrationData.getAttributes();

/**
 * The model declared its required columns with `required: true`, which is
 * mongoose's spelling. Sequelize does not know the key and silently ignores it,
 * so the model asserted nothing at all about nullability.
 *
 * The table itself was always right - migration 0001 creates integration_data
 * with allowNull: false on id and name - so nothing was ever stored wrong. What
 * was lost is the layer above it: with no declaration on the model, sequelize
 * runs no validation before the insert, so a null name would travel to the
 * database and come back as a raw constraint violation from the driver rather
 * than a ValidationError naming the column. The two descriptions of one table
 * simply disagreed, and the one people read was the one that meant nothing.
 */
describe("the integration model's nullability", () => {
    it("says id may not be null", () => {
        assert.equal(attributes.id.allowNull, false);
    });

    it("says name may not be null", () => {
        assert.equal(attributes.name.allowNull, false,
            "the column the table requires is not required by the model");
    });

    it("leaves lastActivity nullable, which is what never having run means", () => {
        assert.notEqual(attributes.lastActivity.allowNull, false);
    });

    // The columns carrying a default are filled in by sequelize when absent, so
    // they are deliberately not declared either way.
    it("does not make a defaulted column required", () => {
        for (const column of ["displayName", "data", "activityFailed"])
            assert.notEqual(attributes[column].allowNull, false,
                `${column} has a default and cannot also be required`);
    });
});

/**
 * The same table, described twice. The migration is what the database actually
 * enforces; the model is what the application validates against. A disagreement
 * between them is invisible until a write fails at the wrong layer.
 */
describe("the model and the migration that creates its table", () => {
    const initialSetup = readSource("server/migrations/0001-initial-setup.js");

    // The integration_data block of the SCHEMA literal.
    const block = () => {
        const from = initialSetup.indexOf("integration_data:");
        assert.notEqual(from, -1, "the initial migration no longer creates integration_data");

        return initialSetup.slice(from, initialSetup.indexOf("\n    }", from));
    };

    for (const column of ["id", "name"]) {
        it(`agrees that ${column} is NOT NULL`, () => {
            assert.match(block(), new RegExp(`${column}:[^\\n]*allowNull:\\s*false`),
                `the migration no longer requires ${column}, but the model does`);
            assert.equal(attributes[column].allowNull, false);
        });
    }

    it("agrees that lastActivity is nullable", () => {
        assert.match(block(), /lastActivity:[^\n]*allowNull:\s*true/);
        assert.notEqual(attributes.lastActivity.allowNull, false);
    });
});

/**
 * `required` is mongoose. Sequelize ignores unknown keys rather than refusing
 * them, so the mistake is silent wherever it is made - which is why this asks
 * about every model rather than the one it was found in.
 */
describe("every model", () => {
    it("declares nullability in a spelling sequelize reads", () => {
        const offenders = listSources("server/models")
            .filter((file) => /^\s*required:/m.test(readSource(`server/models/${file}`)));

        assert.deepEqual(offenders, [],
            "a model declares `required:`, which sequelize ignores - it wanted `allowNull:`");
    });
});
