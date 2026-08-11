import { DataTypes } from 'sequelize';

// How much the test itself moved in each direction. Ookla and LibreSpeed both
// report it and it was dropped on the floor; Cloudflare's payload sizes give it
// exactly. One Ookla run measured here moved 1.14 GB down and 0.92 GB up, which
// is worth knowing before scheduling one every fifteen minutes on a metered line.
//
// DOUBLE rather than BIGINT: a byte count is far below the 2^53 an IEEE double
// holds exactly, and sequelize hands BIGINT back as a string on some dialects -
// which would reach the interface as a string on MySQL and a number on sqlite.
// The rest of this table's numeric columns are DOUBLE for the same reason.
const COLUMNS = ["bytesDownloaded", "bytesUploaded"];

export async function up(queryInterface) {
    const tableDescription = await queryInterface.describeTable('speedtests');

    for (const column of COLUMNS) {
        if (!tableDescription[column]) {
            await queryInterface.addColumn('speedtests', column, {
                type: DataTypes.DOUBLE,
                allowNull: true,
                defaultValue: null
            });
        }
    }
}
