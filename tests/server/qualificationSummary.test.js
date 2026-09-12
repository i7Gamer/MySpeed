import {it} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {collectSummary} from '../../scripts/qualification/collect-summary.mjs';

const SOURCE_SHA = 'a'.repeat(40);
const fixture = (context) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'myspeed-summary-test-'));
    context.after(() => fs.rmSync(root, {recursive: true, force: true}));
    const evidenceDir = path.join(root, 'evidence');
    const run = path.join(evidenceDir, 'myspeed-evidence-synthetic');
    fs.mkdirSync(run, {recursive: true});
    const summary = {status: 'passed', exit: 0, mode: 'full', sourceSha: SOURCE_SHA};
    const input = path.join(run, 'summary.json');
    const output = path.join(root, 'qualification-summary.json');
    fs.writeFileSync(input, JSON.stringify(summary));
    return {root, evidenceDir, run, summary, input, output};
};

it('preserves the unique successful summary bytes and hashes that exact file', (context) => {
    const {evidenceDir, input, output} = fixture(context);
    collectSummary({evidenceDir, output, sourceSha: SOURCE_SHA, mode: 'full'});
    assert.deepEqual(fs.readFileSync(output), fs.readFileSync(input));
    assert.equal(fs.readFileSync(`${output}.sha256`, 'utf8').trim(),
        createHash('sha256').update(fs.readFileSync(input)).digest('hex'));
    assert.throws(() => collectSummary({evidenceDir, output}), /exist/i);
});

for (const [label, update, expected] of [
    ['failed status', {status: 'failed'}, /passed/],
    ['nonzero exit', {exit: 1}, /passed/],
    ['stale source', {sourceSha: 'b'.repeat(40)}, /source/],
    ['wrong mode', {mode: 'listener-free-reset'}, /mode/]
]) {
    it(`refuses ${label} without producing a success sidecar`, (context) => {
        const {evidenceDir, input, output, summary} = fixture(context);
        fs.writeFileSync(input, JSON.stringify({...summary, ...update}));
        assert.throws(() => collectSummary({evidenceDir, output, sourceSha: SOURCE_SHA, mode: 'full'}), expected);
        assert.equal(fs.existsSync(output), false);
    });
}

it('rejects missing or multiple runs instead of selecting a stale successful one', (context) => {
    const {evidenceDir, run, input, output} = fixture(context);
    fs.unlinkSync(input);
    assert.throws(() => collectSummary({evidenceDir, output}), /exactly one/);
    fs.writeFileSync(input, '{}');
    fs.cpSync(run, path.join(evidenceDir, 'myspeed-evidence-other'), {recursive: true});
    assert.throws(() => collectSummary({evidenceDir, output}), /exactly one/);
});

it('refuses a stale success beside an incomplete run with no summary', (context) => {
    const {evidenceDir, output} = fixture(context);
    fs.mkdirSync(path.join(evidenceDir, 'myspeed-evidence-incomplete'));
    assert.throws(() => collectSummary({evidenceDir, output}), /exactly one/);
});
