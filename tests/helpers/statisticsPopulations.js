import {zoneFromName} from '../../server/util/timezone.js';

const BASE = Date.parse('2025-03-29T00:00:00.000Z');
const MS_PER_HOUR = 60 * 60 * 1000;
const POPULATION_SIZE = 407;
const VALUES = [null, undefined, -1, 0, 0.01, '0', '42.42', 'NaN', 4.995, 13.1, 900];
const PROPERTIES = ['ping', 'jitter', 'download', 'upload', 'time', 'packetLoss',
    'downloadLatency', 'uploadLatency', 'bytesDownloaded', 'bytesUploaded'];
const at = (created, overrides = {}) => ({created, error: null, ping: 10, jitter: 2,
    download: 100, upload: 50, time: 30, downloadLatency: 12, uploadLatency: 30, ...overrides});
const range = {from: new Date(BASE), to: new Date(BASE + 3 * 24 * MS_PER_HOUR)};
const mixed = Array.from({length: POPULATION_SIZE}, (_, index) => at(
    new Date(BASE + (index % 145) * MS_PER_HOUR / 2).toISOString(), {
        ...Object.fromEntries(PROPERTIES.map((property, column) => [property, VALUES[(index + column) % VALUES.length]])),
        error: index % 7 === 0 ? `failure ${index}` : null,
        targetId: index % 3 === 0 ? null : index % 3
    }));
mixed.splice(12, 0, at('not a timestamp', {download: 112, ping: 4}));
mixed.splice(24, 0, at(null));
mixed.splice(32, 0, at(0));
mixed.splice(49, 0, at(new Date(BASE)), at('2025-03-29T01:00:00+01:00'));
const limitsFor = id => id === null ? null : ({ping: 10, download: 80, upload: 40});

/** Deliberately unsorted, tied, corrupt and mixed-target histories. */
export const statisticsPopulations = () => [
    {name: 'empty', entries: [], range, options: {offsetMinutes: 0}},
    {name: 'one', entries: [at(new Date(BASE))], range, options: {offsetMinutes: 0}},
    {name: 'full', entries: mixed.slice(0, 30), range, options: {offsetMinutes: 330, limitsFor}},
    {name: 'bucketed', entries: mixed, range, options: {offsetMinutes: 0, limitsFor}},
    {name: 'reverse', entries: [...mixed].reverse(), range, options: {offsetMinutes: -345, maxPoints: 50, limitsFor}},
    {name: 'berlin spring DST', entries: mixed, range, options: {zone: zoneFromName('Europe/Berlin'), limitsFor}},
    {name: 'new york fall DST', entries: mixed.map((entry, index) => ({...entry,
        created: new Date(Date.parse('2025-11-01T00:00:00.000Z') + index * MS_PER_HOUR / 2).toISOString()})),
    range: {from: new Date('2025-11-01T00:00:00.000Z'), to: new Date('2025-11-10T00:00:00.000Z')},
    options: {zone: zoneFromName('America/New_York'), maxPoints: 1000, limitsFor}},
    {name: 'invalid span', entries: mixed, range: {from: new Date(NaN), to: range.to}, options: {offsetMinutes: 0}},
    {name: 'zero span', entries: mixed, range: {from: range.from, to: range.from}, options: {offsetMinutes: 0}},
    {name: 'all failed', entries: mixed.map(entry => ({...entry, error: 'failed'})), range, options: {offsetMinutes: 0}},
    {name: 'unplaceable', entries: mixed.map(entry => ({...entry, created: 'invalid'})), range, options: {offsetMinutes: 0}}
];
