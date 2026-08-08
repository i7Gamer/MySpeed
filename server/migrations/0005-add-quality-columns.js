import { DataTypes } from 'sequelize';

// Packet loss and the latency measured while each direction was saturated. The
// provider has always reported them and they were dropped; they are nullable
// because every row recorded before this, and every test from a provider that
// does not measure them, genuinely has no value rather than a value of zero.
const COLUMNS = ["packetLoss", "downloadLatency", "uploadLatency"];

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
