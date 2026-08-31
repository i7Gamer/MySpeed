import { DataTypes } from 'sequelize';

// How long one direction of an iperf3 target's test measures for, and over how
// many parallel streams. Nullable with no default on purpose: null is not "no
// value" but "inherit the registry default", the same spelling the three
// optimal columns already use - so every row that exists keeps measuring
// exactly as it did, and a later change to that default reaches them all.
//
// INTEGER because iperf3 takes whole seconds and whole connections. Both are
// small enough that the dialect differences DOUBLE was chosen for on the
// speedtests byte counts do not arise.
const COLUMNS = ["iperfDuration", "iperfStreams"];

export async function up(queryInterface) {
    const tableDescription = await queryInterface.describeTable('targets');

    for (const column of COLUMNS) {
        if (!tableDescription[column]) {
            await queryInterface.addColumn('targets', column, {
                type: DataTypes.INTEGER,
                allowNull: true,
                defaultValue: null
            });
        }
    }
}
