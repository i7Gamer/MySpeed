import {describe, it} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {buildStatistics} from '../../server/util/statistics.js';
import {statisticsPopulations} from '../helpers/statisticsPopulations.js';

// Full payload snapshots captured before optimization at db97f53c. Digests keep
// the fixture compact while checking every bucket, rounding result and field.
const EXPECTED = {
    empty: 'b8ac0ea6c82e8eb3960498c2405074cfcf3df7948d9fe19448541baf86a25d17',
    one: 'ec4bbbfaa1dacc3d70448e62ae977b1e980aa371b18254e7bfe3542a9f2320ba',
    full: '6886dc454dd67e418c0f97073dab352e57833e40567b8bcf488a5f9399d2a7ac',
    bucketed: 'b7c48a20b6bf5e6ee23c78d4827b5ed041ce53c11e6b19b43d960972448d38f0',
    reverse: 'ab8852f9d910bd4fde9445e4f4af0fa4585b677a5bce631b86f6b58496da033a',
    'berlin spring DST': '16ba6b042a7665ad7ef2e9f45baa2828b532611fe1fa4a5832c85fd349cd901f',
    'new york fall DST': '51eaff68dfa47817d046c8317401525195de149e4bf318d44474a05389a04155',
    'invalid span': '43a143e413a000f4291a2b355425bcb798b882eea861abb0dfafb74137b45065',
    'zero span': '43a143e413a000f4291a2b355425bcb798b882eea861abb0dfafb74137b45065',
    'all failed': '0b8688fd62e9dc87e350c744b3ce452c3b2999ad89794d7566feb51e321b3083',
    unplaceable: 'f21f3206d5584de713541f402d1ac0da20ccbf7afbf132279b4cafcbec6269cb'
};
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

describe('statistics preserve the pre-optimization payload', () => {
    for (const {name, entries, range, options} of statisticsPopulations()) {
        it(name, () => {
            const before = JSON.stringify(entries);
            const result = buildStatistics(entries, range, options);
            assert.equal(digest(result), EXPECTED[name], name);
            assert.equal(JSON.stringify(entries), before, 'aggregation modified its input');
        });
    }

    it('recomputes timestamps and measurements on every call', () => {
        const fixture = statisticsPopulations().find(population => population.name === 'one');
        const {entries, range, options} = fixture;
        const before = buildStatistics(entries, range, options);
        const NEW_HOUR = 12;
        entries[0].created.setUTCHours(NEW_HOUR);
        entries[0].download = 250;
        const after = buildStatistics(entries, range, options);
        assert.notDeepEqual(after.labels, before.labels);
        assert.equal(after.download.avg, 250);
        assert.equal(after.hourlyAverages[NEW_HOUR].count, 1);
    });
});
