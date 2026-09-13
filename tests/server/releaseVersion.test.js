import {describe, it} from 'node:test';
import assert from 'node:assert/strict';
import {parse} from 'yaml';
import {readSource, runBodies} from '../helpers/source.js';

const read = (name) => readSource(`.github/workflows/${name}.yml`);
const release = read('create_release');
const finalize = read('finalize-release');
const binaries = read('build-binaries');
const msi = read('build-msi');
const pkg = JSON.parse(readSource('package.json'));

const RELEASE_ASSETS = [
    'MySpeed-windows-x64.exe', 'MySpeed-windows-x64-baseline.exe',
    'MySpeed-linux-x64', 'MySpeed-linux-x64-baseline', 'MySpeed-linux-arm64',
    'MySpeed-macos-x64', 'MySpeed-macos-arm64', 'MySpeed.zip',
    'MySpeed-installer.msi', 'MySpeed-installer-baseline.msi',
    'install.sh', 'docker-install.sh', 'chooser.sh', 'SHA256SUMS',
    'qualification-manifest.json', 'qualification-manifest.json.sha256'
];

describe('qualified release version and assets', () => {
    it('links every immutable payload and its verification records', () => {
        for (const asset of RELEASE_ASSETS) assert.ok(finalize.includes(asset), asset);
    });

    it('requires exact source, version, Windows stamp and run attempt at promotion', () => {
        const inputs = parse(release).on.workflow_dispatch.inputs;
        for (const name of ['candidate_sha', 'version', 'windows_stamp',
            'qualification_run_id', 'qualification_run_attempt']) assert.equal(inputs[name].required, true);
        assert.match(release, /qualification-manifest\.mjs validate/);
        assert.doesNotMatch(release, /RAW_VERSION#v|version-bump|npm version|git push/);
    });

    it('binds untrusted workflow inputs as data rather than shell source', () => {
        for (const workflow of [release, read('publish-docker')])
            for (const body of runBodies(workflow)) assert.doesNotMatch(body.text, /\$\{\{\s*inputs\./);
    });

    it('keeps MSI ProductVersion numeric and derived from the qualified version', () => {
        assert.match(msi, /Version="\$\(\$env:VERSION\)\.0"/);
    });
});

describe('a locally built binary is compiled like the released one', () => {
    const shared = /bun\s+scripts\/build-binary\.mjs\b/;

    for (const script of ['build:binary', 'build:binary:baseline'])
        it(`${script} uses the shared build entrypoint`, () => assert.match(pkg.scripts[script], shared));

    it('uses the shared entrypoint for every release compile', () => {
        const commands = [...binaries.matchAll(/^\s*(?:run:\s*)?(bun\s+scripts\/build-binary\.mjs.*)$/gm)]
            .map((match) => match[1]);
        assert.ok(commands.length >= 3);
        for (const command of commands) {
            assert.match(command, /--outfile(?:=|\s+)/);
            assert.match(command, /--target(?:=|\s+)/);
        }
    });

    it('leaves no production compile on the old duplicated CLI', () => {
        assert.doesNotMatch(`${Object.values(pkg.scripts).join('\n')}\n${binaries}`, /bun build --compile/);
    });
});
