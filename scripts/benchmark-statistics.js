// Manual CPU/event-loop profiling; no timing threshold belongs in the test suite.
// node scripts/benchmark-statistics.js [--baseline-ref=db97f53c]
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {buildStatistics} from '../server/util/statistics.js';

const ROW_COUNTS = [10000, 100000, 500000];
const REPEATS = 3;
const MS_PER_MINUTE = 60 * 1000;
const START = Date.parse('2025-01-01T00:00:00.000Z');
const DECIMALS = 1;
const OPTIONS = {offsetMinutes: 0};
const root = fileURLToPath(new URL('..', import.meta.url));

const baselineArg = process.argv.slice(2).find(argument => argument.startsWith('--baseline-ref='));
let baseline;
if (baselineArg) {
    const ref = baselineArg.slice('--baseline-ref='.length);
    const source = execFileSync('git', ['show', `${ref}:server/util/statistics.js`], {cwd: root, encoding: 'utf8'});
    const resolved = source.replace(/from (['"])(\.\/[^'"]+)\1/g,
        (_, quote, relative) => `from ${quote}${new URL(relative, new URL('../server/util/statistics.js', import.meta.url)).href}${quote}`);
    baseline = (await import(`data:text/javascript;base64,${Buffer.from(resolved).toString('base64')}`)).buildStatistics;
}

const measure = async (build, entries, range) => {
    const times = [], delays = [];
    let result;
    for (let repeat = 0; repeat < REPEATS; repeat++) {
        const queued = performance.now();
        const nextTurn = new Promise(resolve => setTimeout(() => resolve(performance.now() - queued), 0));
        const started = performance.now();
        result = build(entries, range, OPTIONS);
        times.push(performance.now() - started);
        delays.push(await nextTurn);
    }
    const middle = values => [...values].sort((left, right) => left - right)[Math.floor(values.length / 2)].toFixed(DECIMALS);
    return {result, cpuMs: middle(times), timerDelayMs: middle(delays)};
};

console.log(`Node ${process.version}; ${REPEATS} runs per population; median milliseconds; input construction and DB excluded`);
for (const count of ROW_COUNTS) {
    const entries = Array.from({length: count}, (_, index) => ({
        created: new Date(START + index * MS_PER_MINUTE).toISOString(),
        error: null, ping: 10, jitter: 2, download: 100, upload: 50, time: 30,
        downloadLatency: 20, uploadLatency: 30, packetLoss: 0,
        bytesDownloaded: 1000, bytesUploaded: 500, targetId: 1
    }));
    const range = {from: new Date(START), to: new Date(START + count * MS_PER_MINUTE)};
    const before = baseline && await measure(baseline, entries, range);
    const after = await measure(buildStatistics, entries, range);
    if (before) assert.deepEqual(after.result, before.result);
    console.log(JSON.stringify({rows: count,
        ...(before && {baselineCpuMs: before.cpuMs, baselineTimerDelayMs: before.timerDelayMs}),
        cpuMs: after.cpuMs, timerDelayMs: after.timerDelayMs, ...(before && {equal: true})}));
}
