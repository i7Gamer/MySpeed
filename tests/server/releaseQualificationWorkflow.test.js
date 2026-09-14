import {describe, it} from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {createHash} from 'node:crypto';
import {parse} from 'yaml';
import {readSource} from '../helpers/source.js';

const read = (name) => readSource(`.github/workflows/${name}.yml`);
const workflow = (name) => parse(read(name));
const commands = (job) => (job.steps ?? []).map((step) => step.run ?? '').join('\n');
const uses = (job, prefix) => (job.steps ?? []).filter((step) => step.uses?.startsWith(prefix));
const SHA = 'a'.repeat(40);
const EXPIRED_DAYS = 8;
const HOURS_PER_DAY = 24;
const MINUTES_PER_HOUR = 60;
const SECONDS_PER_MINUTE = 60;
const MILLISECONDS_PER_SECOND = 1000;
const RELEASE_VERSION = '1.6.1';
const WINDOWS_STAMP = '1.6.1.4321';
const QUALIFICATION_RUN_ID = 123;
const QUALIFICATION_RUN_ATTEMPT = 1;
const REDUCED_SCOPE = 'owner-approved-reduced-v1.6.1';
const DEFERRED_WINDOWS_CHECKS = [
    'Windows native full verification with enforced outbound denial',
    'Windows native CPU-floor verification',
    'Disposable Windows MSI lifecycle acceptance'
];
const QUALIFICATION_ARTIFACTS = [
    'MySpeed-windows-x64.exe', 'MySpeed-windows-x64-baseline.exe', 'MySpeed-linux-x64',
    'MySpeed-linux-x64-baseline', 'MySpeed-linux-arm64', 'MySpeed-macos-x64',
    'MySpeed-macos-arm64', 'MySpeed.zip', 'release-msi-MySpeed-installer.msi',
    'release-msi-MySpeed-installer-baseline.msi', 'release-static', 'qualified-oci-amd64',
    'qualified-oci-arm64', 'qualified-oci-index', 'release-qualification-manifest'
];

