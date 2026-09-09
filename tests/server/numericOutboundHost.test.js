import {describe, it, afterEach, mock} from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import {checkOutboundHost} from '../../server/util/safeUrl.js';
import setupEmail from '../../server/integrations/email.js';
import setupMqtt from '../../server/integrations/mqtt.js';

const BLOCKED = ['2852039166', '169.254.43518', '0xa9fea9fe', '0251.0376.0251.0376',
    '169.254.1', '0XA9FE0001', '2851995649.', '0:0:0:0:0:ffff:a9fe:a9fe', '[fd00:ec2::254]'];
const ALLOWED = ['2130706433', '127.1', '0x7f000001', '0177.0.0.1', '3232235777',
    '0xc0a80101', '0300.0250.1.1', '134744072', '8.8.8', 'smtp.example.com', '123.example',
    'fd00::1', '[::1]', '1.2.3.999', '0xinvalid', '999999999999999999999'];
afterEach(() => mock.restoreAll());

describe('numeric bare outbound hosts use the URL address policy', () => {
    for (const host of BLOCKED) it(`refuses ${host}`, () => {
        assert.equal(checkOutboundHost(host).safe, false);
    });
    for (const host of ALLOWED) it(`preserves ${host}`, () => {
        assert.equal(checkOutboundHost(host).safe, true);
    });
    for (const channel of ['email', 'mqtt']) {
        it(`${channel} refuses numeric link-local hosts before constructing a connection`, async () => {
            const events = {};
            const dial = mock.fn(() => { throw new Error('must not dial'); });
            if (channel === 'email') setupEmail((name, fn) => { events[name] = fn; }, dial);
            else {
                setupMqtt((name, fn) => { events[name] = fn; });
                mock.method(net, 'connect', dial);
            }
            mock.method(console, 'error', () => undefined);
            for (const host of BLOCKED) {
                const notes = [];
                await events.testFinished({data: {host, port: 1234, topic: 'result',
                    from: 'myspeed@example.com', to: 'ops@example.com', send_finished: true}},
                {download: 100, upload: 50, ping: 10}, failed => notes.push(failed));
                assert.deepEqual(notes, [true]);
            }
            assert.equal(dial.mock.callCount(), 0);
        });
    }
});
