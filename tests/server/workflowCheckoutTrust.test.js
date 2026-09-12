import {describe, it} from 'node:test';
import assert from 'node:assert/strict';
import {parse} from 'yaml';
import {readSource} from '../helpers/source.js';

const workflow = (name) => parse(readSource(`.github/workflows/${name}.yml`));
const checkoutSteps = (job) => (job.steps ?? [])
    .filter(({uses}) => uses?.startsWith('actions/checkout@'));
const EVENT_CHECKOUT = "${{ github.event_name == 'pull_request' && github.event.pull_request.head.sha || github.sha }}";

describe('release checkout trust boundaries', () => {
    it('keeps Docker cache writers on the event-owned commit and validates candidate identity', () => {
        const job = workflow('build-docker').jobs.build;
        const checkouts = checkoutSteps(job);
        assert.equal(checkouts.length, 1);
        assert.equal(checkouts[0].with.ref, EVENT_CHECKOUT);
        assert.doesNotMatch(checkouts[0].with.ref, /inputs\.|needs\./);
        assert.equal(checkouts[0].with['persist-credentials'], false);
        const validation = job.steps.find(({name}) => name === 'Validate qualification inputs');
        assert.equal(validation?.env?.SOURCE_SHA, '${{ inputs.ref }}');
    });

    it('never gives a manual binary qualification ref to checkout', () => {
        const config = workflow('build-binaries');
        const checkoutJobs = Object.entries(config.jobs)
            .filter(([, job]) => checkoutSteps(job).length > 0);

        assert.ok(checkoutJobs.length > 0);
        for (const [name, job] of checkoutJobs) {
            const checkouts = checkoutSteps(job);
            assert.equal(checkouts.length, 1, name);
            assert.equal(checkouts[0].with.ref, EVENT_CHECKOUT, name);
            assert.doesNotMatch(checkouts[0].with.ref, /inputs\.|needs\./, name);
            assert.equal(checkouts[0].with['persist-credentials'], false, name);

            const validation = job.steps.find(({name: stepName}) =>
                stepName === 'Validate qualification inputs');
            assert.equal(validation?.env?.SOURCE_SHA, '${{ inputs.ref }}', name);
        }
    });

    it('uses the event-owned PR head or workflow commit while resolving identity', () => {
        const config = workflow('qualify-release');
        const checkout = checkoutSteps(config.jobs.prepare)[0];

        assert.equal(checkout.with.ref, EVENT_CHECKOUT);
        assert.doesNotMatch(checkout.with.ref, /inputs\.candidate_sha/);

        const identity = config.jobs.prepare.steps.find(({name}) =>
            name === 'Resolve and validate identity');
        assert.equal(identity.env.DISPATCH_SHA, '${{ github.sha }}');
        assert.match(identity.run, /\[ "\$REF_NAME" = "\$DEFAULT_BRANCH" \]/);
        assert.match(identity.run, /\[ "\$SOURCE_SHA" = "\$DISPATCH_SHA" \]/);
    });

    it('keeps later qualification tools on the trusted workflow commit for manual runs', () => {
        const config = workflow('qualify-release');

        for (const name of ['docker-index', 'summary']) {
            const checkouts = checkoutSteps(config.jobs[name]);
            assert.equal(checkouts.length, 1, name);
            assert.equal(checkouts[0].with.ref, EVENT_CHECKOUT, name);
            assert.doesNotMatch(checkouts[0].with.ref, /inputs\.|needs\./, name);
            assert.equal(checkouts[0].with['persist-credentials'], false, name);
        }
    });
});
