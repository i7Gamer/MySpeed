import {it} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
    assertContainerBoundary,
    runStandaloneVerification
} from '../../scripts/qualification/verify-standalone.mjs';

const SHA = 'a'.repeat(40);
const ID = 'synthetic-test-only';

const LABEL = 'org.myspeed.qualification.run';
const PINNED_IMAGE = 'oven/bun:1.4.2@sha256:9114c058aeae42162ee16dd5084b95fe9473970bb6bcb5b232ab1630f0546895';

const daemonPath = value => value.replace(/\\/g, '/').replace(/^([A-Za-z]):\//,
    (_match, drive) => `/run/desktop/mnt/host/${drive.toLowerCase()}/`);

const inspectionFor = (args) => {
    const mounts = [];
    for (let index = 0; index < args.length; index++) {
        if (args[index] !== '--mount') continue;
        const fields = Object.fromEntries(args[++index].split(',').map(field => {
            const split = field.indexOf('=');
            return split < 0 ? [field, true] : [field.slice(0, split), field.slice(split + 1)];
        }));
        mounts.push({
            Type: fields.type,
            Source: fields.type === 'bind' ? daemonPath(fields.source) : undefined,
            Name: fields.type === 'volume' ? fields.source : undefined,
            Destination: fields.target,
            RW: fields.readonly !== true
        });
    }
    const userIndex = args.indexOf('--user');
    return JSON.stringify([{
        Config: {Labels: {[LABEL]: ID}, User: userIndex < 0 ? '' : args[userIndex + 1]},
        HostConfig: {NetworkMode: 'none', PortBindings: null, Privileged: false, PidMode: '', CapAdd: null},
        NetworkSettings: {Ports: {}},
        Mounts: mounts
    }]);
};

const setup = (context, {seedFails = false, runtimeFails = false, collision = false} = {}) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'myspeed-standalone-test-'));
    context.after(() => fs.rmSync(root, {recursive: true, force: true}));
    const artifact = path.join(root, 'candidate');
    fs.writeFileSync(artifact, 'synthetic inert artifact');
    for (const directory of ['server', 'node_modules']) fs.mkdirSync(path.join(root, directory));
    for (const file of ['package.json', 'bun.lock']) fs.writeFileSync(path.join(root, file), '{}');
    const evidenceDir = path.join(root, 'evidence');
    const calls = [];
    const resources = new Set();
    const containerRuns = new Map();
    const run = (_command, args) => {
        calls.push(args);
        if (args[0] === 'pull') {
            assert.equal(args.at(-1), PINNED_IMAGE);
            return 'pulled pinned helper image';
        }
        if (args[0] === 'image') {
            assert.equal(args.at(-1), PINNED_IMAGE);
            return '{}';
        }
        const volume = args[0] === 'volume';
        const action = args[volume ? 1 : 0];
        if (action === 'inspect') {
            if (resources.has(args.at(-1))) {
                if (args.includes('--format')) return ID;
                return containerRuns.has(args.at(-1)) ? inspectionFor(containerRuns.get(args.at(-1))) : '{}';
            }
            if (collision) return '{}';
            throw new Error('not found');
        }
        if (action === 'create') { resources.add(args.at(-1)); return ''; }
        if (action === 'rm') { resources.delete(args.at(-1)); containerRuns.delete(args.at(-1)); return ''; }
        if (action === 'run') {
            const name = args[args.indexOf('--name') + 1];
            resources.add(name);
            containerRuns.set(name, args);
            if (args.some(arg => arg.includes('fixture.mjs handoff'))) {
                if (seedFails) {
                    const error = new Error('injected seed failure');
                    error.stdout = 'seed stdout';
                    error.stderr = 'seed stderr';
                    throw error;
                }
            } else {
                if (runtimeFails) {
                    const error = new Error('injected runtime failure');
                    error.stdout = 'runtime stdout';
                    error.stderr = 'runtime stderr';
                    throw error;
                }
                const runDir = path.join(evidenceDir, 'myspeed-evidence-current');
                fs.mkdirSync(runDir);
                fs.writeFileSync(path.join(runDir, 'summary.json'), JSON.stringify({
                    status: 'passed', exit: 0, mode: 'full', sourceSha: SHA
                }));
            }
            return '';
        }
        return '';
    };
    return {root, artifact, evidenceDir, calls, resources, run, repo: root,
        sourceSha: SHA, originalBuildRoot: '/compile', runId: ID};
};

