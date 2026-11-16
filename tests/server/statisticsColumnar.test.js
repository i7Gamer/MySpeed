import {describe, it} from 'node:test';
import assert from 'node:assert/strict';
import {buildStatistics, columnsOf, statisticsOver, StatisticsColumns} from '../../server/util/statistics.js';
import {buildStatistics as referenceStatistics} from '../helpers/statisticsReference.js';
import {zoneFromName} from '../../server/util/timezone.js';

/*
 * The columnar aggregation against a frozen copy of the row-object one it
 * replaced. Byte-identical JSON is the contract the client sees; deepStrictEqual
 * on top holds the in-process callers (the digest, the OpenGraph card) to the
 * same values, down to null versus undefined and -0 versus 0.
 */

const SEEDS = 60;
const MS_PER_MINUTE = 60 * 1000;
const BASE = Date.parse('2025-06-01T00:00:00.000Z');
const SIZES = [0, 1, 2, 3, 49, 50, 51, 299, 300, 301, 999, 1000, 1001, 2500];
const VALUES = [null, undefined, -1, '-1', 0, -0, '0', '-0', '', ' ', 'NaN', NaN, Infinity, -Infinity, '42.42',
    '1e3', 'abc', 0.01, 4.995, 13.1, 12.345, 900, 1e9, -3.5, true, [], {}];
const ERRORS = [null, null, null, null, undefined, '', 'timeout', 'Could not connect', 'failure'];
const PROVIDERS = ['ookla', 'libre', 'iperf3', 'cloudflare', 'openspeedtest', null, undefined];
const TARGETS = [1, 2, 3, null, undefined, '2', 7];
const NUMERIC = ['ping', 'jitter', 'download', 'upload', 'time', 'packetLoss', 'downloadLatency', 'uploadLatency',
    'bytesDownloaded', 'bytesUploaded'];

