import Sequelize from 'sequelize';
import db from '../config/database.js';
import { SCOPE_RUN } from '../util/tokenScopes.js';

/**
 * A token the operator issued so that a script or a home-automation platform
 * can start a test without holding the admin password.
 *
 * The secret itself is never stored: the row keeps its sha256 digest, and a
 * request is judged by looking the digest of what it carried up here. The
 * secret has 256 bits of entropy, so a cheap hash is enough and bcrypt's cost
 * would buy nothing - see controller/tokens.js.
 *
 * The digest column is VARCHAR(64) rather than a bare STRING: a unique index
 * over 255 utf8mb4 characters is more than MySQL's compact row format allows.
 */
export default db.define("api_tokens", {
    id: {
        type: Sequelize.INTEGER,
        primaryKey: true,
        autoIncrement: true
    },
    name: {
        type: Sequelize.STRING,
        allowNull: false
    },
    digest: {
        type: Sequelize.STRING(64),
        allowNull: false,
        unique: true
    },
    scope: {
        type: Sequelize.STRING,
        allowNull: false,
        defaultValue: SCOPE_RUN
    },
    created: {
        type: Sequelize.STRING,
        allowNull: false
    },
    lastUsed: {
        type: Sequelize.STRING,
        allowNull: true,
        defaultValue: null
    }
}, {freezeTableName: true, createdAt: false, updatedAt: false});
