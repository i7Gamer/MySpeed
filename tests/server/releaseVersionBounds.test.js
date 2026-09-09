import {it} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {readSource, runBodies} from '../helpers/source.js';

const TIMEOUT_MS = 20000;
const HUGE_DIGITS = 1000;
const bash = ['C:/Program Files/Git/bin/bash.exe', 'bash', '/usr/bin/bash']
    .find(executable => spawnSync(executable, ['-c', 'exit 0'], {timeout: TIMEOUT_MS}).status === 0);
const workflow = readSource('.github/workflows/create_release.yml');
const validation = runBodies(workflow).find(body => body.text.includes('RAW_VERSION#v'))?.text;

const validate = (t, version) => {
    assert.ok(validation, 'the actual release preflight must exist');
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'myspeed-version-'));
    t.after(() => fs.rmSync(directory, {recursive: true, force: true}));
    const output = path.join(directory, 'outputs');
    const result = spawnSync(bash, ['-s'], {
        input: 'git() { echo tag-lookup >&2; return 1; }\n' + validation,
        env: {...process.env, RAW_VERSION: version, GITHUB_OUTPUT: output.replaceAll('\\', '/')},
        encoding: 'utf8', timeout: TIMEOUT_MS
    });
    assert.ifError(result.error);
    return {...result, output: fs.existsSync(output) ? fs.readFileSync(output, 'utf8') : ''};
};

for (const version of ['0.0.0', '1.6.0', '255.255.65535', 'v1.6.0', '0001.002.0003']) {
    it(`accepts the existing in-range version ${version}`, {skip: !bash}, t => {
        const result = validate(t, version);
        assert.equal(result.status, 0, result.stderr);
        assert.ok(result.output.includes(`version=${version.replace(/^v/, '')}\n`));
    });
}

const invalid = ['256.0.0', '1.256.0', '1.2.65536', `${'9'.repeat(HUGE_DIGITS)}.1.0`,
    '000256.1.0', '1.2.3-rc.1', '1.2.3.4', '1.2', '1.2.3 ', '1.2.3;echo bad',
    '1.2.3\njunk', '1.2.3\nversion=1.2.4', '\n1.2.3', '1.2.3\n'];
invalid.forEach((version, index) => {
    it(`rejects invalid version case ${index} before even looking up a tag`, {skip: !bash}, t => {
        const result = validate(t, version);
        assert.equal(result.status, 1, result.stdout + result.stderr);
        assert.equal(result.output, '');
        assert.doesNotMatch(result.stderr, /tag-lookup/);
    });
});
