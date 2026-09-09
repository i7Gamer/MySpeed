import {before, after, beforeEach, afterEach, describe, it, mock} from 'node:test';
import assert from 'node:assert/strict';
import bcrypt from 'bcryptjs';
import {bootServer, api, seedTests, seedTarget, setConfig} from './helpers/boot.js';

let server, changes, speedtests, integrations, tokenModel, tokens, targets;
const OLD_PASSWORD = 'Original1!';
const NEW_PASSWORD = 'Replacement2!';
const JSON_HEADERS = {'content-type': 'application/json'};
const FAST_HASH_COST = 4;
const OVERLAPPING_COUNT_DELAY_MS = 50;
const deferred = () => {
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    return {promise, resolve};
};
before(async () => {
    server = await bootServer();
    changes = (await import('../../server/models/ConnectionChanges.js')).default;
    speedtests = await import('../../server/controller/speedtests.js');
    integrations = (await import('../../server/models/IntegrationData.js')).default;
    tokenModel = (await import('../../server/models/ApiTokens.js')).default;
    tokens = await import('../../server/controller/tokens.js');
    targets = await import('../../server/controller/targets.js');
});
after(async () => { await server?.close(); });
beforeEach(async () => {
    await setConfig(server.config, 'password', 'none');
    await setConfig(server.config, 'passwordLevel', 'none');
    await seedTests(server.tests, []);
    await changes.destroy({where: {}});
    await tokenModel.destroy({where: {}});
});
afterEach(() => mock.restoreAll());

describe('review auth races', () => {
    for (const kind of ['header', 'metrics']) {
        for (const change of ['rotate', 'remove', 'replace same hash', 'raw database write']) {
            it(`${kind} rejects credentials after ${change} during comparison`, async () => {
                await setConfig(server.config, 'password', OLD_PASSWORD);
                const hash = await server.config.getValue('password');
                const entered = deferred(), release = deferred();
                const originalCompare = bcrypt.compare;
                mock.method(bcrypt, 'compare', async (...args) => {
                    entered.resolve();
                    await release.promise;
                    return originalCompare(...args);
                });
                const request = kind === 'header'
                    ? api(server.baseUrl, '/storage/config?includeSecrets=true', {headers: {'x-password': OLD_PASSWORD}})
                    : fetch(`${server.baseUrl}/api/prometheus/metrics`, {headers: {authorization: `Basic ${Buffer.from(`prometheus:${OLD_PASSWORD}`).toString('base64')}`}});
                await entered.promise;
                try {
                    if (change === 'rotate') await setConfig(server.config, 'password', NEW_PASSWORD);
                    else if (change === 'remove') await server.config.clearPassword();
                    else if (change === 'replace same hash') await server.config.updateValue('password', hash);
                    else {
                        const model = (await import('../../server/models/Config.js')).default;
                        await model.update({value: await bcrypt.hash(NEW_PASSWORD, FAST_HASH_COST)}, {where: {key: 'password'}});
                    }
                } finally { release.resolve(); }
                assert.equal((await request).status, 401);
            });
        }
    }
});

