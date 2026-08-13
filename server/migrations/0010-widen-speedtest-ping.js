import { DataTypes } from 'sequelize';

/**
 * The latency column was INTEGER, so every measurement was rounded to whole
 * milliseconds before it was stored. That is most of the reading on a fibre or
 * a local line - an idle latency of 0.4 ms and one of 1.4 ms are the same row -
 * and the rounding cannot be undone afterwards, because the API, the CSV
 * export, the Prometheus exporter and every integration read this column and
 * nothing else. Jitter, packet loss and both loaded latencies beside it have
 * always been DOUBLE; the one figure people actually watch was the exception.
 *
 * sqlite is deliberately left alone, for the same reasons 0007 leaves the error
 * column alone there: sequelize implements changeColumn on sqlite by rebuilding
 * the table from describeTable's output, which does not report autoIncrement -
 * so the rebuild strips AUTOINCREMENT off the primary key, sqlite falls back to
 * max(rowid)+1 and hands a deleted test's id to the next one, and the index on
 * `created` goes with it.
 *
 * Nothing is lost by skipping it. sqlite's INTEGER affinity is numeric, not
 * integral: a value that cannot be represented exactly as an integer is stored
 * as REAL regardless of what the column says, so a fractional latency round
 * trips there already. MySQL's INT is the only one that actually rounds, and it
 * is the only one changed here.
 *
 * Existing rows keep their whole-millisecond values - the precision they were
 * recorded without cannot be recovered - and gain decimals from the next test.
 */
export async function up(queryInterface) {
    if (queryInterface.sequelize.getDialect() === 'sqlite') return;

    const tableDescription = await queryInterface.describeTable('speedtests');

    if (/^INT/i.test(tableDescription.ping.type))
        await queryInterface.changeColumn('speedtests', 'ping', {
            type: DataTypes.DOUBLE,
            allowNull: false
        });
}
