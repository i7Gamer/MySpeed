import Sequelize from 'sequelize';
import db from '../config/database.js';

/**
 * One named provider+server pairing the round tests.
 *
 * `enabled` means "part of the scheduled round" - a disabled target is still
 * runnable by hand, which is what a diagnostic iperf3 box wants. `alerts`
 * decides whether thresholds and recommendations look at this target at all,
 * and the three optimal columns override the global optimal values when set -
 * null means "inherit", resolved in one place (controller/targets.js
 * resolveLimits) so the alert gate and the client's grading cannot drift.
 */
export default db.define("targets", {
    name: {
        type: Sequelize.STRING,
        allowNull: false
    },
    provider: {
        type: Sequelize.STRING,
        allowNull: false
    },
    serverId: {
        type: Sequelize.STRING,
        allowNull: true,
        defaultValue: null
    },
    endpoint: {
        type: Sequelize.STRING,
        allowNull: true,
        defaultValue: null
    },
    enabled: {
        type: Sequelize.BOOLEAN,
        allowNull: false,
        defaultValue: true
    },
    alerts: {
        type: Sequelize.BOOLEAN,
        allowNull: false,
        defaultValue: true
    },
    optimalPing: {
        type: Sequelize.DOUBLE,
        allowNull: true,
        defaultValue: null
    },
    optimalDownload: {
        type: Sequelize.DOUBLE,
        allowNull: true,
        defaultValue: null
    },
    optimalUpload: {
        type: Sequelize.DOUBLE,
        allowNull: true,
        defaultValue: null
    },
    sortOrder: {
        type: Sequelize.INTEGER,
        allowNull: false,
        defaultValue: 0
    },
    // Written by the controller as new Date().toISOString(), the same
    // UTC-ISO-string-at-rest convention speedtests.created established.
    created: {
        type: process.env.DB_TYPE === "mysql" ? Sequelize.STRING : Sequelize.TIME,
        defaultValue: Sequelize.NOW
    }
}, {createdAt: false, updatedAt: false});
