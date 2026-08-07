const INDEX_NAME = 'speedtests_created';

/**
 * Every read of the speedtests table filters or sorts on `created` - the
 * statistics range query, the paginated list, getLatest, the retention sweep
 * and both exports - and none of them had an index to use. On an instance
 * keeping a year of hourly tests that is a full scan per request.
 */
export async function up(queryInterface) {
    const existing = await queryInterface.showIndex('speedtests');
    if (existing.some((index) => index.name === INDEX_NAME)) return;

    await queryInterface.addIndex('speedtests', ['created'], {name: INDEX_NAME});
}
