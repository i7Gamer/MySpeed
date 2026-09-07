import { DataTypes } from 'sequelize';

// The tokens an operator issues so that a script can start a test without
// holding the admin password. Only the sha256 digest of a token is stored -
// see models/ApiTokens.js for the columns and controller/tokens.js for the
// lookup the index serves.
const TABLE = 'api_tokens';

// Named, so the index can be found and checked by name on every dialect
// rather than by whatever each one generates.
export const DIGEST_INDEX_NAME = 'api_tokens_digest_unique';

const SCHEMA = {
    id: {type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true, allowNull: false},
    name: {type: DataTypes.STRING, allowNull: false},
    // VARCHAR(64): a unique index over a bare STRING's 255 utf8mb4 characters
    // is more than MySQL's compact row format allows.
    digest: {type: DataTypes.STRING(64), allowNull: false},
    scope: {type: DataTypes.STRING, allowNull: false},
    created: {type: DataTypes.STRING, allowNull: false},
    lastUsed: {type: DataTypes.STRING, allowNull: true, defaultValue: null}
};

export async function up(queryInterface) {
    const existing = new Set(await queryInterface.showAllTables());

    if (!existing.has(TABLE)) await queryInterface.createTable(TABLE, SCHEMA);

    const indexes = await queryInterface.showIndex(TABLE);

    if (!indexes.some((index) => index.name === DIGEST_INDEX_NAME))
        await queryInterface.addIndex(TABLE, ['digest'], {name: DIGEST_INDEX_NAME, unique: true});
}
