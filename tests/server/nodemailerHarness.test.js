import {it} from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import {spawnSync} from 'node:child_process';
import {withInterfaceSnapshot, bootstrapNodemailer, setInterfaces, fixtureInterfaces, shared, nodemailer}
    from '../fixtures/outbound-transport/smtp/nodemailerHarness.js';

const CHILD_TIMEOUT_MS = 10_000;

it('restores the OS reader after successful and failed package initialization', async () => {
    const original = os.networkInterfaces;
    const snapshot = {};
    assert.equal(await withInterfaceSnapshot(snapshot, async () => os.networkInterfaces()), snapshot);
    assert.equal(os.networkInterfaces, original);
    const failure = new Error('synthetic import failure');
    await assert.rejects(withInterfaceSnapshot(snapshot, async () => { throw failure; }), error => error === failure);
    assert.equal(os.networkInterfaces, original);
});

it('initializes the ESM mailer once and changes only the fixture-owned table', async () => {
    const original = os.networkInterfaces;
    await bootstrapNodemailer();
    assert.equal(os.networkInterfaces, original);
    assert.equal(shared.networkInterfaces, fixtureInterfaces);
    assert.equal(typeof nodemailer.createTransport, 'function');
    const namespace = shared;
    await bootstrapNodemailer();
    assert.equal(shared, namespace);
    const previous = setInterfaces({lo: [{family: 'IPv4', internal: true}]});
    try {
        await bootstrapNodemailer();
        assert.deepEqual(shared.networkInterfaces, {lo: [{family: 'IPv4', internal: true}]});
        setInterfaces({});
        assert.deepEqual(shared.networkInterfaces, {});
    } finally {
        setInterfaces(previous);
    }
    assert.deepEqual(shared.networkInterfaces, previous);
});

it('rejects a real early Nodemailer import and restores the OS reader in a fresh process', () => {
    const harnessUrl = new URL('../fixtures/outbound-transport/smtp/nodemailerHarness.js', import.meta.url).href;
    const source = `
        import assert from 'node:assert/strict';
        import os from 'node:os';
        const original = os.networkInterfaces;
        await import('nodemailer');
        const harness = await import(${JSON.stringify(harnessUrl)});
        await assert.rejects(harness.bootstrapNodemailer(),
            /bootstrap must run before importing Nodemailer or SMTP scenarios/);
        assert.equal(os.networkInterfaces, original);
        assert.equal(harness.shared, undefined);
        assert.equal(harness.nodemailer, undefined);
    `;
    const child = spawnSync(process.execPath, ['--input-type=module', '--eval', source], {
        cwd: new URL('../../', import.meta.url),
        encoding: 'utf8',
        timeout: CHILD_TIMEOUT_MS,
        windowsHide: true
    });
    assert.equal(child.error, undefined);
    assert.equal(child.status, 0, child.stderr || child.stdout);
});

it('shares concurrent initialization without leaving the OS reader stubbed', () => {
    const harnessUrl = new URL('../fixtures/outbound-transport/smtp/nodemailerHarness.js', import.meta.url).href;
    const source = `
        import assert from 'node:assert/strict';
        import os from 'node:os';
        const original = os.networkInterfaces;
        const harness = await import(${JSON.stringify(harnessUrl)});
        await Promise.all([harness.bootstrapNodemailer(), harness.bootstrapNodemailer()]);
        assert.equal(os.networkInterfaces, original);
        assert.equal(harness.shared.networkInterfaces, harness.fixtureInterfaces);
        assert.equal(typeof harness.nodemailer.createTransport, 'function');
    `;
    const child = spawnSync(process.execPath, ['--input-type=module', '--eval', source], {
        cwd: new URL('../../', import.meta.url),
        encoding: 'utf8',
        timeout: CHILD_TIMEOUT_MS,
        windowsHide: true
    });
    assert.equal(child.error, undefined);
    assert.equal(child.status, 0, child.stderr || child.stdout);
});
