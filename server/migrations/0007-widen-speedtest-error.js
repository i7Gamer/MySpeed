import { DataTypes } from 'sequelize';

/**
 * The error column holds whatever the provider CLI printed to stderr, and Ookla
 * logs one line per candidate server it could not open a socket to - three of
 * those already exceed the 255 characters VARCHAR gave it. MySQL in its default
 * strict mode raises ER_DATA_TOO_LONG, and it does so from inside the handler
 * that exists to record a failed run: the row was never written, the
 * integrations were never notified, and the running flag stayed set, which
 * suppressed the keep-alive ping until a test succeeded.
 *
 * sqlite is deliberately left alone. It ignores a declared length entirely, so
 * it never had the problem - and Sequelize implements changeColumn there by
 * rebuilding the table from describeTable's output, which does not report
 * autoIncrement. That silently stripped AUTOINCREMENT off the primary key, so
 * sqlite fell back to max(rowid)+1 and handed the id of a deleted test to the
 * next one; the client's list is keyed on that id, and deleteOne resolves by it
 * alone. The rebuild also dropped the index on `created` and moved every row
 * through an untransacted DROP/INSERT pair. None of that was worth a column
 * type the engine does not read.
 */
export async function up(queryInterface) {
    if (queryInterface.sequelize.getDialect() === 'sqlite') return;

    const tableDescription = await queryInterface.describeTable('speedtests');

    if (!/TEXT/i.test(tableDescription.error.type))
        await queryInterface.changeColumn('speedtests', 'error', {
            type: DataTypes.TEXT,
            allowNull: true
        });
}