describe('read-only release qualification', () => {
    const expectedArtifacts = QUALIFICATION_ARTIFACTS.filter(name => name !== 'release-qualification-manifest');
    const executeArtifactPreflight = async (names) => {
        const step = workflow('qualify-release').jobs.summary.steps
            .find(({name}) => name === 'Preflight immutable Actions artifact metadata');
        const artifacts = names.map((name, index) => ({name, id: index + 1, expired: false,
            size_in_bytes: 1024, digest: `sha256:${'b'.repeat(64)}`}));
        let written;
        await vm.runInNewContext(`(async () => {${step.with.script}})()`, {
            process: {env: {OUTPUT_PATH: 'synthetic-artifact-metadata.json'}},
            context: {repo: {owner: 'synthetic', repo: 'fixture'}, runId: 1},
            require: name => {
                assert.equal(name, 'fs');
                return {writeFileSync: (_file, bytes) => { written = JSON.parse(bytes); }};
            },
            github: {paginate: async () => artifacts,
                rest: {actions: {listWorkflowRunArtifacts() {}}}}
        });
        return written;
    };

    it('preflights only the complete exact candidate artifact set and diagnoses extra build records', async () => {
        assert.equal((await executeArtifactPreflight(expectedArtifacts)).artifacts.length, expectedArtifacts.length);
        const buildRecord = 'synthetic-build.dockerbuild';
        for (const names of [
            expectedArtifacts.filter(name => !name.startsWith('qualified-oci-')).concat(buildRecord),
            expectedArtifacts.concat(buildRecord),
            expectedArtifacts.concat(expectedArtifacts[0]),
        ]) await assert.rejects(executeArtifactPreflight(names), error => {
            assert.match(error.message, /Actions artifact set mismatch/);
            assert.match(error.message, /expected.*qualified-oci-index/);
            assert.match(error.message, /received/);
            return true;
        });
    });

    it('disables automatic Docker build-record uploads without weakening candidate provenance', () => {
        const job = workflow('build-docker').jobs.build;
        const builders = uses(job, 'docker/build-push-action@');
        assert.equal(builders.length, 1);
        assert.equal(builders[0].env?.DOCKER_BUILD_RECORD_UPLOAD, 'false');
        assert.match(builders[0].with.outputs, /type=oci/);
        assert.ok(uses(job, 'actions/upload-artifact@').some(step =>
            step.with.name === 'qualified-oci-${{ matrix.architecture }}'));
    });

    it('qualifies pull-request heads and explicitly selected immutable commits without write authority', () => {
        const source = read('qualify-release');
        const config = workflow('qualify-release');
        assert.ok(Object.hasOwn(config.on, 'pull_request'));
        assert.ok(config.on.workflow_dispatch.inputs.candidate_sha.required);
        assert.deepEqual(config.permissions, {actions: 'read', contents: 'read'});
        assert.doesNotMatch(source, /pull_request_target|secrets:\s*inherit|contents:\s*write/);
        assert.doesNotMatch(source, /createRelease|uploadReleaseAsset|deleteRelease|docker\/login-action|push:\s*true|git\s+(?:tag|push)/);
    });

    it('requires every test, binary, MSI, Docker and ICE result before publishing its manifest', () => {
        const config = workflow('qualify-release');
        const summary = config.jobs.summary;
        assert.equal(summary.if, '${{ always() }}');
        for (const job of ['prepare', 'tests', 'binaries', 'msi', 'docker', 'docker-index'])
            assert.ok(summary.needs.includes(job), job);
        assert.match(commands(summary), /qualification-manifest\.mjs create/);
        assert.match(commands(summary), /bun install --frozen-lockfile --ignore-scripts/);
        assert.match(JSON.stringify(summary), /needs\..*\.result/);
        assert.ok(uses(summary, 'actions/upload-artifact@').length);
    });

    it('builds MSI and OCI deliverables once, verifies them, and only uploads Actions artifacts', () => {
        const msi = workflow('build-msi');
        assert.deepEqual(Object.keys(msi.on.workflow_call.inputs).sort(), ['source_sha', 'version', 'windows_stamp']);
        assert.equal(msi.jobs['publish-msi'], undefined);
        assert.equal((msi.jobs['build-msi'].permissions ?? msi.permissions).contents, 'read');
        assert.match(commands(msi.jobs['build-msi']), /-sice:ICE61/);
        assert.match(commands(msi.jobs['build-msi']), /FileVersionInfo/);
        assert.match(commands(msi.jobs['build-msi']), /ProductVersion/);
        assert.match(commands(msi.jobs['build-msi']), /WINDOWS_STAMP/);
        assert.match(commands(msi.jobs['build-msi']), /msi-build-provenance\.json/);
        assert.ok(uses(msi.jobs['build-msi'], 'actions/upload-artifact@')[0].with.path.includes('.sha256'));
        assert.match(uses(msi.jobs['build-msi'], 'actions/upload-artifact@')[0].with.path,
            /ice-validation\.log\.sha256/);

        const docker = workflow('build-docker');
        assert.equal(docker.on.workflow_call.secrets, undefined);
        assert.deepEqual(Object.keys(docker.on.workflow_call.inputs).sort(), ['ref', 'version', 'windows_stamp']);
        const source = read('build-docker');
        assert.doesNotMatch(source, /docker\/login-action|push:\s*true|DOCKERHUB_/);
        assert.equal((docker.jobs.build.permissions ?? docker.permissions).contents, 'read');
        assert.match(source, /type=oci/);
        assert.match(source, /verify-image\.sh/);
        assert.match(source, /oci-provenance\.json/);
        assert.match(source, /skopeo copy --format v2s2 "oci-archive:\$OCI_ARCHIVE" docker-daemon:myspeed:verify/);
        assert.doesNotMatch(source, /skopeo copy --preserve-digests[^\n]*docker-daemon/);
        assert.match(source, /--container-inspect "\$EVIDENCE_ROOT\/container-inspect\.json"/);
        assert.match(source, /QUALIFICATION_EVIDENCE_DIRECTORY/);
        const imageVerifier = readSource('scripts/verify-image.sh');
        assert.match(imageVerifier, /qualification-summary\.json/);
        assert.match(readSource('scripts/qualification/collect-summary.mjs'),
            /`\$\{output\}\.sha256`/);
        assert.ok(uses(docker.jobs.build, 'actions/upload-artifact@').length);
    });

    it('keeps every local reusable workflow reference resolvable after retiring development deployment', () => {
        const release = workflow('qualify-release');
        const releaseUses = Object.values(release.jobs).map(({uses: value}) => value).filter(Boolean);
        assert.ok(releaseUses.includes('./.github/workflows/build-docker.yml'));
        assert.ok(workflow('create_release').jobs['publish-docker'].uses
            .endsWith('/publish-docker.yml'));
        for (const [name, config] of ['qualify-release', 'create_release', 'merge-dependabot']
            .map((name) => [name, workflow(name)])) {
            for (const job of Object.values(config.jobs)) {
                if (!job.uses?.startsWith('./.github/workflows/')) continue;
                assert.doesNotMatch(job.uses, /docker-dev|deploy_docker_dev/, name);
                assert.doesNotThrow(() => read(job.uses.slice('./.github/workflows/'.length, -4)));
            }
        }
    });
});

