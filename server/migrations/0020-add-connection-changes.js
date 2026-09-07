import { DataTypes } from 'sequelize';

// The log of runs that saw the external address or the provider change -
// see models/ConnectionChanges.js for the columns and
// controller/connectionChanges.js for the reads the index serves.
const TABLE = 'connection_changes';

// Named, so the index can be found and checked by name on every dialect
// rather than by whatever each one generates. The list and the prune both
// walk the table by instant.
export const CREATED_INDEX_NAME = 'connection_changes_created';

const SCHEMA = {
    id: {type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true, allowNull: false},
    created: {type: DataTypes.STRING, allowNull: false},
    // No foreign key: the retention sweep deletes the test long before
    // anyone stops caring when the address rotated.
    testId: {type: DataTypes.INTEGER, allowNull: true, defaultValue: null},
    targetId: {type: DataTypes.INTEGER, allowNull: true, defaultValue: null},
    provider: {type: DataTypes.STRING, allowNull: false},
    previousIp: {type: DataTypes.STRING, allowNull: true, defaultValue: null},
    ip: {type: DataTypes.STRING, allowNull: true, defaultValue: null},
    previousIsp: {type: DataTypes.STRING, allowNull: true, defaultValue: null},
    isp: {type: DataTypes.STRING, allowNull: true, defaultValue: null}
};

export async function up(queryInterface) {
    const existing = new Set(await queryInterface.showAllTables());

    if (!existing.has(TABLE)) await queryInterface.createTable(TABLE, SCHEMA);

    const indexes = await queryInterface.showIndex(TABLE);

    if (!indexes.some((index) => index.name === CREATED_INDEX_NAME))
        await queryInterface.addIndex(TABLE, ['created'], {name: CREATED_INDEX_NAME});
}
