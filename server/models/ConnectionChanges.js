import Sequelize from 'sequelize';
import db from '../config/database.js';

/**
 * One row per run that saw the connection change: the address it reported
 * against the last one of the same family, the network it named against the
 * last name the same provider gave.
 *
 * Only the half that changed is filled, so "the address rotated and the
 * provider did not" is readable off the row - see util/connectionChange.js.
 *
 * A table of its own rather than a query over the tests, because the
 * retention sweep deletes tests and the question "when did my address last
 * change" outlives the run that noticed. No foreign key on the test for the
 * same reason. Forgotten with the history all the same - by the sweep's own
 * cutoff, by "delete all tests" and by a factory reset - since an address
 * log that outlives the history it explains is a disclosure the operator
 * asked to end.
 */
export default db.define("connection_changes", {
    id: {
        type: Sequelize.INTEGER,
        primaryKey: true,
        autoIncrement: true
    },
    // The run's own instant, so the log sorts with the tests it describes.
    created: {
        type: Sequelize.STRING,
        allowNull: false
    },
    testId: {
        type: Sequelize.INTEGER,
        allowNull: true,
        defaultValue: null
    },
    targetId: {
        type: Sequelize.INTEGER,
        allowNull: true,
        defaultValue: null
    },
    provider: {
        type: Sequelize.STRING,
        allowNull: false
    },
    previousIp: {
        type: Sequelize.STRING,
        allowNull: true,
        defaultValue: null
    },
    ip: {
        type: Sequelize.STRING,
        allowNull: true,
        defaultValue: null
    },
    previousIsp: {
        type: Sequelize.STRING,
        allowNull: true,
        defaultValue: null
    },
    isp: {
        type: Sequelize.STRING,
        allowNull: true,
        defaultValue: null
    }
}, {freezeTableName: true, timestamps: false});
