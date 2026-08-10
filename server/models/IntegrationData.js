import Sequelize from 'sequelize';
import crypto from 'node:crypto';
import db from '../config/database.js';

export default db.define("integration_data", {
    id: {
        type: Sequelize.STRING,
        required: true,
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
        required: true,
    },
    data: {
        type: Sequelize.JSON,
        defaultValue: {},
    },
    lastActivity: {
        type: Sequelize.DATE,
        required: false
    },
    activityFailed: {
        type: Sequelize.BOOLEAN,
        defaultValue: false
    }
}, {freezeTableName: true, createdAt: false, updatedAt: false});