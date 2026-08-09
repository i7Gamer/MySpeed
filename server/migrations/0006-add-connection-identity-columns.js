import { DataTypes } from 'sequelize';

// Who the connection was, as the provider saw it. Both are reported on every
// Ookla run and were discarded; a changed address or provider explains a step in
// the numbers that otherwise reads as the line itself degrading.
const COLUMNS = ["isp", "externalIp"];

export async function up(queryInterface) {
    const tableDescription = await queryInterface.describeTable('speedtests');

    for (const column of COLUMNS) {
        if (!tableDescription[column]) {
            await queryInterface.addColumn('speedtests', column, {
                type: DataTypes.STRING,
                allowNull: true,
                defaultValue: null
            });
        }
    }
}
