import { DataTypes } from 'sequelize';

// Which provider measured the row. Nothing recorded it before, so a history that
// spans a provider change reads as one unbroken series of the same measurement -
// and the three do not measure the same thing. Only Ookla reports packet loss and
// the latency under load, so on a Cloudflare or LibreSpeed row those facts are
// simply absent, and until now nothing on the row explained why.
//
// Nullable because every row recorded before this genuinely does not know which
// provider produced it, and guessing from the current setting would be a lie
// about exactly the rows the column exists to explain.
const COLUMN = "provider";

export async function up(queryInterface) {
    const tableDescription = await queryInterface.describeTable('speedtests');
    if (tableDescription[COLUMN]) return;

    await queryInterface.addColumn('speedtests', COLUMN, {
        type: DataTypes.STRING,
        allowNull: true,
        defaultValue: null
    });
}
