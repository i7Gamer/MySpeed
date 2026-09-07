import { DataTypes } from 'sequelize';

// The route a degraded run traced to its server, as a JSON table, or null.
//
// Nullable with no default: null is the whole of how a row says it was not
// traced, which is what every row on every instance that upgrades into this
// column already means, and what every row of a run that went well means too.
//
// TEXT rather than STRING: twenty hops with three latencies each run far past
// the 255 characters a VARCHAR holds, and MySQL in strict mode refuses rather
// than truncates - from inside the tail of a run that measured perfectly.
const COLUMN = {
    name: "hops",
    options: {type: DataTypes.TEXT, allowNull: true, defaultValue: null}
};

export async function up(queryInterface) {
    const tableDescription = await queryInterface.describeTable('speedtests');

    if (!tableDescription[COLUMN.name])
        await queryInterface.addColumn('speedtests', COLUMN.name, COLUMN.options);
}
