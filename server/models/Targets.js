import Sequelize from 'sequelize';
import db from '../config/database.js';

/**
 * One named provider+server pairing the round tests.
 *
 * `enabled` means "part of the scheduled round" - a disabled target is still
 * runnable by hand, which is what a diagnostic iperf3 box wants. `alerts`
 * decides whether thresholds and recommendations look at this target at all,
 * and the three optimal columns override the instance-wide optimal values
 * when set - null means "inherit". Grading is a client concern, so the
 * resolution lives in TargetUtil.js's resolveLimits; the server only
 * validates these three columns and stores what it is given. The alert gate
 * does not read them either - it grades a result against each integration's
 * own alert_ping_above, alert_download_below and alert_upload_below fields.
 *
 * The two iperf3 columns read the same way: null is "inherit the shipped
 * default", not "unmeasured", so an instance that upgrades into these columns
 * goes on measuring exactly as it did.
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
    // How long one direction of an iperf3 target's test measures for, and over
    // how many parallel streams - null on either meaning "the registry
    // default", resolved where the arguments are built (util/providers/registry
    // iperfRunSeconds). Whole numbers, which is all iperf3 takes, and inert on
    // every other provider - targetProblem refuses them there by name rather
    // than storing something no run will read.
    iperfDuration: {
        type: Sequelize.INTEGER,
        allowNull: true,
        defaultValue: null
    },
    iperfStreams: {
        type: Sequelize.INTEGER,
        allowNull: true,
        defaultValue: null
    },
    // Datagrams instead of a stream, and the rate they are sent at. Not the
    // "null inherits the default" spelling the two above use, because there is
    // no default to inherit: a run is either UDP or it is not, and every target
    // that exists is not. The rate belongs to the flag - null means this target
    // sends no datagrams - and targetProblem refuses the two rows that
    // disagree, because iperf3's own default rate is 1 Mbit/s and a line
    // measured at that is a plausible number in the right column.
    iperfUdp: {
        type: Sequelize.BOOLEAN,
        allowNull: false,
        defaultValue: false
    },
    iperfBitrate: {
        type: Sequelize.INTEGER,
        allowNull: true,
        defaultValue: null
    },
    // The share of this target's own rolling 30-day median a run has to fall
    // below before the notifiers are told - null meaning the target has no
    // baseline, which is every target until somebody sets one. The optimal
    // columns' spelling exactly, and for the same reason: a boolean beside it
    // would create a "switched on with no percentage" row that every reader
    // would need a rule for. What the number means, and the storm rule that
    // decides when a breach is actually announced, live in util/baselineAlert.
    baselinePercent: {
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
