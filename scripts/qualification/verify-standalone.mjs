import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {parseArgs} from 'node:util';
import {fileURLToPath} from 'node:url';
import {collectSummary} from './collect-summary.mjs';

const IMAGE = 'oven/bun:1.4.2@sha256:9114c058aeae42162ee16dd5084b95fe9473970bb6bcb5b232ab1630f0546895';
const LABEL = 'org.myspeed.qualification.run';
const DOCKER_TIMEOUT_MS = 120_000;
const MAX_LOG_BYTES = 4 * 1024 * 1024;
const DEFAULT_UID = 1000;
const DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const POPULATED_WORK = '/qualification-work';
const RESET_WORK = '/qualification-reset';
const MANIFEST_NAME = 'fixture-manifest.json';
const FIXTURE_SOURCE_ENTRIES = ['server', 'node_modules', 'package.json', 'bun.lock'];

const normalizedMountSource = value => {
    const slash = String(value).replace(/\\/g, '/');
    const desktop = /^\/run\/desktop\/mnt\/host\/([a-z])\/(.*)$/i.exec(slash);
    const windows = /^([a-z]):\/(.*)$/i.exec(slash);
    const match = desktop ?? windows;
    return match ? `${match[1].toLowerCase()}:/${match[2]}`.toLowerCase() : slash;
};

const hasPublishedPorts = ports => ports && Object.values(ports).some(value => Array.isArray(value)
    ? value.length > 0 : value !== null && value !== undefined);

export const assertContainerBoundary = ({inspection, runId, user, mounts}) => {
    const records = JSON.parse(inspection);
    if (!Array.isArray(records) || records.length !== 1) throw new Error('Expected one Docker container inspection');
    const record = records[0];
    if (record.Config?.Labels?.[LABEL] !== runId) throw new Error('Container ownership label does not match');
    if ((record.Config?.User ?? '') !== user) throw new Error('Container user does not match');
    if (record.HostConfig?.NetworkMode !== 'none') throw new Error('Container network mode is not none');
    if (record.HostConfig?.Privileged === true || (record.HostConfig?.PidMode ?? '') !== '')
        throw new Error('Container has a privileged or shared PID boundary');
    if ((record.HostConfig?.CapAdd ?? []).length !== 0) throw new Error('Container unexpectedly adds capabilities');
    if (hasPublishedPorts(record.HostConfig?.PortBindings) || hasPublishedPorts(record.NetworkSettings?.Ports))
        throw new Error('Container unexpectedly publishes a port');

    const normalize = mount => ({
        type: mount.Type ?? mount.type,
        source: (mount.Type ?? mount.type) === 'volume'
            ? (mount.Name ?? mount.name)
            : normalizedMountSource(mount.Source ?? mount.source),
        destination: mount.Destination ?? mount.destination,
        rw: mount.RW ?? mount.rw
    });
    const actual = (record.Mounts ?? []).map(normalize).sort((left, right) =>
        left.destination.localeCompare(right.destination));
    const expected = mounts.map(normalize).sort((left, right) =>
        left.destination.localeCompare(right.destination));
    if (JSON.stringify(actual) !== JSON.stringify(expected))
        throw new Error(`Container mount boundary does not match: ${JSON.stringify(actual)}`);
};

const executionLog = (output, error) => {
    const parts = [];
    if (output) parts.push(String(output));
    if (error?.stdout) parts.push(String(error.stdout));
    if (error?.stderr) parts.push(String(error.stderr));
    return parts.join(parts.length > 1 ? '\n' : '');
};

