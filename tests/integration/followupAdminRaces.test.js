import {before, after, beforeEach, afterEach, describe, it, mock} from 'node:test';
import assert from 'node:assert/strict';
import bcrypt from 'bcryptjs';
import {bootServer, api, setConfig, seedTarget} from './helpers/boot.js';

const PASSWORD = 'CurrentPassword1!';
const JSON_HEADERS = {'content-type': 'application/json'};
const OVERLAP_MS = 100;
const TEST_TIMEOUT_MS = 60000;
const pause = () => new Promise(resolve => setTimeout(resolve, OVERLAP_MS));
const deferred = () => {
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    return {promise, resolve};
};
let server, configModel, targetsModel, tokenModel, tokens, session, setup, policy, timer;
before(async () => {
    server = await bootServer();
    configModel = (await import('../../server/models/Config.js')).default;
    targetsModel = (await import('../../server/models/Targets.js')).default;
    tokenModel = (await import('../../server/models/ApiTokens.js')).default;
    tokens = await import('../../server/controller/tokens.js');
    session = await import('../../server/util/session.js');
    setup = await import('../../server/util/setupToken.js');
    policy = await import('../../server/util/authPolicy.js');
    timer = await import('../../server/tasks/timer.js');
});
after(async () => { timer?.stopTimer(); await server?.close(); });
beforeEach(async () => {
    await server.config.clearPassword();
    await setConfig(server.config, 'passwordLevel', 'none');
    await targetsModel.destroy({where: {}});
    await tokenModel.destroy({where: {}});
});
afterEach(() => { timer?.stopTimer(); mock.restoreAll(); });
const request = (route, method, body) => api(server.baseUrl, route, {
    method, headers: JSON_HEADERS, body: JSON.stringify(body)
});

// Hold the value *after* the real database has read it, preserving the stale
// snapshot that made these requests pass even after a committed policy change.
const holdRead = (model, method, matches) => {
    const entered = deferred(), release = deferred();
    const original = model[method].bind(model);
    let held = false;
    mock.method(model, method, async (...args) => {
        const result = await original(...args);
        if (!held && matches(...args)) {
            held = true;
            entered.resolve();
            await release.promise;
        }
        return result;
    });
    return {entered: entered.promise, release: release.resolve};
};

describe('current authorization snapshots', {timeout: TEST_TIMEOUT_MS}, () => {
    it('refuses a held setup-token mutation once the first password is committed', async () => {
        const gate = holdRead(configModel, 'findByPk', key => key === 'passwordLevel');
        const pending = api(server.baseUrl, '/tokens', {method: 'POST',
            headers: {...JSON_HEADERS, host: 'public.example', 'x-password': setup.getSetupToken()},
            body: JSON.stringify({name: 'stale setup'})});
        await gate.entered;
        try { await setConfig(server.config, 'password', PASSWORD); }
        finally { gate.release(); }
        assert.equal((await pending).status, 401);
        assert.equal(await tokenModel.count(), 0);
        assert.equal((await api(server.baseUrl, '/tokens', {headers: {'x-password': PASSWORD}})).status, 200);
    });

    it('refuses a held passwordless metrics request after a password is installed', async () => {
        const gate = holdRead(configModel, 'findByPk', key => key === 'password');
        const pending = api(server.baseUrl, '/prometheus/metrics');
        await gate.entered;
        try { await setConfig(server.config, 'password', PASSWORD); }
        finally { gate.release(); }
        assert.equal((await pending).status, 401);
        assert.equal((await api(server.baseUrl, '/prometheus/metrics', {headers: {
            authorization: `Basic ${Buffer.from(`prometheus:${PASSWORD}`).toString('base64')}`
        }})).status, 200);
    });

    for (const change of ['write', 'import', 'failed write', 'failed import']) {
        it(`read fallback sees ${change} while bcrypt is pending without revoking valid sessions`, async () => {
            await setConfig(server.config, 'password', PASSWORD);
            await setConfig(server.config, 'passwordLevel', 'read');
            const cookie = session.createSession();
            const revision = policy.authPolicyRevision();
            const original = bcrypt.compare;
            const entered = deferred(), release = deferred();
            mock.method(bcrypt, 'compare', async (...args) => {
                entered.resolve();
                await release.promise;
                return original(...args);
            });
            const pending = api(server.baseUrl, '/targets', {headers: {'x-password': 'wrong'}});
            await entered.promise;
            try {
                const fail = () => { throw new Error('injected policy failure'); };
                if (change.includes('import')) {
                    const backup = await server.config.exportConfig();
                    backup.config.passwordLevel = 'none';
                    if (change.startsWith('failed')) mock.method(targetsModel, 'bulkCreate', fail);
                    // Ensure the transaction reaches the injected target insert.
                    backup.targets = [{name: 'restored', provider: 'ookla'}];
                    assert.equal((await server.config.importConfig(backup)).ok, !change.startsWith('failed'));
                } else if (change.startsWith('failed')) {
                    mock.method(configModel, 'update', fail);
                    await assert.rejects(setConfig(server.config, 'passwordLevel', 'none'), /injected/);
                } else await setConfig(server.config, 'passwordLevel', 'none');
            } finally { release.resolve(); }
            assert.equal((await pending).status, change.startsWith('failed') ? 200 : 401);
            assert.equal(policy.authPolicyRevision() === revision, change.startsWith('failed'));
            assert.equal(session.isValidSession(cookie), true);
            assert.equal((await api(server.baseUrl, '/tokens', {headers: {cookie: `${session.SESSION_COOKIE}=${cookie}`}})).status, 200);
        });
    }
});

