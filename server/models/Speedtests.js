import Sequelize from 'sequelize';
import db from '../config/database.js';

export default db.define("speedtests", {
    id: {
        type: Sequelize.INTEGER,
        primaryKey: true,
        autoIncrement: true,
    },
    serverId: {
        type: Sequelize.INTEGER,
        defaultValue: 0
    },
    serverName: {
        type: Sequelize.STRING,
        allowNull: true,
        defaultValue: null
    },
    serverHost: {
        type: Sequelize.STRING,
        allowNull: true,
        defaultValue: null
    },
    // Where the server is, as against who runs it: `serverName` holds what
    // Ookla calls the server's name, which is the sponsor. Only Ookla reports
    // this, so null means the provider does not say.
    serverLocation: {
        type: Sequelize.STRING,
        allowNull: true,
        defaultValue: null
    },
    // Which provider measured the row. The three do not measure the same things,
    // so without this a blank packet loss could equally mean a clean line or a
    // provider that never looked. Null on every row recorded before the column
    // existed, which genuinely cannot say.
    provider: {
        type: Sequelize.STRING,
        allowNull: true,
        defaultValue: null
    },
    // DOUBLE, like every other measurement on the row. As INTEGER this rounded
    // the latency to whole milliseconds before it was stored - which is most of
    // the reading on a fibre or local line, and unrecoverable afterwards since
    // the API, the export and the integrations all read the stored column.
    ping: {
        type: Sequelize.DOUBLE,
        allowNull: false
    },
    jitter: {
        type: Sequelize.DOUBLE,
        allowNull: true,
        defaultValue: null
    },
    download: {
        type: Sequelize.DOUBLE,
        allowNull: false
    },
    upload: {
        type: Sequelize.DOUBLE,
        allowNull: false
    },
    // Null rather than zero when absent: rows recorded before these existed, and
    // providers that do not measure them, have no value - not a perfect one.
    packetLoss: {
        type: Sequelize.DOUBLE,
        allowNull: true,
        defaultValue: null
    },
    // The interquartile mean of the latency measured while that direction was
    // saturated, i.e. what the line does under load rather than idle.
    downloadLatency: {
        type: Sequelize.DOUBLE,
        allowNull: true,
        defaultValue: null
    },
    uploadLatency: {
        type: Sequelize.DOUBLE,
        allowNull: true,
        defaultValue: null
    },
    // Who the connection was, as the provider saw it. Only Ookla reports these.
    isp: {
        type: Sequelize.STRING,
        allowNull: true,
        defaultValue: null
    },
    externalIp: {
        type: Sequelize.STRING,
        allowNull: true,
        defaultValue: null
    },
    // What the run itself cost in traffic. DOUBLE rather than BIGINT: a byte
    // count is far below the 2^53 a double holds exactly, and sequelize hands
    // BIGINT back as a string on some dialects - which would reach the interface
    // as a string on MySQL and a number on sqlite.
    bytesDownloaded: {
        type: Sequelize.DOUBLE,
        allowNull: true,
        defaultValue: null
    },
    bytesUploaded: {
        type: Sequelize.DOUBLE,
        allowNull: true,
        defaultValue: null
    },
    // TEXT, not STRING: this holds whatever the CLI printed to stderr, which
    // routinely runs past the 255 characters a VARCHAR gives it. sqlite ignores
    // the length, but MySQL in strict mode refused the insert - and it did so
    // from inside the handler that records failed tests, so the failure was
    // never stored at all.
    error: {
        type: Sequelize.TEXT,
        allowNull: true
    },
    type: {
        type: Sequelize.STRING,
        defaultValue: "auto"
    },
    resultId: {
        type: Sequelize.STRING,
        allowNull: true
    },
    time: {
        type: Sequelize.INTEGER,
        defaultValue: 0
    },
    created: {
        type: process.env.DB_TYPE === "mysql" ? Sequelize.STRING : Sequelize.TIME,
        defaultValue: Sequelize.NOW
    }
}, {createdAt: false, updatedAt: false});