/** Seed with source, remove that container, then execute only the standalone bytes. */
export const runStandaloneVerification = ({artifact, repo, evidenceDir, sourceSha,
    originalBuildRoot = repo, run = execFileSync, runId = randomUUID()}) => {
    if (!/^[a-f0-9]{40}$/.test(sourceSha)) throw new Error('An immutable source SHA is required');
    const candidate = path.resolve(artifact);
    const source = path.resolve(repo);
    const evidence = path.resolve(evidenceDir);
    const candidateInfo = fs.lstatSync(candidate);
    if (!candidateInfo.isFile() || candidateInfo.isSymbolicLink() || candidateInfo.nlink !== 1)
        throw new Error('Candidate must be an unlinked regular file');
    if (!fs.statSync(source).isDirectory()) throw new Error('Fixture source must be a directory');
    for (const entry of FIXTURE_SOURCE_ENTRIES) fs.statSync(path.join(source, entry));
    if (fs.existsSync(evidence)) throw new Error('Qualification evidence directory already exists');
    fs.mkdirSync(evidence, {recursive: false});

    const uid = typeof process.getuid === 'function' ? process.getuid() : DEFAULT_UID;
    const gid = typeof process.getgid === 'function' ? process.getgid() : DEFAULT_UID;
    const prefix = `myspeed-standalone-${runId}`;
    const resources = [
        {kind: 'volume', name: `${prefix}-populated`},
        {kind: 'volume', name: `${prefix}-reset`},
        {kind: 'volume', name: `${prefix}-handoff`},
        {kind: 'container', name: `${prefix}-seed`},
        {kind: 'container', name: `${prefix}-runtime`}
    ];
    const [populated, reset, handoff, seeder, runtime] = resources;
    const docker = (...args) => run('docker', args, {encoding: 'utf8', windowsHide: true,
        timeout: DOCKER_TIMEOUT_MS, maxBuffer: MAX_LOG_BYTES}).trim();
    const inspect = (resource, format) => {
        try {
            return docker(...(resource.kind === 'volume' ? ['volume'] : []), 'inspect',
                ...(format ? ['--format', format] : []), resource.name);
        } catch { return null; }
    };
    const isOwned = resource => inspect(resource,
        `{{ index ${resource.kind === 'volume' ? '.Labels' : '.Config.Labels'} "${LABEL}" }}`) === runId;
    const remove = resource => {
        if (!resource.created) return;
        if (!isOwned(resource)) throw new Error(`Refusing cleanup of unowned ${resource.name}`);
        docker(...(resource.kind === 'volume' ? ['volume', 'rm'] : ['rm', '-f']), resource.name);
        resource.created = false;
    };
    const create = (resource, args) => {
        try { return docker(...args); }
        finally { resource.created = isOwned(resource); }
    };
    const executeContainer = (resource, args, logName) => {
        try {
            const output = create(resource, args);
            fs.writeFileSync(path.join(evidence, logName), executionLog(output));
            return output;
        } catch (error) {
            fs.writeFileSync(path.join(evidence, logName), executionLog(undefined, error));
            throw error;
        }
    };
    let failure;
    try {
        for (const resource of resources) {
            if (inspect(resource) !== null) throw new Error(`Qualification resource already exists: ${resource.name}`);
        }
        try {
            fs.writeFileSync(path.join(evidence, 'helper-image-pull.log'), executionLog(docker('pull', IMAGE)));
        } catch (error) {
            fs.writeFileSync(path.join(evidence, 'helper-image-pull.log'), executionLog(undefined, error));
            throw error;
        }
        fs.writeFileSync(path.join(evidence, 'image-inspect.json'), docker('image', 'inspect', IMAGE));
        for (const resource of [populated, reset, handoff]) {
            create(resource, ['volume', 'create', '--label', `${LABEL}=${runId}`, resource.name]);
            if (!resource.created) throw new Error(`Volume ownership not proved: ${resource.name}`);
        }
        const workMounts = [
            '--mount', `type=volume,source=${populated.name},target=${POPULATED_WORK},volume-nocopy`,
            '--mount', `type=volume,source=${reset.name},target=${RESET_WORK},volume-nocopy`
        ];
        const common = ['--label', `${LABEL}=${runId}`, '--network', 'none',
            '--mount', `type=bind,source=${DIRECTORY},target=/qualification,readonly`, ...workMounts];
        const seedCommand = [
            'bun /qualification/fixture.mjs handoff --repo /fixture-source',
            `--work ${POPULATED_WORK} --reset-work ${RESET_WORK}`,
            `--manifest /handoff/${MANIFEST_NAME} --source-sha "$1"`,
            `&& chown -R "$2:$3" ${POPULATED_WORK} ${RESET_WORK}`,
            `&& chmod 644 /handoff/${MANIFEST_NAME}`
        ].join(' ');
        executeContainer(seeder, ['run', '--name', seeder.name, ...common, '--user', '0:0',
            ...FIXTURE_SOURCE_ENTRIES.flatMap(entry => ['--mount',
                `type=bind,source=${path.join(source, entry)},target=/fixture-source/${entry},readonly`]),
            '--mount', `type=volume,source=${handoff.name},target=/handoff,volume-nocopy`,
            '--entrypoint', 'sh', IMAGE, '-ec', seedCommand, 'qualification-seed', sourceSha, String(uid), String(gid)],
        'seeder.log');
        const seederInspection = inspect(seeder);
        if (seederInspection === null) throw new Error('Could not inspect the owned seeder container');
        assertContainerBoundary({inspection: seederInspection, runId, user: '0:0', mounts: [
            {type: 'bind', source: DIRECTORY, destination: '/qualification', rw: false},
            {type: 'volume', name: populated.name, destination: POPULATED_WORK, rw: true},
            {type: 'volume', name: reset.name, destination: RESET_WORK, rw: true},
            ...FIXTURE_SOURCE_ENTRIES.map(entry => ({type: 'bind', source: path.join(source, entry),
                destination: `/fixture-source/${entry}`, rw: false})),
            {type: 'volume', name: handoff.name, destination: '/handoff', rw: true}
        ]});
        fs.writeFileSync(path.join(evidence, 'seeder-inspect.json'), seederInspection);
        remove(seeder);

        executeContainer(runtime, ['run', '--name', runtime.name, ...common,
            '--user', `${uid}:${gid}`,
            '--mount', `type=bind,source=${candidate},target=/candidate,readonly`,
            '--mount', `type=bind,source=${evidence},target=/evidence`,
            '--mount', `type=volume,source=${handoff.name},target=/input,readonly`,
            '--entrypoint', 'bun', IMAGE, '/qualification/check-artifact.mjs',
            '--command', '/candidate', '--artifact', '/candidate',
            '--work', POPULATED_WORK, '--reset-work', RESET_WORK, '--keep-work',
            '--preseeded-fixture-manifest', `/input/${MANIFEST_NAME}`,
            '--original-build-root', originalBuildRoot, '--evidence-dir', '/evidence'], 'runtime.log');
        const runtimeInspection = inspect(runtime);
        if (runtimeInspection === null) throw new Error('Could not inspect the owned runtime container');
        assertContainerBoundary({inspection: runtimeInspection, runId, user: `${uid}:${gid}`, mounts: [
            {type: 'bind', source: DIRECTORY, destination: '/qualification', rw: false},
            {type: 'volume', name: populated.name, destination: POPULATED_WORK, rw: true},
            {type: 'volume', name: reset.name, destination: RESET_WORK, rw: true},
            {type: 'bind', source: candidate, destination: '/candidate', rw: false},
            {type: 'bind', source: evidence, destination: '/evidence', rw: true},
            {type: 'volume', name: handoff.name, destination: '/input', rw: false}
        ]});
        fs.writeFileSync(path.join(evidence, 'container-inspect.json'), runtimeInspection);
        collectSummary({evidenceDir: evidence, output: path.join(evidence, 'qualification-summary.json'),
            sourceSha, mode: 'full'});
    } catch (error) { failure = error; }
    finally {
        for (const resource of resources.toReversed()) {
            try { remove(resource); }
            catch (error) { failure = failure ? new AggregateError([failure, error], 'Verification and cleanup failed') : error; }
        }
    }
    if (failure) throw failure;
    return evidence;
};

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const {values} = parseArgs({options: {
        artifact: {type: 'string'}, repo: {type: 'string'}, 'evidence-dir': {type: 'string'},
        'source-sha': {type: 'string'}, 'original-build-root': {type: 'string'}
    }});
    runStandaloneVerification({artifact: values.artifact, repo: values.repo, evidenceDir: values['evidence-dir'],
        sourceSha: values['source-sha'], originalBuildRoot: values['original-build-root']});
}
