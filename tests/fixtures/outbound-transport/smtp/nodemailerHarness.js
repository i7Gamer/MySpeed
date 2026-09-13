import assert from 'node:assert/strict';
import os from 'node:os';

// Nodemailer captures this object while its ESM graph loads. Scenarios mutate
// the owned table, never its read-only exports or the production OS reader.
export const fixtureInterfaces = {};
export let shared;
export let nodemailer;
let initializing;

export function setInterfaces(interfaces) {
    const previous = {...fixtureInterfaces};
    for (const key of Object.keys(fixtureInterfaces)) delete fixtureInterfaces[key];
    Object.assign(fixtureInterfaces, interfaces);
    return previous;
}

export async function withInterfaceSnapshot(snapshot, load) {
    const original = os.networkInterfaces;
    os.networkInterfaces = () => snapshot;
    try { return await load(); }
    finally { os.networkInterfaces = original; }
}

// Entrypoints await this sequential bootstrap before importing SMTP scenarios
// (and their production modules), including in the compiled transport fixture.
export async function bootstrapNodemailer() {
    if (shared) return;
    if (initializing) return initializing;
    initializing = withInterfaceSnapshot(fixtureInterfaces, async () => {
        const namespace = await import('nodemailer/lib/shared');
        assert.equal(namespace.networkInterfaces, fixtureInterfaces,
            'bootstrap must run before importing Nodemailer or SMTP scenarios');
        const mailer = await import('nodemailer');
        return {namespace, mailer};
    }).then(loaded => {
        shared = loaded.namespace;
        nodemailer = loaded.mailer.default;
        setInterfaces({fixture: [{family: 'IPv4', internal: false}, {family: 'IPv6', internal: false}]});
    }).finally(() => { initializing = undefined; });
    return initializing;
}
