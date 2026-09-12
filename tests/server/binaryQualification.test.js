import {it} from 'node:test';
import assert from 'node:assert/strict';
import {parse} from 'yaml';
import {readSource} from '../helpers/source.js';
import {QUALIFIED_BUN_VERSION} from '../../scripts/build-binary.mjs';

const source = readSource('.github/workflows/build-binaries.yml');
const workflow = parse(source);
const inputs = workflow.on.workflow_call.inputs;
const PAYLOAD_JOBS = ['build-windows', 'build-linux', 'build-macos', 'build-zip'];
const COMPILER_JOBS = ['build-windows', 'build-linux', 'build-macos'];

it('binary qualification accepts immutable source/stamp inputs without release authority', () => {
    assert.equal(inputs.ref.required, true);
    assert.equal(inputs.windows_stamp.required, true);
    assert.equal(inputs.release_id, undefined);
    assert.deepEqual(workflow.permissions, {contents: 'read'});
    assert.doesNotMatch(source, /contents: write|uploadReleaseAsset|deleteReleaseAsset|createRelease/);
});

it('every binary build checks out and verifies the exact qualification SHA', () => {
    for (const name of PAYLOAD_JOBS) {
        const steps = workflow.jobs[name].steps;
        const checkout = steps.find(step => step.uses?.startsWith('actions/checkout@'));
        assert.equal(checkout.with.ref, '${{ inputs.ref }}', name);
        assert.equal(checkout.with['persist-credentials'], false, name);
        const validation = steps.find(step => step.name === 'Validate qualification inputs');
        assert.ok(validation, `${name} must reject a changed SHA/version/stamp before building`);
        assert.equal(validation.env.SOURCE_SHA, '${{ inputs.ref }}');
        assert.equal(validation.env.WINDOWS_STAMP, '${{ inputs.windows_stamp }}');
    }
});

it('all native Linux legs use the architecture-independent artifact verifier', () => {
    const job = workflow.jobs['build-linux'];
    assert.ok(job.strategy.matrix.include.every(leg => leg.verify !== false));
    const verify = job.steps.find(step => step.name === 'Verify binary boots and serves');
    assert.ok(verify);
    assert.notEqual(verify.shell, 'pwsh');
    assert.equal(verify.if, undefined, 'No native leg may silently omit runtime qualification');
    assert.match(verify.run, /qualification\/verify-standalone\.mjs/);
    assert.doesNotMatch(verify.run, /target=\/fixture-source/);
});

it('retains bound verifier summaries beside every compiled payload', () => {
    for (const name of PAYLOAD_JOBS.filter(name => name !== 'build-zip')) {
        const upload = workflow.jobs[name].steps.find(step => step.uses?.startsWith('actions/upload-artifact@'));
        assert.match(upload.with.path, /qualification-summary\.json/);
        assert.match(upload.with.path, /qualification-summary\.json\.sha256/);
    }
    const upload = workflow.jobs['build-zip'].steps.find(step => step.uses?.startsWith('actions/upload-artifact@'));
    for (const runtime of ['node', 'bun'])
        assert.ok(upload.with.path.includes(`qualification-${runtime}-summary.json.sha256`));
});

it('asserts actual Windows file and product versions before recording the frozen stamp', () => {
    const steps = workflow.jobs['build-windows'].steps;
    const stamp = steps.findIndex(step => step.name === 'Verify Windows version metadata');
    const hash = steps.findIndex(step => step.name === 'Hash verified binary');
    assert.ok(stamp >= 0 && stamp < hash);
    assert.match(steps[stamp].run, /VersionInfo/);
    assert.match(steps[stamp].run, /FileVersion/);
    assert.match(steps[stamp].run, /ProductVersion/);
    assert.match(steps[stamp].run, /windows-version\.json/);
});

it('labels Windows and macOS listener-free runs as rehearsal, not full qualification', () => {
    for (const name of ['build-windows', 'build-macos']) {
        const verify = workflow.jobs[name].steps.find(step => step.run?.includes('verify-binary.ps1'));
        assert.match(verify.name, /listener-free rehearsal/i);
        assert.match(verify.run, /-ListenerFree\b/);
        assert.match(verify.run, /-EvidenceDirectory/);
    }
});