describe('review path ids', () => {
    for (const [route, method, model, operation, invalid] of [
        ['/speedtests', 'GET', () => server.tests, 'findByPk', ['\0', '1\0']],
        ['/speedtests', 'DELETE', () => server.tests, 'destroy', ['\0', '1\0']],
        ['/integrations', 'PATCH', () => integrations, 'findOne', ['\0', 'legacy\0id']],
        ['/integrations', 'DELETE', () => integrations, 'findOne', ['\0', 'legacy\0id']]
    ]) {
        it(`${method} ${route} rejects malformed ids before the ORM`, async () => {
            const spy = mock.method(model(), operation);
            for (const id of invalid) {
                const result = await api(server.baseUrl, `${route}/${encodeURIComponent(id)}`, {
                    method, ...(method === 'PATCH' ? {headers: JSON_HEADERS, body: '{}'} : {})
                });
                assert.equal(result.status, 400, `${JSON.stringify(id)}: ${result.text}`);
            }
            assert.equal(spy.mock.callCount(), 0);
        });
    }
    it('zero remains a missing speedtest and leading zeroes still select its row', async () => {
        await seedTests(server.tests, [{}]);
        const row = await server.tests.findOne();
        assert.equal((await api(server.baseUrl, '/speedtests/0')).status, 404);
        assert.equal((await api(server.baseUrl, `/speedtests/000${row.id}`)).body.id, row.id);
    });
    it('preserves missing non-NUL speedtest ids as 404', async () => {
        for (const id of ['abc', '-1', '1.5', '[1]', '9007199254740992', "'quoted'"]) {
            const route = `/speedtests/${encodeURIComponent(id)}`;
            assert.equal((await api(server.baseUrl, route)).status, 404);
            assert.equal((await api(server.baseUrl, route, {method: 'DELETE'})).status, 404);
        }
    });
    it('preserves the numeric aliases the database already accepts', async () => {
        await seedTests(server.tests, [{}]);
        const row = await server.tests.findOne();
        for (const id of [`${row.id}.0`, `+${row.id}`, `${row.id}e0`, ` ${row.id} `]) {
            assert.equal((await server.tests.findByPk(id)).id, row.id, 'fixture alias must be accepted by the database');
            assert.equal((await api(server.baseUrl, `/speedtests/${encodeURIComponent(id)}`)).body.id, row.id);
        }
        assert.equal((await api(server.baseUrl, `/speedtests/${row.id}.0`, {method: 'DELETE'})).status, 200);
        assert.equal(await server.tests.count(), 0);
    });
    it('can patch and delete an integration using its issued UUID', async () => {
        const created = await api(server.baseUrl, '/integrations/webhook', {
            method: 'PUT', headers: JSON_HEADERS,
            body: JSON.stringify({integration_name: 'original', url: 'https://example.com/hook'})
        });
        assert.equal(created.status, 200);
        const id = created.body.id;
        assert.match(id, /^[a-f0-9-]+$/);
        const patched = await api(server.baseUrl, `/integrations/${id}`, {
            method: 'PATCH', headers: JSON_HEADERS, body: JSON.stringify({integration_name: 'renamed'})
        });
        assert.equal(patched.status, 200, patched.text);
        assert.equal((await integrations.findByPk(id)).displayName, 'renamed');
        assert.equal((await api(server.baseUrl, `/integrations/${id}`, {method: 'DELETE'})).status, 200);
        assert.equal(await integrations.findByPk(id), null);
    });
    it('preserves stored legacy and imported string integration ids', async () => {
        for (const id of ['a8w5j6pl9', '0.k8w5j6pl9', '00012', 'imported-id:old']) {
            await integrations.create({id, name: 'webhook', data: {url: 'https://example.com/hook'}});
            const route = `/integrations/${encodeURIComponent(id)}`;
            const patched = await api(server.baseUrl, route, {
                method: 'PATCH', headers: JSON_HEADERS, body: JSON.stringify({integration_name: 'renamed'})
            });
            assert.equal(patched.status, 200, `${id}: ${patched.text}`);
            assert.equal((await integrations.findByPk(id)).displayName, 'renamed');
            assert.equal((await api(server.baseUrl, route, {method: 'DELETE'})).status, 200);
            assert.equal(await integrations.findByPk(id), null);
        }
    });
    it('keeps ordinary missing integration string ids as 404', async () => {
        for (const id of ['missing', '-1', '1.5', '[1]', '9007199254740992']) {
            const route = `/integrations/${encodeURIComponent(id)}`;
            assert.equal((await api(server.baseUrl, route, {method: 'DELETE'})).status, 404);
            assert.equal((await api(server.baseUrl, route, {
                method: 'PATCH', headers: JSON_HEADERS, body: '{}'
            })).status, 404);
        }
    });
});

