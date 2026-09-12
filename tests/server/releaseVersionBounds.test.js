import {afterEach, beforeEach, it} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {validateQualificationInputs} from '../../scripts/release/validate-inputs.mjs';

const SHA = 'a'.repeat(40);
const BUILD = '1';
const HUGE_DIGITS = 1000;
let root;

beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'myspeed-version-bounds-')); });
afterEach(() => fs.rmSync(root, {recursive: true, force: true}));

const validate = async (version) => {
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({version}));
    fs.mkdirSync(path.join(root, 'client'), {recursive: true});
    fs.writeFileSync(path.join(root, 'client', 'package.json'), JSON.stringify({version}));
    return validateQualificationInputs({root, expectedSha: SHA, actualSha: SHA, version,
        windowsStamp: `${version}.${BUILD}`});
};

for (const version of ['0.0.0', '1.6.0', '255.255.65535', '0001.002.0003'])
    it(`accepts in-range committed version ${version}`, async () => assert.doesNotReject(validate(version)));

for (const [index, version] of ['256.0.0', '1.256.0', '1.2.65536',
    `${'9'.repeat(HUGE_DIGITS)}.1.0`, '000256.1.0', '1.2.3-rc.1', '1.2.3.4', '1.2',
    '1.2.3 ', '1.2.3;echo bad', '1.2.3\njunk', 'v1.2.3'].entries())
    it(`rejects invalid committed version case ${index}`, async () => assert.rejects(validate(version),
        /version|bounds|stamp/i));