it('removes the seeder before running the candidate without any source/dependency mount', (context) => {
    const options = setup(context);
    runStandaloneVerification(options);
    const runs = options.calls.filter(args => args[0] === 'run');
    const pullIndex = options.calls.findIndex(args => args[0] === 'pull');
    assert.ok(pullIndex >= 0 && pullIndex < options.calls.indexOf(runs[0]));
    assert.match(fs.readFileSync(path.join(options.evidenceDir, 'helper-image-pull.log'), 'utf8'), /pinned helper/);
    assert.equal(runs.length, 2);
    const [seed, runtime] = runs;
    assert.ok(seed.includes('none'));
    assert.ok(runtime.includes('none'));
    for (const name of ['server', 'node_modules', 'package.json', 'bun.lock'])
        assert.ok(seed.some(arg => arg.includes(`target=/fixture-source/${name},readonly`)));
    assert.ok(seed.every(arg => !arg.includes('target=/fixture-source,readonly')));
    assert.ok(runtime.every(arg => !arg.includes('/fixture-source') && !arg.includes('--repo')));
    assert.ok(runtime.some(arg => arg.includes('target=/input,readonly')));
    assert.ok(runtime.includes('--preseeded-fixture-manifest'));
    const seedName = seed[seed.indexOf('--name') + 1];
    const removeIndex = options.calls.findIndex(args => args[0] === 'rm' && args.at(-1) === seedName);
    assert.ok(removeIndex >= 0 && removeIndex < options.calls.indexOf(runtime));
    assert.equal(options.resources.size, 0);
    assert.ok(fs.existsSync(path.join(options.evidenceDir, 'qualification-summary.json.sha256')));
});

it('cleans only labelled resources and never starts a candidate after seeding fails', (context) => {
    const options = setup(context, {seedFails: true});
    assert.throws(() => runStandaloneVerification(options), /seed failure/);
    assert.equal(options.calls.filter(args => args[0] === 'run').length, 1);
    assert.equal(options.resources.size, 0);
    assert.match(fs.readFileSync(path.join(options.evidenceDir, 'seeder.log'), 'utf8'), /seed stdout[\s\S]*seed stderr/);
});

it('retains runtime stdout and stderr when candidate verification fails', (context) => {
    const options = setup(context, {runtimeFails: true});
    assert.throws(() => runStandaloneVerification(options), /runtime failure/);
    assert.equal(options.resources.size, 0);
    assert.match(fs.readFileSync(path.join(options.evidenceDir, 'runtime.log'), 'utf8'),
        /runtime stdout[\s\S]*runtime stderr/);
});

it('refuses an existing resource name without removing it', (context) => {
    const options = setup(context, {collision: true});
    assert.throws(() => runStandaloneVerification(options), /already exists/);
    assert.ok(options.calls.every(args => !args.includes('rm')));
});

it('refuses stale evidence and invalid source identity before any Docker action', (context) => {
    const options = setup(context);
    assert.throws(() => runStandaloneVerification({...options, sourceSha: 'development'}), /SHA/);
    assert.equal(options.calls.length, 0);
    fs.mkdirSync(options.evidenceDir);
    assert.throws(() => runStandaloneVerification(options), /exist/i);
    assert.equal(options.calls.length, 0);
});

it('refuses a linked candidate before creating evidence or calling Docker', (context) => {
    const options = setup(context);
    const linked = path.join(options.root, 'candidate-link');
    fs.linkSync(options.artifact, linked);
    assert.throws(() => runStandaloneVerification({...options, artifact: linked}), /unlinked regular file/i);
    assert.equal(fs.existsSync(options.evidenceDir), false);
    assert.equal(options.calls.length, 0);
});

it('rejects any runtime network, publication, mount, ownership, or capability drift', () => {
    const mounts = [
        {type: 'bind', source: 'C:/work/candidate', destination: '/candidate', rw: false},
        {type: 'bind', source: 'C:/work/qualification', destination: '/qualification', rw: false},
        {type: 'volume', name: 'owned-handoff', destination: '/input', rw: false}
    ];
    const record = {
        Config: {Labels: {[LABEL]: ID}, User: '1000:1000'},
        HostConfig: {NetworkMode: 'none', PortBindings: null, Privileged: false, PidMode: '', CapAdd: null},
        NetworkSettings: {Ports: {'5216/tcp': null}},
        Mounts: [
            {Type: 'bind', Source: '/run/desktop/mnt/host/c/work/candidate', Destination: '/candidate', RW: false},
            {Type: 'bind', Source: '/run/desktop/mnt/host/c/work/qualification', Destination: '/qualification', RW: false},
            {Type: 'volume', Name: 'owned-handoff', Destination: '/input', RW: false}
        ]
    };
    const verify = update => assertContainerBoundary({
        inspection: JSON.stringify([{...record, ...update}]), runId: ID, user: '1000:1000', mounts
    });
    assert.doesNotThrow(() => verify({}));
    assert.throws(() => verify({HostConfig: {...record.HostConfig, NetworkMode: 'bridge'}}), /network mode/i);
    assert.throws(() => verify({HostConfig: {...record.HostConfig, PortBindings: {'5216/tcp': [{}]}}}), /publishes/i);
    assert.throws(() => verify({HostConfig: {...record.HostConfig, CapAdd: ['SYS_ADMIN']}}), /capabilit/i);
    assert.throws(() => verify({Mounts: record.Mounts.map(mount => mount.Destination === '/input'
        ? {...mount, RW: true} : mount)}), /mount boundary/i);
    assert.throws(() => verify({Mounts: [...record.Mounts,
        {Type: 'bind', Source: '/source', Destination: '/fixture-source', RW: false}]}), /mount boundary/i);
    assert.throws(() => verify({Config: {...record.Config, Labels: {[LABEL]: 'foreign'}}}), /ownership/i);
});
