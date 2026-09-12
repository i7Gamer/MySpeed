import {describe, it} from 'node:test';
import assert from 'node:assert/strict';
import {parse} from 'yaml';
import {readSource} from '../helpers/source.js';

const workflow = (name) => parse(readSource(`.github/workflows/${name}.yml`));
const needs = (job) => Array.isArray(job.needs) ? job.needs : [job.needs].filter(Boolean);

describe('qualification ordering', () => {
    const jobs = workflow('qualify-release').jobs;

    it('builds installers only from completed qualified binaries', () => {
        assert.ok(needs(jobs.msi).includes('binaries'));
        assert.ok(needs(jobs.msi).includes('prepare'));
    });

    it('seals only after every test and build family reports', () => {
        for (const gate of ['prepare', 'tests', 'binaries', 'msi', 'docker'])
            assert.ok(needs(jobs.summary).includes(gate), gate);
        assert.equal(jobs.summary.if, '${{ always() }}');
    });

    it('contains no registry or GitHub release mutation', () => {
        const source = readSource('.github/workflows/qualify-release.yml');
        assert.doesNotMatch(source, /contents:\s*write|docker\/login-action|uploadReleaseAsset|createRelease|createRef|push:\s*true/);
    });
});

describe('promotion ordering', () => {
    const jobs = workflow('create_release').jobs;

    it('creates no draft before trusted validation succeeds', () => {
        assert.deepEqual(needs(jobs['create-draft']), ['validate']);
    });

    it('publishes assets and images only from the exact draft and validation', () => {
        for (const gate of ['validate', 'create-draft']) assert.ok(needs(jobs['publish-assets']).includes(gate));
        for (const gate of ['validate', 'create-draft', 'publish-assets'])
            assert.ok(needs(jobs['publish-docker']).includes(gate));
    });

    it('publishes the release only after assets and Docker aliases succeed', () => {
        for (const gate of ['create-draft', 'publish-assets', 'publish-docker'])
            assert.ok(needs(jobs['finalize-release']).includes(gate));
    });

    it('preserves forensic artifacts instead of deleting a partial promotion', () => {
        assert.match(jobs['report-failure'].if, /failure\(\)/);
        assert.doesNotMatch(readSource('.github/workflows/create_release.yml'), /deleteRelease|deleteRef|gh release delete/);
    });
});

describe('build once and promote exact OCI content', () => {
    it('keeps build and publication in separate reusable workflows', () => {
        const build = readSource('.github/workflows/build-docker.yml');
        const publish = readSource('.github/workflows/publish-docker.yml');
        assert.match(build, /type=oci/);
        assert.doesNotMatch(build, /docker\/login-action|push:\s*true/);
        assert.match(publish, /skopeo copy --all --preserve-digests/);
        assert.match(publish, /oci-archive:\$archive:myspeed/);
        assert.doesNotMatch(publish, /build-push-action|docker build(?:\s|$)|imagetools create/m);
    });
});
