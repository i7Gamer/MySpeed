import { DataTypes } from 'sequelize';

const INDEX_NAME = 'speedtests_created';

/**
 * The error column holds whatever the provider CLI printed to stderr, and Ookla
 * logs one line per candidate server it could not open a socket to - three of
 * those already exceed the 255 characters VARCHAR gave it. sqlite ignores the
 * declared length, but MySQL in its default strict mode raises ER_DATA_TOO_LONG,
 * and it does so from inside the handler that exists to record a failed run: the
 * row was never written, the integrations were never notified, and the running
 * flag stayed set, which suppressed the keep-alive ping until a test succeeded.
 */
export async function up(queryInterface) {
    const tableDescription = await queryInterface.describeTable('speedtests');

    if (!/TEXT/i.test(tableDescription.error.type))
        await queryInterface.changeColumn('speedtests', 'error', {
            type: DataTypes.TEXT,
            allowNull: true
        });

    // Sequelize implements changeColumn on sqlite by rebuilding the table, which
    // takes every index defined on it with it. Every read of this table filters
    // or sorts on `created`, so losing that index turns each one into a full
    // scan - and migration 0004, which created it, will not run again.
    const existing = await queryInterface.showIndex('speedtests');
    if (!existing.some((index) => index.name === INDEX_NAME))
        await queryInterface.addIndex('speedtests', ['created'], {name: INDEX_NAME});
}
