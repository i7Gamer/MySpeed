import Sequelize from 'sequelize';
import db from '../config/database.js';

export default db.define("recommendations", {
    ping: {
        // DOUBLE, as the two beside it and as speedtests.ping - see migration
        // 0012. An INTEGER here rounded away the fraction that is most of a
        // latency reading on a fast line, and a sub-millisecond one became 0 -
        // which reads as the best latency ever measured and so can never be
        // improved on by a later test.
        type: Sequelize.DOUBLE,
        allowNull: false
    },
    download: {
        type: Sequelize.DOUBLE,
        allowNull: false
    },
    upload: {
        type: Sequelize.DOUBLE,
        allowNull: false
    }
}, {createdAt: false, updatedAt: false});