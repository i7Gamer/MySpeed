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
    // The fixture relay speaks no TLS, which is refused by default.
    process.env.SMTP_ALLOW_PLAINTEXT = "true";
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
        delete process.env.SMTP_ALLOW_PLAINTEXT;
        await fixture.close();
    }
});

/**
 * The downgrade, end to end. A relay whose greeting carries no STARTTLS line is
 * exactly what an attacker in the path makes of one that offered it, so the
 * plain fixture stands in for the stripped greeting without anything having to
 * rewrite bytes on the wire.
 */
it("a greeting without STARTTLS ends the session before the login or the message", async () => {
    const fixture = await smtpFixture();
    const events = {}, notes = [], errors = [];
    const originalError = console.error;
    const config = {host: LOOPBACK, port: fixture.port, username: "synthetic", password: "synthetic",
        from: "sender@fixture.invalid", to: "recipient@fixture.invalid", send_finished: true,
        finished_subject: "synthetic", finished_message: "synthetic"};

    setupEmail((name, callback) => { events[name] = callback; });
    console.error = (...values) => errors.push(values.join(" "));
    delete process.env.SMTP_ALLOW_PLAINTEXT;
    try {
        await events.testFinished({data: config}, {}, failed => notes.push(failed));

        assert.deepEqual(notes, [true]);
        assert.equal(fixture.seen.auth, 0, "the credentials were sent over an unencrypted session");
        assert.equal(fixture.seen.messages.length, 0);

        // And the same relay is reachable once the operator says it may be.
        process.env.SMTP_ALLOW_PLAINTEXT = "true";
        await events.testFinished({data: config}, {}, failed => notes.push(failed));

        assert.deepEqual(notes, [true, false]);
        assert.equal(fixture.seen.auth, 1);
        assert.equal(fixture.seen.messages.length, 1);
    } finally {
        console.error = originalError;
        delete process.env.SMTP_ALLOW_PLAINTEXT;
        await fixture.close();
    }
});