describe('trusted artifact-only promotion', () => {
    const executePromotionGuard = async (job, mutate = () => {}) => {
        const script = job.steps.find(({name}) => name === 'Revalidate promotion immediately before mutation').with.script;
        const manifest = {run: {id: QUALIFICATION_RUN_ID, attempt: QUALIFICATION_RUN_ATTEMPT},
            source: {repository: 'i7Gamer/MySpeed', sha: SHA, version: RELEASE_VERSION, windowsStamp: WINDOWS_STAMP},
            promotion: {eligible: true, blockers: [], scope: {id: REDUCED_SCOPE,
                deferredChecks: [...DEFERRED_WINDOWS_CHECKS]},
            evidence: {windowsNative: null, windowsCpuFloor: null, msiLifecycle: null}}};
        const env = {MANIFEST: 'fixture-manifest.json', RUN_ID: String(QUALIFICATION_RUN_ID),
            RUN_ATTEMPT: String(QUALIFICATION_RUN_ATTEMPT), SOURCE_SHA: SHA, VERSION: RELEASE_VERSION,
            WINDOWS_STAMP, DEFAULT_BRANCH: 'development'};
        const context = {repo: {owner: 'i7Gamer', repo: 'MySpeed'}, ref: 'refs/heads/development'};
        const run = {run_attempt: QUALIFICATION_RUN_ATTEMPT, event: 'workflow_dispatch', conclusion: 'success',
            path: '.github/workflows/qualify-release.yml', head_repository: {full_name: manifest.source.repository},
            head_sha: SHA, head_branch: 'development', created_at: new Date().toISOString()};
        const branch = {commit: {sha: SHA}};
        mutate({manifest, env, context, run, branch});
        const bytes = Buffer.from(JSON.stringify(manifest));
        const seal = createHash('sha256').update(bytes).digest('hex');
        await vm.runInNewContext(`(async () => {${script}})()`, {
            process: {env}, context,
            require: name => {
                if (name === 'crypto') return {createHash};
                assert.equal(name, 'fs');
                return {lstatSync: () => ({isFile: () => true, nlink: 1, size: bytes.length}),
                    readFileSync: file => {
                        if (file === env.MANIFEST) return bytes;
                        assert.equal(file, env.MANIFEST + '.sha256');
                        return seal;
                    }};
            },
            github: {rest: {
                actions: {getWorkflowRun: async () => ({data: run})},
                repos: {getBranch: async () => ({data: branch})}
            }}
        });
    };

    it('requires the exact release-only scope at all four pre-mutation boundaries', async () => {
        const jobs = [workflow('create_release').jobs['create-draft'],
            workflow('create_release').jobs['publish-assets'], workflow('publish-docker').jobs.publish,
            workflow('finalize-release').jobs.finalize];
        for (const job of jobs) {
            await assert.doesNotReject(executePromotionGuard(job));
            for (const mutate of [
                ({manifest}) => { delete manifest.promotion.scope; },
                ({manifest}) => { manifest.promotion.scope.id = 'full-native'; },
                ({manifest}) => { manifest.promotion.scope.deferredChecks = []; },
                ({manifest}) => { manifest.promotion.scope.deferredChecks.push('tests'); },
                ({manifest}) => { manifest.promotion.evidence.windowsNative = {status: 'passed'}; },
                ({manifest}) => { manifest.promotion.evidence.windowsCpuFloor = {status: 'passed'}; },
                ({manifest}) => { manifest.promotion.evidence.msiLifecycle = {status: 'passed'}; },
                ({manifest}) => { manifest.promotion.eligible = false; },
                ({manifest}) => { manifest.promotion.blockers = ['required check']; },
                ({manifest}) => { manifest.source.repository = 'fork/MySpeed'; },
                ({manifest, context, run}) => { context.repo.owner = 'fork';
                    manifest.source.repository = run.head_repository.full_name = 'fork/MySpeed'; },
                ({manifest, env}) => { manifest.source.version = env.VERSION = '1.6.2';
                    manifest.source.windowsStamp = env.WINDOWS_STAMP = '1.6.2.4321'; },
                ({run}) => { run.conclusion = 'failure'; },
                ({run}) => { run.event = 'pull_request'; },
                ({run}) => { run.run_attempt++; },
                ({run}) => { run.created_at = new Date(0).toISOString(); },
                ({branch}) => { branch.commit.sha = 'b'.repeat(40); }
            ]) await assert.rejects(executePromotionGuard(job, mutate), /qualification|scope/i);
        }
    });

    const executeRunGate = async (overrides = {}) => {
        const config = workflow('create_release');
        const script = config.jobs.validate.steps.find((step) => step.name
            === 'Validate qualification run provenance').with.script;
        const repository = 'i7Gamer/MySpeed';
        const run = {
            run_attempt: 1, event: 'workflow_dispatch', conclusion: 'success',
            path: '.github/workflows/qualify-release.yml', head_repository: {full_name: repository},
            head_sha: SHA, head_branch: 'main', created_at: new Date().toISOString(),
            ...overrides.run
        };
        const branchSha = overrides.branchSha ?? SHA;
        return vm.runInNewContext(`(async () => {${script}})()`, {
            process: {env: {RUN_ID: '123', RUN_ATTEMPT: '1', SOURCE_SHA: SHA,
                DEFAULT_BRANCH: 'main', ...overrides.env}},
            context: {repo: {owner: 'i7Gamer', repo: 'MySpeed'}, ref: overrides.ref ?? 'refs/heads/main',
                sha: overrides.workflowSha ?? SHA},
            require: (name) => {
                assert.equal(name, 'fs');
                return {writeFileSync() {}};
            },
            github: {paginate: async () => overrides.artifacts ?? QUALIFICATION_ARTIFACTS.map((name, index) => ({
                name, id: index + 1, expired: false, size_in_bytes: 1024,
                digest: `sha256:${'b'.repeat(64)}`
            })), rest: {
                actions: {getWorkflowRun: async () => ({data: run})},
                repos: {getBranch: async () => ({data: {commit: {sha: branchSha}}})}
            }}
        });
    };

    it('accepts only a specific qualification run attempt and immutable source identity', () => {
        const config = workflow('create_release');
        assert.deepEqual(Object.keys(config.on.workflow_dispatch.inputs).sort(),
            ['candidate_sha', 'qualification_run_attempt', 'qualification_run_id', 'version', 'windows_stamp']);
        const validate = config.jobs.validate;
        assert.equal((validate.permissions ?? config.permissions).actions, 'read');
        assert.match(commands(validate), /qualification-manifest\.mjs validate/);
        assert.match(commands(validate), /promotion\.eligible/);
        assert.match(JSON.stringify(validate), /workflow_dispatch/);
        assert.match(JSON.stringify(validate), /qualify-release\.yml/);
        assert.match(JSON.stringify(validate), /expired|created_at|createdAt/i);
    });

    it('keeps candidate execution and compilers out of every job with write credentials', () => {
        const source = read('create_release');
        assert.doesNotMatch(source, /build-binaries\.yml|build-msi\.yml|build-docker\.yml|bun build|candle|light|docker build/);
        const config = workflow('create_release');
        for (const [name, job] of Object.entries(config.jobs)) {
            const permissions = job.permissions ?? config.permissions ?? {};
            if (permissions.contents !== 'write' && !job.environment) continue;
            assert.equal(uses(job, 'actions/checkout@').length, 0, name);
            assert.doesNotMatch(commands(job), /(?:node|bun)\s+[^\n]*scripts\/|\.\/(?:MySpeed|install|chooser)|npm\s|candle|light|docker\s+run/, name);
        }
    });

    it('grants manifest read permission through both reusable publication calls', () => {
        const callers = workflow('create_release').jobs;
        for (const [name, contents] of [['publish-docker', 'read'], ['finalize-release', 'write']]) {
            const required = {actions: 'read', contents};
            assert.deepEqual(callers[name].permissions, required, `${name} caller permission ceiling`);
            const callee = workflow(name);
            assert.deepEqual(callee.permissions, required, `${name} workflow permissions`);
            for (const job of Object.values(callee.jobs))
                assert.deepEqual(job.permissions ?? callee.permissions, required, `${name} nested job permissions`);
        }
    });

    it('pins trusted validation code to the already-proven workflow commit', () => {
        const validate = workflow('create_release').jobs.validate;
        const checkout = uses(validate, 'actions/checkout@')[0];
        assert.equal(checkout.with.ref, '${{ github.sha }}');
        assert.match(commands(validate), /git rev-parse HEAD/);
        assert.match(commands(validate), /GITHUB_SHA/);
        assert.doesNotMatch(JSON.stringify(checkout.with), /default_branch/);
        assert.match(commands(validate), /bun install --frozen-lockfile --ignore-scripts/);
        for (const [name, job] of Object.entries(workflow('create_release').jobs)) {
            if (name === 'validate' || !job.environment) continue;
            assert.doesNotMatch(commands(job), /(?:bun|npm|pnpm|yarn) install/, name);
        }
    });

    it('rechecks freshness, default head and eligibility after approval before every mutation', () => {
        const guarded = [
            [workflow('create_release').jobs['create-draft'], 'Create tag and draft release'],
            [workflow('create_release').jobs['publish-assets'], 'Upload fixed validated release payloads'],
            [workflow('publish-docker').jobs.publish, 'Login to Docker Hub'],
            [workflow('finalize-release').jobs.finalize, 'Generate notes and publish the existing draft']
        ];
        for (const [job, mutationName] of guarded) {
            const guardIndex = job.steps.findIndex(({name}) => name === 'Revalidate promotion immediately before mutation');
            const mutationIndex = job.steps.findIndex(({name}) => name === mutationName);
            assert.ok(guardIndex >= 0 && guardIndex < mutationIndex, mutationName);
            const guard = job.steps[guardIndex].with.script;
            assert.match(guard, /getWorkflowRun/);
            assert.match(guard, /getBranch/);
            assert.match(guard, /promotion\.eligible/);
            assert.match(guard, /created_at/);
        }
        const finalize = workflow('finalize-release').jobs.finalize.steps.find(({name}) =>
            name === 'Generate notes and publish the existing draft');
        assert.match(finalize.with.script, /getRef/);
        assert.equal(finalize.env.SOURCE_SHA, '${{ inputs.candidate_sha }}');
        const dockerSteps = workflow('publish-docker').jobs.publish.steps;
        const installIndex = dockerSteps.findIndex(({name}) => name === 'Install OCI transport without registry credentials');
        const loginIndex = dockerSteps.findIndex(({name}) => name === 'Login to Docker Hub');
        assert.ok(installIndex >= 0 && installIndex < loginIndex);
        assert.doesNotMatch(dockerSteps.slice(loginIndex).map(({run = ''}) => run).join('\n'), /apt-get/);
    });

    it('publishes the compact platform download matrix and keeps generated notes intact', async () => {
        const step = workflow('finalize-release').jobs.finalize.steps.find(({name}) =>
            name === 'Generate notes and publish the existing draft');
        const generatedNotes = '## What\'s Changed\n\n* Synthetic generated entry';
        const repository = 'i7Gamer/MySpeed';
        const tag = `v${RELEASE_VERSION}`;
        const base = `https://github.com/${repository}/releases/download/${tag}/`;
        const expectedDownloads = [
            ['EXE', 'MySpeed-windows-x64.exe'],
            ['MSI', 'MySpeed-installer.msi'],
            ['EXE (no AVX2)', 'MySpeed-windows-x64-baseline.exe'],
            ['MSI (no AVX2)', 'MySpeed-installer-baseline.msi'],
            ['Binary', 'MySpeed-linux-x64'],
            ['No AVX2', 'MySpeed-linux-x64-baseline'],
            ['Binary', 'MySpeed-linux-arm64'],
            ['Binary', 'MySpeed-macos-x64'],
            ['Binary', 'MySpeed-macos-arm64'],
            ['ZIP Archive', 'MySpeed.zip'],
            ['Linux installer', 'install.sh'],
            ['Docker installer', 'docker-install.sh'],
            ['Installer chooser', 'chooser.sh'],
            ['SHA-256 checksums', 'SHA256SUMS'],
            ['Qualification manifest', 'qualification-manifest.json'],
            ['Manifest SHA-256', 'qualification-manifest.json.sha256']
        ];
        let published;
        await vm.runInNewContext(`(async () => {${step.with.script}})()`, {
            process: {env: {RELEASE_ID: '456', SOURCE_SHA: SHA, VERSION: RELEASE_VERSION}},
            context: {repo: {owner: 'i7Gamer', repo: 'MySpeed'}},
            github: {rest: {
                repos: {
                    getRelease: async () => ({data: {draft: true, tag_name: tag,
                        target_commitish: 'development'}}),
                    generateReleaseNotes: async () => ({data: {body: generatedNotes}}),
                    updateRelease: async (request) => { published = request; }
                },
                git: {getRef: async () => ({data: {object: {type: 'commit', sha: SHA}}})}
            }}
        });

        const matrix = [
            '| Platform | x86-64 | ARM64 |',
            '| :-- | :-- | :-- |',
            `| **Windows** | [EXE](${base}MySpeed-windows-x64.exe) · [MSI](${base}MySpeed-installer.msi) · [EXE (no AVX2)](${base}MySpeed-windows-x64-baseline.exe) · [MSI (no AVX2)](${base}MySpeed-installer-baseline.msi) | — |`,
            `| **Linux** | [Binary](${base}MySpeed-linux-x64) · [No AVX2](${base}MySpeed-linux-x64-baseline) | [Binary](${base}MySpeed-linux-arm64) |`,
            `| **macOS** | [Binary](${base}MySpeed-macos-x64) | [Binary](${base}MySpeed-macos-arm64) |`
        ].join('\n');
        assert.match(published.body, new RegExp(matrix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
        for (const heading of ['### Source Distribution', '### Docker Images',
            '### Installation Scripts', '### Checksums and Qualification'])
            assert.equal(published.body.split(heading).length - 1, 1, heading);
        for (const [label, file] of expectedDownloads) {
            const link = `[${label}](${base}${file})`;
            assert.equal(published.body.split(link).length - 1, 1, link);
        }
        assert.match(published.body, /Windows native HTTP\/service runtime with enforced outbound denial is not verified/);
        assert.match(published.body, /AVX-disabled Windows CPU-floor execution is not verified/);
        assert.match(published.body, /complete Windows MSI install\/upgrade\/rollback\/uninstall lifecycle is not verified/);
        assert.ok(published.body.endsWith(generatedNotes));
    });

    it('rejects failed, skipped, fork, stale, expired and non-default qualification runs', async () => {
        await assert.doesNotReject(executeRunGate());
        const old = new Date(Date.now() - EXPIRED_DAYS * HOURS_PER_DAY * MINUTES_PER_HOUR
            * SECONDS_PER_MINUTE * MILLISECONDS_PER_SECOND).toISOString();
        for (const defect of [
            {run: {conclusion: 'failure'}}, {run: {conclusion: 'skipped'}},
            {run: {event: 'pull_request'}}, {run: {head_repository: {full_name: 'fork/MySpeed'}}},
            {run: {run_attempt: 2}},
            {run: {head_sha: 'b'.repeat(40)}}, {run: {created_at: old}},
            {run: {path: '.github/workflows/other.yml'}}, {ref: 'refs/heads/feature'},
            {branchSha: 'b'.repeat(40)},
            {artifacts: []},
            {artifacts: QUALIFICATION_ARTIFACTS.map((name, index) => ({name, id: index + 1,
                expired: false, size_in_bytes: Number.MAX_SAFE_INTEGER,
                digest: `sha256:${'b'.repeat(64)}`}))}
        ]) await assert.rejects(executeRunGate(defect), /qualification|trusted|stale|expired|default|artifact/i);
    });

    it('publishes exact OCI archives without rebuilding and finalizes only after asset and image gates', () => {
        const docker = read('publish-docker');
        assert.doesNotMatch(docker, /build-push-action|actions\/checkout/);
        assert.match(docker, /skopeo copy --all --preserve-digests/);
        assert.match(docker, /oci-archive:\$archive:myspeed/);
        assert.doesNotMatch(docker, /imagetools create/);
        assert.match(docker, /qualification_run_id/);

        const config = workflow('create_release');
        assert.ok(config.jobs['finalize-release'].needs.includes('publish-assets'));
        assert.ok(config.jobs['finalize-release'].needs.includes('publish-docker'));
        assert.equal(config.jobs['publish-assets'].environment, 'release-production');
        assert.equal(workflow('publish-docker').jobs.publish.environment, 'release-production');
    });
});