describe('administrative entity mutation ownership', {timeout: TEST_TIMEOUT_MS}, () => {
    for (const operation of ['import', 'reset']) for (const fails of [false, true]) {
        it(`queues token revocation behind a ${fails ? 'failed' : 'successful'} ${operation}`, async () => {
            const originalToken = await tokens.create('revoke me');
            const backup = await server.config.exportConfig({includeSecrets: true});
            const entered = deferred(), release = deferred();
            const originalDestroy = tokenModel.destroy.bind(tokenModel);
            let independentDeletes = 0;
            mock.method(tokenModel, 'destroy', async options => {
                if (!options.transaction) {
                    independentDeletes++;
                    return originalDestroy(options);
                }
                const result = await originalDestroy(options);
                entered.resolve();
                await release.promise;
                if (fails) throw new Error('injected replacement failure');
                return result;
            });
            const replacement = operation === 'import' ? server.config.importConfig(backup) : server.config.factoryReset();
            const outcome = operation === 'reset' && fails
                ? assert.rejects(replacement, /injected replacement failure/) : replacement;
            await entered.promise;
            const deletion = request(`/tokens/${originalToken.id}`, 'DELETE');
            let deletesBeforeRelease;
            try {
                await pause();
                deletesBeforeRelease = independentDeletes;
            } finally { release.resolve(); }
            const result = await outcome;
            const deleted = await deletion;
            assert.equal(deletesBeforeRelease, 0, 'revocation must wait instead of blocking SQLite inside another transaction');
            if (operation === 'import') assert.equal(result.ok, !fails);
            assert.equal(deleted.status, fails ? 200 : 404);
            const remaining = await tokens.list();
            assert.equal(remaining.length, operation === 'import' && !fails ? 1 : 0);
            if (remaining.length) {
                assert.notEqual(remaining[0].id, originalToken.id, 'restored token identity is independently assigned');
                assert.equal(remaining[0].name, 'revoke me');
            }
            assert.equal((await request('/tokens', 'POST', {name: 'queue recovered'})).status, 201);
        });
    }

    for (const other of ['create', 'rename']) {
        it(`serializes same-name create against ${other}`, async () => {
            const existing = other === 'rename' ? await seedTarget({name: 'original'}) : null;
            const gate = holdRead(targetsModel, 'findAll', () => true);
            const first = request('/targets', 'PUT', {name: 'shared', provider: 'ookla'});
            await gate.entered;
            const second = existing
                ? request(`/targets/${existing.id}`, 'PATCH', {name: 'shared'})
                : request('/targets', 'PUT', {name: 'shared', provider: 'ookla'});
            await pause();
            gate.release();
            const results = await Promise.all([first, second]);
            assert.deepEqual(results.map(result => result.status).sort(), [200, 400]);
            assert.equal(await targetsModel.count({where: {name: 'shared'}}), 1);
        });
    }

    it('serializes count-create with actual replacement, retaining replacement semantics', async () => {
        const backup = await server.config.exportConfig();
        backup.tokens = Array.from({length: tokens.MAX_TOKENS}, (_, index) => ({
            name: `restored ${index}`, digest: tokens.digestOf(`secret ${index}`), scope: tokens.SCOPE_RUN
        }));
        const gate = holdRead(tokenModel, 'count', () => true);
        const pending = request('/tokens', 'POST', {name: 'before restore'});
        await gate.entered;
        const restore = server.config.importConfig(backup);
        await Promise.race([restore, pause()]);
        gate.release();
        assert.equal((await pending).status, 201);
        assert.equal((await restore).ok, true);
        assert.equal(await tokenModel.count(), tokens.MAX_TOKENS);
        assert.equal(await tokenModel.count({where: {name: 'before restore'}}), 0);
        assert.equal((await request('/tokens', 'POST', {name: 'after restore'})).status, 400);
    });

    it('reads target state after a replacement completes before attempting rename', async () => {
        const row = await seedTarget({name: 'original'});
        const backup = await server.config.exportConfig();
        backup.targets = [{id: row.id, name: 'restored', provider: 'ookla'}];
        const gate = holdRead(targetsModel, 'destroy', options => !!options?.transaction);
        const restore = server.config.importConfig(backup);
        await gate.entered;
        const pending = request(`/targets/${row.id}`, 'PATCH', {name: 'renamed'});
        await pause();
        gate.release();
        assert.equal((await restore).ok, true);
        assert.equal((await pending).status, 200);
        assert.equal((await targetsModel.findByPk(row.id)).name, 'renamed');
    });

    it('rolls back a failed restore and releases ownership for subsequent creates', async () => {
        await tokens.create('preserved');
        const backup = await server.config.exportConfig({includeSecrets: true});
        backup.tokens[0].name = 'replacement';
        const failure = mock.method(tokenModel, 'bulkCreate', async () => { throw new Error('injected token replacement'); });
        assert.equal((await server.config.importConfig(backup)).ok, false);
        failure.mock.restore();
        assert.equal((await tokens.list())[0].name, 'preserved');
        assert.equal((await request('/tokens', 'POST', {name: 'retry'})).status, 201);
        assert.equal((await request('/targets', 'PUT', {name: 'retry', provider: 'ookla'})).status, 200);
    });

    it('does not count tokens until an earlier import has committed', async () => {
        const backup = await server.config.exportConfig();
        backup.tokens = Array.from({length: tokens.MAX_TOKENS}, (_, index) => ({
            name: `restored ${index}`, digest: tokens.digestOf(`inverse ${index}`), scope: tokens.SCOPE_RUN
        }));
        const gate = holdRead(tokenModel, 'bulkCreate', () => true);
        const restore = server.config.importConfig(backup);
        await gate.entered;
        const count = mock.method(tokenModel, 'count');
        const pending = request('/tokens', 'POST', {name: 'after restore'});
        try {
            await pause();
            assert.equal(count.mock.callCount(), 0);
        } finally { gate.release(); }
        assert.equal((await restore).ok, true);
        assert.equal((await pending).status, 400);
        assert.equal(await tokenModel.count(), tokens.MAX_TOKENS);
    });

    for (const fails of [false, true]) {
        it(`queues creations behind a ${fails ? 'failed' : 'successful'} reset and preserves rollback state`, async () => {
            await tokens.create('original');
            const row = await seedTarget({name: 'original'});
            const cookie = session.createSession();
            const revision = policy.authPolicyRevision();
            const entered = deferred(), release = deferred();
            const originalDestroy = tokenModel.destroy.bind(tokenModel);
            mock.method(tokenModel, 'destroy', async options => {
                if (options.transaction) {
                    entered.resolve();
                    await release.promise;
                    if (fails) throw new Error('injected reset failure');
                }
                return originalDestroy(options);
            });
            const reset = server.config.factoryReset();
            // Attach the rejection handler before releasing the injected error.
            const outcome = fails ? assert.rejects(reset, /injected reset failure/) : reset;
            await entered.promise;
            const count = mock.method(tokenModel, 'count');
            const newToken = request('/tokens', 'POST', {name: 'after reset'});
            const rename = request(`/targets/${row.id}`, 'PATCH', {name: 'after reset'});
            try {
                await pause();
                assert.equal(count.mock.callCount(), 0);
            } finally { release.resolve(); }
            await outcome;
            assert.equal((await newToken).status, 201);
            assert.equal((await rename).status, fails ? 200 : 404);
            assert.equal(await tokenModel.count(), fails ? 2 : 1);
            assert.equal(session.isValidSession(cookie), fails);
            assert.equal(policy.authPolicyRevision() === revision, fails);
        });
    }

    it('rejects one concurrent rename but allows unrelated and unchanged names', async () => {
        const first = await seedTarget({name: 'first'});
        const second = await targetsModel.create({name: 'second', provider: 'ookla', sortOrder: 1});
        const gate = holdRead(targetsModel, 'findAll', () => true);
        const firstRename = request(`/targets/${first.id}`, 'PATCH', {name: 'shared'});
        await gate.entered;
        const secondRename = request(`/targets/${second.id}`, 'PATCH', {name: 'shared'});
        await pause();
        gate.release();
        assert.deepEqual((await Promise.all([firstRename, secondRename])).map(value => value.status).sort(), [200, 400]);
        assert.equal((await request(`/targets/${first.id}`, 'PATCH', {name: 'shared'})).status, 200);
        const created = await Promise.all(['third', 'fourth'].map(name => request('/targets', 'PUT', {name, provider: 'ookla'})));
        assert.deepEqual(created.map(value => value.status), [200, 200]);
        const failure = mock.method(targetsModel, 'create', async () => { throw new Error('injected target create'); });
        assert.equal((await request('/targets', 'PUT', {name: 'retry target', provider: 'ookla'})).status, 500);
        failure.mock.restore();
        assert.equal((await request('/targets', 'PUT', {name: 'retry target', provider: 'ookla'})).status, 200);
    });
});

describe('running speedtest conflict messages', () => {
    for (const conflict of ['already reserved', 'reserved during target lookup']) {
        it(`uses the correct article when ${conflict}`, async () => {
            await seedTarget();
            const task = await import('../../server/tasks/speedtest.js');
            let gate;
            if (conflict === 'already reserved') assert.equal(task.tryReserve(), true);
            else gate = holdRead(targetsModel, 'findAll', () => true);
            const pending = request('/speedtests/run', 'POST', {});
            if (gate) {
                await gate.entered;
                assert.equal(task.tryReserve(), true);
                gate.release();
            }
            try {
                const result = await pending;
                assert.equal(result.status, 409);
                assert.equal(result.body.message, 'A speedtest is already running');
            } finally { task.cancelReservation(); }
        });
    }
});