it('the Windows compile uses the frozen qualification stamp rather than a new run number', () => {
    const compile = workflow.jobs['build-windows'].steps.find(step => step.name === 'Compile binary');
    assert.equal(compile.env.WINDOWS_STAMP, '${{ inputs.windows_stamp }}');
    assert.match(compile.run, /--windows-version[= ]+"\$env:WINDOWS_STAMP"/);
    assert.doesNotMatch(compile.run, /RUN_NUMBER/);
});

it('compiles both Linux x64 compatibility names with the native unified runtime', () => {
    const legs = workflow.jobs['build-linux'].strategy.matrix.include.filter(leg => leg.label.startsWith('x64'));
    assert.equal(legs.length, 2);
    assert.deepEqual(legs.map(leg => leg.target), ['bun-linux-x64', 'bun-linux-x64']);
    const localScript = JSON.parse(readSource('package.json')).scripts['build:binary:baseline'];
    assert.match(localScript, /--target=bun-linux-x64 /);
    assert.doesNotMatch(localScript, /--target=bun-linux-x64-baseline/);
    assert.match(localScript, /--outfile MySpeed-linux-x64-baseline/);
});

it('pins every release compiler job to the runtime enforced by the build entrypoint', () => {
    for (const name of COMPILER_JOBS) {
        const steps = workflow.jobs[name].steps;
        const setup = steps.find(step => step.uses?.startsWith('oven-sh/setup-bun@'));
        const compile = steps.find(step => step.name === 'Compile binary');
        assert.equal(String(setup?.with?.['bun-version']), QUALIFIED_BUN_VERSION, name);
        assert.match(compile?.run ?? '', /bun scripts\/build-binary\.mjs/, name);
    }
});

it('qualification includes all three hashed install scripts without publishing them', () => {
    const job = workflow.jobs['build-static'];
    assert.ok(job);
    const upload = job.steps.find(step => step.uses?.startsWith('actions/upload-artifact@'));
    assert.equal(upload.with.name, 'release-static');
    for (const filename of ['install.sh', 'docker-install.sh', 'chooser.sh']) {
        assert.ok(upload.with.path.includes(filename));
        assert.ok(upload.with.path.includes(`${filename}.sha256`));
    }
});

it('every client payload includes the maintained HarfBuzz notices before it is built', () => {
    for (const name of PAYLOAD_JOBS) {
        const steps = workflow.jobs[name].steps;
        const notice = steps.findIndex(step => step.run?.includes('generate-third-party-notices.mjs'));
        const client = steps.findIndex(step => step.name === 'Build client');
        assert.ok(notice >= 0 && notice < client, name);
    }
    assert.match(JSON.parse(readSource('package.json')).scripts.build,
        /^node scripts\/generate-third-party-notices\.mjs &&/);
    const dockerfile = readSource('Dockerfile');
    assert.ok(dockerfile.indexOf('RUN bun /scripts/generate-third-party-notices.mjs') <
        dockerfile.indexOf('RUN bun run build'));
    assert.match(dockerfile, /COPY \.\/scripts\/licenses \/scripts\/licenses/);
});

it('keeps local qualification snapshots out of the Docker build context', () => {
    assert.match(readSource('.dockerignore'), /^\/?\.qa-release\/?$/m);
});

it('executes the packaged source ZIP on minimum Node and Bun before upload', () => {
    const steps = workflow.jobs['build-zip'].steps;
    const verifyIndex = steps.findIndex(step => step.name === 'Verify packaged source on Node and Bun');
    const uploadIndex = steps.findIndex(step => step.uses?.startsWith('actions/upload-artifact@'));
    assert.ok(verifyIndex >= 0 && verifyIndex < uploadIndex);
    const verify = steps[verifyIndex].run;
    assert.match(verify, /unzip -q MySpeed\.zip/);
    assert.match(verify, /bun install --production --frozen-lockfile/);
    assert.match(verify, /node:22\.19\.0-bookworm-slim/);
    assert.match(verify, /oven\/bun:1\.4\.2/);
    assert.match(verify, /--network none/);
    assert.match(verify, /check-artifact\.mjs/);
    assert.match(verify, /--arg \/source\/server\/index\.js/);
    assert.match(verify, /source=\$work,target=\/test-work/);
    assert.match(verify, /source=\$source_snapshot\/build,target=\/test-work\/build,readonly/);
    assert.match(verify, /--work \/test-work --keep-work/);
});
