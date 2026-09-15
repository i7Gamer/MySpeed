import { DataTypes } from 'sequelize';

const COLUMN = "ostSkipCertificateVerification";

export async function up(queryInterface) {
    const tableDescription = await queryInterface.describeTable('targets');

    if (!tableDescription[COLUMN]) {
        await queryInterface.addColumn('targets', COLUMN, {
            type: DataTypes.BOOLEAN,
            allowNull: false,
            defaultValue: false
        });
    }
}
