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
    ping: {
        type: Sequelize.INTEGER,
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
    error: {
        type: Sequelize.STRING,
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