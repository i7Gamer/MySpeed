import Sequelize from 'sequelize';
import crypto from 'node:crypto';
import db from '../config/database.js';

/**
 * `allowNull`, not `required`.
 *
 * These three columns were declared with `required`, which is mongoose's
 * spelling - sequelize does not know the key and ignores it silently, so the
 * model asserted nothing at all about nullability. The table itself was always
 * right (migration 0001 creates it with allowNull: false on id and name), so
 * nothing was ever stored wrong; what was missing is the validation above it. A
 * null name would travel to the database and return a raw constraint violation
 * from the driver rather than a ValidationError naming the column.
 */
export default db.define("integration_data", {
    id: {
        type: Sequelize.STRING,
        allowNull: false,
        primaryKey: true,
        // A UUID rather than Math.random().toString(36): this is a primary key
        // with no collision handling, and randomUUID costs the same line.
        // Ids issued under the old scheme stay valid - they are stored.
        defaultValue: () => crypto.randomUUID()
    },
    displayName: {
        type: Sequelize.STRING,
        defaultValue: "Untitled"
    },
    name: {
        type: Sequelize.STRING,
        allowNull: false,
    },
    data: {
        type: Sequelize.JSON,
        defaultValue: {},
    },
    lastActivity: {
        // Nullable, which is what "has never run" means for this column - see
        // config/database.js, which leans on exactly that.
        type: Sequelize.DATE,
        allowNull: true
    },
    activityFailed: {
        type: Sequelize.BOOLEAN,
        defaultValue: false
    }
}, {freezeTableName: true, createdAt: false, updatedAt: false});