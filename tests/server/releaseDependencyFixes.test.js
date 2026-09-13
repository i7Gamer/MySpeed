import {it} from 'node:test';
import assert from 'node:assert/strict';
import {readSource} from '../helpers/source.js';
import {parse} from 'yaml';
import {createRequire} from 'node:module';
import {deflateRawSync} from 'node:zlib';

const manifest = JSON.parse(readSource('package.json'));
const dependencies = manifest.dependencies;
const UUID_VERSION = '11.1.1';
const TAR_STREAM_VERSION = '3.1.7';
const UUID_VERSION_CHARACTER_INDEX = 14;
const UUID_VARIANT_CHARACTER_INDEX = 19;
const UUID_SHAPE = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const EXTRACTORS = {
    '@xhmikosr/decompress': '11.1.4',
    '@xhmikosr/decompress-targz': '9.0.1',
    '@xhmikosr/decompress-unzip': '8.2.1'
};
const LEGACY_EXTRACTORS = ['decompress', 'decompress-targz', 'decompress-unzip'];

it('declares the exact HarfBuzz package used by the standalone compile adapter', () => {
    assert.equal(dependencies.harfbuzzjs, '0.10.0');
});

it('declares the OCI archive inspector parser as an exact runtime dependency', () => {
    assert.equal(dependencies['tar-stream'], TAR_STREAM_VERSION);
});

it('pins the reviewed extractor and its explicit supported-format plugins', () => {
    for (const [name, version] of Object.entries(EXTRACTORS))
        assert.equal(dependencies[name], version, `${name} must match the reviewed security baseline`);
    for (const name of LEGACY_EXTRACTORS)
        assert.equal(dependencies[name], undefined, `${name} must not remain a direct dependency`);
});

it('limits the UUID advisory override to Sequelize\'s dependency edge', () => {
    assert.equal(manifest.overrides['sequelize>uuid'], UUID_VERSION);
    assert.equal(manifest.overrides.uuid, undefined, 'UUID must not be overridden for unrelated consumers');
    const lock = parse(readSource('bun.lock'));
    assert.deepEqual(lock.overrides.sequelize, {uuid: UUID_VERSION});
    assert.equal(lock.packages.uuid[0], `uuid@${UUID_VERSION}`);
});

it('preserves Sequelize UUID v1 and v4 default generation through the override', () => {
    const require = createRequire(import.meta.url);
    const sequelizeRequire = createRequire(require.resolve('sequelize'));
    assert.equal(sequelizeRequire('uuid/package.json').version, UUID_VERSION);

    const {DataTypes, Utils} = require('sequelize');
    for (const [type, expectedVersion] of [
        [new DataTypes.UUIDV1(), '1'],
        [new DataTypes.UUIDV4(), '4']
    ]) {
        const value = Utils.toDefaultValue(type);
        assert.match(value, UUID_SHAPE);
        assert.equal(value[UUID_VERSION_CHARACTER_INDEX], expectedVersion);
        assert.match(value[UUID_VARIANT_CHARACTER_INDEX], /^[89ab]$/);
    }
});

// Each floor is from the reviewed advisory, within the consumer's existing
// major/minor range. Check nested resolutions too, not only hoisted entries.
const PATCHED_VERSIONS = {
    'bun.lock': {'body-parser': '2.3.0', qs: '6.16.0', fflate: '0.7.5'},
    'client/bun.lock': {
        '@babel/core': '7.29.1',
        'baseline-browser-mapping': '2.11.0',
        browserslist: '4.28.7',
        'brace-expansion': {2: '2.1.4', 5: '5.0.9'},
        'fast-uri': '3.1.6',
        immutable: '5.1.8',
        nanoid: '3.3.18'
    }
};

for (const [lockfile, floors] of Object.entries(PATCHED_VERSIONS)) {
    const packages = Object.values(parse(readSource(lockfile)).packages);
    for (const [name, floor] of Object.entries(floors)) {
        it(`${lockfile} resolves every ${name} occurrence above its advisory floor`, () => {
            const versions = packages.map(([identifier]) => identifier)
                .filter(identifier => identifier.startsWith(`${name}@`))
                .map(identifier => identifier.slice(name.length + 1));
            assert.ok(versions.length, `Expected a ${name} resolution`);
            for (const version of versions) {
                const actual = version.split('.').map(Number);
                const minimum = typeof floor === 'string' ? floor : floor[actual[0]];
                assert.ok(minimum, `Unreviewed ${name} major: ${version}`);
                const expected = minimum.split('.').map(Number);
                assert.equal(actual[0], expected[0], 'Do not silently migrate consumer majors');
                assert.ok(actual[1] > expected[1] ||
                    (actual[1] === expected[1] && actual[2] >= expected[2]),
                `${name}@${version} is below ${minimum}`);
            }
        });
    }
}

for (const consumer of ['satori', '@shuding/opentype.js']) {
    it(`${consumer}'s resolved fflate preserves raw font decompression`, () => {
        const require = createRequire(import.meta.url);
        const consumerRequire = createRequire(require.resolve(consumer));
        const {inflateSync} = consumerRequire('fflate');
        const SYNTHETIC_TABLE_REPETITIONS = 32;
        const fontTable = Buffer.from('synthetic bounded font-table payload '.repeat(SYNTHETIC_TABLE_REPETITIONS));
        assert.deepEqual(Buffer.from(inflateSync(deflateRawSync(fontTable))), fontTable);
        assert.throws(() => inflateSync(Uint8Array.of(0xff)), /invalid|unexpected/i);
    });
}