describe('review target types', () => {
    for (const fields of [{provider: ['ookla']}, {serverId: [1]}, {provider: 'libre', endpoint: ['https://example.com']}]) {
        it(`rejects create and patch coercion ${JSON.stringify(fields)}`, async () => {
            const row = await seedTarget({provider: 'ookla'});
            for (const [method, url, body] of [
                ['PUT', '/targets', {name: 'invalid', provider: 'ookla', ...fields}],
                ['PATCH', `/targets/${row.id}`, fields]
            ]) {
                assert.equal((await api(server.baseUrl, url, {method, headers: JSON_HEADERS, body: JSON.stringify(body)})).status, 400);
            }
        });
    }
    it('preserves numeric and string server ids and ordinary URL endpoints', async () => {
        for (const serverId of [123, '123'])
            assert.equal(targets.targetProblem({name: 'valid', provider: 'ookla', serverId}), null);
        assert.equal(targets.targetProblem({name: 'valid', provider: 'libre', endpoint: 'https://example.com'}), null);
        for (const fields of [{provider: {}}, {serverId: {}}, {provider: 'libre', endpoint: {}}])
            assert.notEqual(targets.targetProblem({name: 'invalid', provider: 'ookla', ...fields}), null);
    });
});

describe('review atomic history delete', () => {
    it('rolls back both tables if deleting the connection log fails', async () => {
        await seedTests(server.tests, [{}]);
        await changes.create({created: new Date().toISOString(), provider: 'ookla'});
        const failure = new Error('injected second delete failure');
        mock.method(changes, 'destroy', async () => { throw failure; });
        await assert.rejects(speedtests.deleteTests(), failure);
        assert.equal(await server.tests.count(), 1);
        assert.equal(await changes.count(), 1);
    });
    it('clears both tables on success', async () => {
        await seedTests(server.tests, [{}]);
        await changes.create({created: new Date().toISOString(), provider: 'ookla'});
        assert.equal(await speedtests.deleteTests(), true);
        assert.equal(await server.tests.count(), 0);
        assert.equal(await changes.count(), 0);
    });
});

describe('review token cap', () => {
    it('serializes concurrent count and create and releases the queue after failure', async () => {
        const originalCount = tokenModel.count.bind(tokenModel);
        mock.method(tokenModel, 'count', async () => {
            const snapshot = tokens.MAX_TOKENS - 1 + await originalCount();
            await new Promise(resolve => setTimeout(resolve, OVERLAPPING_COUNT_DELAY_MS));
            return snapshot;
        });
        const create = name => api(server.baseUrl, '/tokens', {method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({name})});
        const results = await Promise.all([create('first'), create('second')]);
        assert.deepEqual(results.map(result => result.status).sort(), [201, 400]);
        assert.equal(await originalCount(), 1);
        assert.ok(results.find(result => result.status === 201).body.token);
        await tokenModel.destroy({where: {}});
        const fail = mock.method(tokenModel, 'create', async () => { throw new Error('injected creation failure'); });
        assert.equal((await create('fails')).status, 500);
        fail.mock.restore();
        assert.equal((await create('retry')).status, 201);
    });
});

describe('review completion status', () => {
    it('exposes the global newest id while preserving the alerting health row', async () => {
        const watched = await seedTarget({provider: 'ookla', alerts: true});
        const quiet = await targets.create({name: 'quiet', provider: 'cloudflare', alerts: false});
        await seedTests(server.tests, [
            {targetId: watched.id, error: 'watched failure', externalIp: '203.0.113.1', isp: 'private provider'},
            {targetId: quiet.id, externalIp: '203.0.113.2', isp: 'private diagnostic provider'}
        ]);
        const rows = await server.tests.findAll({order: [['id', 'ASC']]});
        const {body} = await api(server.baseUrl, '/speedtests/status');
        assert.equal(body.lastTest.id, rows[0].id);
        assert.equal(body.lastTest.failed, true);
        assert.equal(body.latestTestId, rows[1].id);
        await setConfig(server.config, 'password', OLD_PASSWORD);
        await setConfig(server.config, 'passwordLevel', 'read');
        const viewer = (await api(server.baseUrl, '/speedtests/status')).body;
        assert.equal(viewer.latestTestId, rows[1].id);
        assert.equal(viewer.lastTest.id, rows[0].id);
        assert.equal(viewer.lastTest.externalIp, null);
        assert.equal(viewer.lastTest.isp, null);
        await seedTests(server.tests, []);
        assert.equal((await api(server.baseUrl, '/speedtests/status')).body.latestTestId, null);
    });
});
