import { DataTypes } from 'sequelize';

/**
 * The same widening 0010 made to speedtests.ping, for the column that holds the
 * recommended latency.
 *
 * The recommendations are read off the ten best recent tests, and this column
 * was INTEGER while the download and upload beside it were DOUBLE - so the one
 * figure of the three that is measured in fractions was the one stored without
 * them. On a fibre or a local line that is most of the reading: an idle latency
 * of 0.4 ms and one of 1.4 ms produced the same recommendation, and anything
 * under half a millisecond became 0.
 *
 * Zero is the damaging value rather than merely an imprecise one. It reads as
 * the best latency ever measured on the line, and createRecommendations only
 * replaces the stored figure with something lower - so no later test can ever
 * beat it, and the recommendation stays wrong for the life of the database.
 *
 * sqlite is deliberately left alone, for the reasons 0010 and 0007 give:
 * sequelize implements changeColumn there by rebuilding the table from
 * describeTable's output, which does not report autoIncrement - so the rebuild
 * strips AUTOINCREMENT off the primary key. Nothing is lost by skipping it,
 * because sqlite's INTEGER affinity is numeric rather than integral and stores
 * a fractional value as REAL whatever the column says. MySQL's INT is the only
 * one that actually rounds.
 *
 * Existing rows keep whatever whole millisecond they were rounded to; the next
 * test that beats it writes a precise one. A stored 0 is the exception, and is
 * left as it is here rather than guessed at - the next successful run of
 * createRecommendations replaces the row outright.
 */
export async function up(queryInterface) {
    if (queryInterface.sequelize.getDialect() === 'sqlite') return;

    const tableDescription = await queryInterface.describeTable('recommendations');

    if (/^INT/i.test(tableDescription.ping.type))
        await queryInterface.changeColumn('recommendations', 'ping', {
            type: DataTypes.DOUBLE,
            allowNull: false
        });
}
