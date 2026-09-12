import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {parseArgs} from 'node:util';
import {fileURLToPath} from 'node:url';

const RUN_PREFIX = 'myspeed-evidence-';
const SUMMARY_NAME = 'summary.json';
const FILE_MODE = 0o600;

/** Normalize one fresh verifier run without changing the bytes being attested. */
export const collectSummary = ({evidenceDir, output, sourceSha, mode}) => {
    if (fs.existsSync(output) || fs.existsSync(`${output}.sha256`))
        throw new Error('Qualification summary output already exists');
    const summaries = fs.readdirSync(evidenceDir, {withFileTypes: true})
        .filter(entry => entry.isDirectory() && !entry.isSymbolicLink() && entry.name.startsWith(RUN_PREFIX))
        .map(entry => path.join(evidenceDir, entry.name, SUMMARY_NAME));
    if (summaries.length !== 1 || !fs.existsSync(summaries[0]))
        throw new Error('Expected exactly one verifier run with its summary');
    const info = fs.lstatSync(summaries[0]);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1)
        throw new Error('Verifier summary must be an unlinked regular file');
    const bytes = fs.readFileSync(summaries[0]);
    const summary = JSON.parse(bytes.toString('utf8'));
    if (summary.status !== 'passed' || summary.exit !== 0)
        throw new Error('Verifier summary must report passed with exit zero');
    if (sourceSha !== undefined && summary.sourceSha !== sourceSha)
        throw new Error('Verifier summary source SHA does not match');
    if (mode !== undefined && summary.mode !== mode)
        throw new Error('Verifier summary mode does not match');
    fs.writeFileSync(output, bytes, {flag: 'wx', mode: FILE_MODE});
    const digest = createHash('sha256').update(bytes).digest('hex');
    fs.writeFileSync(`${output}.sha256`, `${digest}\n`, {flag: 'wx', mode: FILE_MODE});
    return {summary, sha256: digest};
};

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const {values} = parseArgs({options: {
        'evidence-dir': {type: 'string'}, output: {type: 'string'},
        'source-sha': {type: 'string'}, mode: {type: 'string'}
    }});
    collectSummary({evidenceDir: values['evidence-dir'], output: values.output,
        sourceSha: values['source-sha'], mode: values.mode});
}
