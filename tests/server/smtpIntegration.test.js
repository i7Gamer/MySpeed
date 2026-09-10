import {it} from "node:test";
import assert from "node:assert/strict";
import dns from "node:dns";
import net from "node:net";
import setupEmail from "../../server/integrations/email.js";
import {smtpFixture} from "../fixtures/outbound-transport/smtp/fixture.js";

const LOOPBACK = "127.0.0.1";

// Notification templates pull generated client assets into a Bun bundle. Keep
// this full integration test in Node; the compiled native suite imports the
// same production transport-options leaf and tests its connected-socket hook.
it("the default email integration reports guarded DNS failure and recovery", async () => {
    const fixture = await smtpFixture({auth: false});
    const events = {}, notes = [], errors = [];
    const original = {Resolver: dns.Resolver, lookup: dns.lookup, connect: net.connect, error: console.error};
    let answers = [{address: "169.254.169.254", family: 4}];
    const config = {host: "smtp-activity-fixture.invalid", port: fixture.port,
        from: "sender@fixture.invalid", to: "recipient@fixture.invalid", send_finished: true,
        finished_subject: "synthetic", finished_message: "synthetic"};
    dns.Resolver = class {
        resolve4(_host, callback) { setImmediate(() => callback(null, answers.map(answer => answer.address))); }
        resolve6(_host, callback) { setImmediate(() => callback(null, [])); }
    };
    dns.lookup = (host, options, callback) => net.isIP(host) ? original.lookup(host, options, callback)
        : setImmediate(() => callback(null, answers));
    // Refuse hostnames too: a broken guard must not trigger a second lookup
    // that returns the synthetic metadata answer to a native socket.
    net.connect = (options, ...args) => {
        assert.equal(options.host, LOOPBACK, "fixture only permits numeric IPv4 loopback dialing");
        return original.connect(options, ...args);
    };
    setupEmail((name, callback) => { events[name] = callback; });
    console.error = (...values) => errors.push(values.join(" "));
    try {
        await events.testFinished({data: config}, {}, failed => notes.push(failed));
        assert.deepEqual(notes, [true]);
        assert.ok(errors.some(value => value.includes("no permitted numeric address")));
        answers = [...answers, {address: LOOPBACK, family: 4}];
        await events.testFinished({data: config}, {}, failed => notes.push(failed));
        assert.deepEqual(notes, [true, false]);
        assert.equal(fixture.seen.messages.length, 1);
    } finally {
        dns.Resolver = original.Resolver;
        dns.lookup = original.lookup;
        net.connect = original.connect;
        console.error = original.error;
        await fixture.close();
    }
});