// mulberry32: a seeded, repeatable generator, so a failing seed can be replayed.
const generator = (seed) => () => {
    seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

const population = (random, size) => {
    const pick = (list) => list[Math.floor(random() * list.length)];
    const step = pick([1, 5, 60, 600]) * MS_PER_MINUTE;
    const plausible = () => +(random() * 500).toFixed(pick([0, 1, 2, 3]));
    const rows = [];
    for (let index = 0; index < size; index++) {
        // Mostly the canonical spelling a write produces, with ties, other
        // spellings of a real instant, Date objects and rows nothing can place.
        const instant = BASE + (random() < 0.1 ? index - 1 : index) * step;
        const created = random() < 0.85 ? new Date(instant).toISOString() : pick([
            new Date(instant), instant, null, 'garbage', '2025-06-01T02:00:00+02:00',
            new Date(instant).toISOString().replace('T', ' '), undefined]);
        const row = {created, error: pick(ERRORS), provider: pick(PROVIDERS), targetId: pick(TARGETS)};
        for (const column of NUMERIC) row[column] = random() < 0.7 ? plausible() : pick(VALUES);
        if (random() < 0.05) Object.assign(row, {ping: -1, download: -1, upload: -1});
        if (random() < 0.02) delete row.targetId;
        rows.push(row);
    }
    // Sorted as the database delivers, or shuffled as a pure caller may.
    if (random() < 0.3) rows.sort(() => random() - 0.5);
    return rows;
};

const rangeFor = (random, rows) => {
    const span = Math.max(rows.length, 1) * 5 * MS_PER_MINUTE;
    const choice = Math.floor(random() * 5);
    if (choice === 0) return {from: new Date(NaN), to: new Date(BASE + span)};
    if (choice === 1) return {from: new Date(BASE), to: new Date(BASE)};
    // A window starting inside the data, so some rows fall before bucket 0.
    if (choice === 2) return {from: new Date(BASE + span / 3), to: new Date(BASE + span)};
    return {from: new Date(BASE), to: new Date(BASE + span)};
};

const optionsFor = (random) => {
    const pick = (list) => list[Math.floor(random() * list.length)];
    return {
        ...pick([{offsetMinutes: 0}, {offsetMinutes: 330}, {offsetMinutes: -345}, {zone: zoneFromName('Europe/Berlin')}, {}]),
        maxPoints: pick([undefined, null, '', 'abc', 10, 50, 300, 1000, 5000, '120']),
        redactErrors: random() < 0.5,
        limitsFor: pick([undefined, () => null, (id) => id === null ? null : {ping: 10, download: 80, upload: 40},
            (id) => ({ping: id === 1 ? null : 12, download: id === 2 ? null : 150, upload: 30})])
    };
};

const assertSame = (actual, expected, label) => {
    assert.equal(JSON.stringify(actual), JSON.stringify(expected), `${label}: JSON differs`);
    assert.deepStrictEqual(actual, expected, `${label}: values differ`);
};

describe('columnar statistics match the row-object aggregation', () => {
    for (let seed = 1; seed <= SEEDS; seed++) {
        it(`seed ${seed}`, () => {
            const random = generator(seed);
            for (const size of SIZES) {
                const rows = population(random, size);
                const range = rangeFor(random, rows);
                const options = optionsFor(random);
                const before = JSON.stringify(rows);
                assertSame(buildStatistics(rows, range, options), referenceStatistics(rows, range, options),
                    `seed ${seed}, ${size} rows`);
                assert.equal(JSON.stringify(rows), before, 'aggregation modified its input');
            }
        });
    }

    it('answers the same from columns filled page by page', () => {
        const random = generator(SEEDS + 1);
        const rows = population(random, 1500);
        const range = rangeFor(random, rows);
        const options = optionsFor(random);
        const PAGE = 7;
        const columns = new StatisticsColumns(1);
        for (let start = 0; start < rows.length; start += PAGE)
            for (const row of rows.slice(start, start + PAGE)) columns.append(row);
        assertSame(statisticsOver(columns, range, options), referenceStatistics(rows, range, options), 'paged');
    });

    it('can aggregate the same columns twice', () => {
        const random = generator(SEEDS + 2);
        const rows = population(random, 800);
        const range = rangeFor(random, rows);
        const options = optionsFor(random);
        const columns = columnsOf(rows);
        assertSame(statisticsOver(columns, range, options), statisticsOver(columns, range, options), 'repeat');
    });
});

describe('StatisticsColumns', () => {
    it('grows past the capacity it was sized for', () => {
        const columns = new StatisticsColumns(1);
        for (let index = 0; index < 100; index++)
            columns.append({created: new Date(BASE + index).toISOString(), ping: index + 1, download: 1, upload: 1});
        assert.equal(columns.length, 100);
        assert.equal(statisticsOver(columns, {from: new Date(BASE), to: new Date(BASE + 100)}).ping.max, 100);
    });

    it('treats a capacity below one as one', () => {
        const columns = new StatisticsColumns(0);
        columns.append({created: new Date(BASE).toISOString(), ping: 1, download: 1, upload: 1});
        assert.equal(columns.length, 1);
    });

    it('lists the targets present in the order they first appear, absent as null', () => {
        const columns = columnsOf([{targetId: 2}, {targetId: 1}, {}, {targetId: 2}, {targetId: null}, {targetId: '2'}]);
        assert.deepStrictEqual(columns.targetIds(), [2, 1, null, '2']);
        assert.deepStrictEqual(columnsOf([]).targetIds(), []);
    });

    it('spans the placeable instants only', () => {
        const columns = columnsOf([{created: 'garbage'}, {created: '2025-01-02T00:00:00.000Z'},
            {created: '2025-01-01T00:00:00.000Z'}, {created: undefined}]);
        assert.deepStrictEqual(columns.extent(),
            {first: Date.parse('2025-01-01T00:00:00.000Z'), last: Date.parse('2025-01-02T00:00:00.000Z')});
        assert.equal(columnsOf([{created: 'garbage'}]).extent(), null);
        assert.equal(columnsOf([]).extent(), null);
    });
});
