import { DataTypes } from 'sequelize';

// The share of its own rolling median a target is judged against, or null.
//
// Nullable with no default, the spelling the three optimal columns use: null is
// the whole of how a target says it has no baseline, and it is what every row
// on every instance that upgrades into this column already means. A NOT NULL
// column with a percentage written into it would arm the feature on every
// target the moment the migration ran.
//
// A DOUBLE rather than an INTEGER because the door accepts a fraction - 72.5
// per cent of a line is an ordinary thing to want - and an integer column would
// round it on the way in with nothing saying so.
const COLUMN = {
    name: "baselinePercent",
    options: {type: DataTypes.DOUBLE, allowNull: true, defaultValue: null}
};

export async function up(queryInterface) {
    const tableDescription = await queryInterface.describeTable('targets');

    if (!tableDescription[COLUMN.name])
        await queryInterface.addColumn('targets', COLUMN.name, COLUMN.options);
}
