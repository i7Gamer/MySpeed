import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import setupEmail, { SUBJECT_LIMIT } from "../../server/integrations/email.js";

/**
 * Email, which is upstream #1259: "In Settings Notifications there is not a
 * SMTP setup."
 *
 * The one channel missing from eight integrations, and the only one that is not
 * an HTTP POST - so none of util/http.js applies to it, including the address
 * guard 1.3.4 put in front of every other outbound send and the activity note
 * that turns a failure into "this endpoint is not working" on the card. Both
 * have to be rebuilt here rather than inherited, which is what most of this
 * file is about.
 *
 * Nothing here opens a socket: the module takes its transport factory as a
 * second argument, defaulted to nodemailer's, and the tests hand in a recorder.
 */
let created = [];
let sentMail = [];
let notes = [];
let failNextSend = null;

const recordingFactory = (options) => {
    created.push(options);

    return {
        sendMail: async (message) => {
            if (failNextSend) throw failNextSend;

            sentMail.push(message);
            return {accepted: [message.to]};
        }
    };
};

beforeEach(() => {
    created = [];
    sentMail = [];
    notes = [];
    failNextSend = null;
});

const load = () => {
    const events = {};
    const definition = setupEmail((name, callback) => { events[name] = callback; }, recordingFactory);

    return {events, definition};
};

const CONFIG = {
    host: "smtp.example.com", port: 587, from: "myspeed@example.com", to: "ops@example.com",
    send_finished: true, send_failed: true
};

const RESULT = {ping: 12, jitter: 2, download: 100, upload: 50};
const FAILURE = {error: "Too many requests. Please try again later", provider: "ookla"};

const fire = (events, name, config, payload) =>
    events[name]({data: config}, payload, (failed) => { notes.push(failed); });

const finish = async (overrides = {}) => {
    const {events} = load();
    await fire(events, "testFinished", {...CONFIG, ...overrides}, RESULT);

    return sentMail[0];
};

describe("the transport", () => {
    it("is built from the configured server", async () => {
        await finish();

        assert.equal(created[0].host, "smtp.example.com");
        assert.equal(created[0].port, 587);
    });

    /**
     * Implicit TLS on 465 against STARTTLS on 587. nodemailer reads `secure` as
     * "wrap the socket in TLS immediately"; false does not mean plaintext - it
     * upgrades through STARTTLS when the server offers it.
     */
    it("uses implicit TLS only when the operator asked for it", async () => {
        await finish({secure: true});
        assert.equal(created[0].secure, true);

        created = [];
        await finish({secure: false});
        assert.equal(created[0].secure, false);
    });

    // A relay on the operator's own LAN that needs no credentials is ordinary,
    // and nodemailer refuses an `auth` object with an empty user.
    it("carries credentials only when a username is set", async () => {
        await finish();
        assert.equal(created[0].auth, undefined, "an anonymous relay was sent an empty login");

        created = [];
        await finish({username: "postmaster", password: "hunter2"});
        assert.deepEqual(created[0].auth, {user: "postmaster", pass: "hunter2"});
    });

    /**
     * The same deadline every other integration's send carries. Without them
     * nodemailer waits on its own defaults, and a relay that accepts a
     * connection and then says nothing would hold the notification - and the
     * event loop's handle on it - far longer than the run that triggered it.
     */
    it("is bounded by the outbound timeout on every stage", async () => {
        await finish();

        for (const key of ["connectionTimeout", "greetingTimeout", "socketTimeout"])
            assert.equal(typeof created[0][key], "number", `${key} is left to nodemailer's default`);
    });

    /**
     * nodemailer refuses private and loopback addresses by default, which is the
     * opposite of this project's policy: checkOutboundTarget allows both on
     * purpose, because "an integration on the same host or the same LAN is
     * ordinary" - and a mail relay is the most ordinary of them.
     */
    it("does not refuse the LAN relay most people actually have", async () => {
        await finish();

        assert.equal(created[0].allowInternalNetworkInterfaces, true,
            "an SMTP server on the operator's own network cannot be reached");
    });
});

describe("the message", () => {
    it("goes from and to the configured addresses", async () => {
        const mail = await finish();

        assert.match(mail.from, /myspeed@example\.com/);
        assert.equal(mail.to, "ops@example.com");
    });

    // The address is what the operator configured; the name in front of it is
    // ours, so a mailbox shows what sent it without a field asking for it.
    it("names the sender in front of the address", async () => {
        const mail = await finish();

        assert.match(mail.from, /^MySpeed </);
    });

    it("carries a default subject when none is configured", async () => {
        const mail = await finish();

        assert.ok(mail.subject.length > 0);
        assert.ok(!mail.subject.includes("%"), "an unreplaced variable reached the subject line");
    });

    it("replaces the variables in a custom subject and body", async () => {
        const mail = await finish({
            finished_subject: "Down %download% Mbps",
            finished_message: "Ping %ping% ms"
        });

        assert.equal(mail.subject, "Down 100 Mbps");
        assert.equal(mail.text, "Ping 12 ms");
    });

    it("says what failed on a failed test", async () => {
        const {events} = load();
        await fire(events, "testFailed", CONFIG, FAILURE);

        assert.match(sentMail[0].text, /Too many requests/);
        assert.notEqual(sentMail[0].subject, undefined);
    });

    /**
     * A header is not a body. The failure template can interpolate `%error%`,
     * which carries up to MAX_ERROR_LENGTH of raw CLI output, and a subject that
     * long is refused outright by some servers and folded into nonsense by
     * others - losing the alert rather than shortening it.
     */
    it("cuts a subject that would be too long for a header", async () => {
        const mail = await finish({finished_subject: "x".repeat(SUBJECT_LIMIT * 2)});

        assert.ok(mail.subject.length <= SUBJECT_LIMIT,
            `the subject went out at ${mail.subject.length} characters`);
    });

    // Newlines terminate a header. One reaching the subject would end it early
    // and let whatever follows be read as a header of its own.
    it("keeps a newline out of the subject", async () => {
        const mail = await finish({finished_subject: "one\r\nBcc: someone@example.com"});

        assert.ok(!/[\r\n]/.test(mail.subject), "a subject can inject a header");
    });

    it("sends nothing when the operator asked for neither kind", async () => {
        const {events} = load();
        await fire(events, "testFinished", {...CONFIG, send_finished: false}, RESULT);
        await fire(events, "testFailed", {...CONFIG, send_failed: false}, FAILURE);

        assert.equal(sentMail.length, 0);
    });
});

/**
 * The guard every other integration inherits from util/http.js, rebuilt here
 * because nothing about an SMTP connection goes through it.
 */
describe("a relay it may not reach", () => {
    const refused = async (host) => {
        created = [];
        await finish({host});

        return {connected: created.length > 0, sent: sentMail.length};
    };

    it("is not connected to at a link-local address", async () => {
        const outcome = await refused("169.254.169.254");

        assert.equal(outcome.connected, false, "the cloud metadata address was dialled");
    });

    it("is not connected to at the metadata address in the other family", async () => {
        assert.equal((await refused("fd00:ec2::254")).connected, false);
    });

    // Reported as a send failure rather than thrown, the way refuseBlocked does
    // it: a destination that cannot be reached is exactly "this endpoint is not
    // working" on the integration card.
    it("is marked as a failed send", async () => {
        await finish({host: "169.254.169.254"});

        assert.deepEqual(notes, [true]);
    });

    // Loopback and the LAN are allowed on purpose - checkOutboundTarget says why.
    it("is connected to on loopback and on the LAN", async () => {
        assert.equal((await refused("127.0.0.1")).connected, true);
        assert.equal((await refused("192.168.1.25")).connected, true);
    });
});

describe("the outcome", () => {
    it("is noted against the integration when the mail goes", async () => {
        await finish();

        assert.deepEqual(notes, [false]);
    });

    it("is noted as a failure when the relay refuses", async () => {
        failNextSend = new Error("535 authentication failed");
        await finish();

        assert.deepEqual(notes, [true]);
    });

    /**
     * And does not escape. triggerEvent works through the integrations one at a
     * time; a throw here would take the ones after it down with this one.
     */
    it("does not throw out of the module when the relay refuses", async () => {
        failNextSend = new Error("535 authentication failed");

        await assert.doesNotReject(() => finish());
    });
});

/**
 * More than one person wanting to know, which is the ordinary case for an alert:
 * an operator and whoever is on call. A field that takes one address means
 * either a second integration configured identically or a distribution list
 * somebody has to maintain elsewhere.
 */
describe("several recipients", () => {
    it("are all carried on the message", async () => {
        const mail = await finish({to: "ops@example.com, oncall@example.com"});

        assert.equal(mail.to, "ops@example.com, oncall@example.com");
    });

    /**
     * Normalised before it goes out. The stored value is whatever was typed, and
     * a list pasted from a mail client arrives with uneven spacing - which the
     * pattern tolerates on the way in, so something has to tidy it on the way
     * out rather than handing a relay `a@b.co ,   c@d.co`.
     */
    it("are tidied into one separated list", async () => {
        const mail = await finish({to: "ops@example.com ,   oncall@example.com"});

        assert.equal(mail.to, "ops@example.com, oncall@example.com");
    });

    it("still work when there is only one", async () => {
        const mail = await finish({to: "ops@example.com"});

        assert.equal(mail.to, "ops@example.com");
    });
});

describe("the declared fields", () => {
    const fields = () => load().definition.fields;
    const named = (name) => fields().find((field) => field.name === name);

    it("opts in to the shared threshold settings", () => {
        assert.equal(load().definition.notifier, true);
    });

    it("requires what a connection cannot be made without", () => {
        for (const name of ["host", "port", "from", "to"])
            assert.equal(named(name)?.required, true, `${name} is not required`);
    });

    // A relay that needs no login is ordinary, so neither half of the credential
    // is required - but the password is a credential and is redacted like one.
    it("does not require credentials, and redacts the password", () => {
        assert.equal(named("username").required, false);
        assert.equal(named("password").required, false);
        assert.equal(named("password").secret, true);
    });

    it("bounds the port to a port", () => {
        const port = named("port");

        assert.equal(port.type, "number");
        assert.equal(port.min, 1);
        assert.equal(port.max, 65535);
    });

    it("accepts an address and refuses what is not one", () => {
        const {regex} = named("to");

        assert.ok(regex.test("ops@example.com"));
        assert.ok(regex.test("first.last+tag@sub.example.co.uk"));

        for (const bad of ["ops", "ops@", "@example.com", "ops @example.com", "ops@example", "a@b.c\nBcc: x@y.z"])
            assert.ok(!regex.test(bad), `${JSON.stringify(bad)} was accepted as an address`);
    });

    /**
     * The recipient field takes a list; the sender does not, because a message
     * has one sender and a relay checks it against the identity that
     * authenticated.
     */
    it("accepts a list of recipients and only one sender", () => {
        const to = named("to").regex;
        const from = named("from").regex;

        assert.ok(to.test("ops@example.com,oncall@example.com"));
        assert.ok(to.test("ops@example.com , oncall@example.com"));
        assert.ok(!from.test("ops@example.com,oncall@example.com"),
            "a second sender was accepted, which no relay will honour");
    });

    it("refuses a list with a bad address anywhere in it", () => {
        const {regex} = named("to");

        for (const bad of ["ops@example.com,", ",ops@example.com", "ops@example.com,,x@y.co",
            "ops@example.com,nonsense", "nonsense,ops@example.com"])
            assert.ok(!regex.test(bad), `${JSON.stringify(bad)} was accepted as a recipient list`);
    });

    it("accepts a hostname or an address as the relay, and not a URL", () => {
        const {regex} = named("host");

        assert.ok(regex.test("smtp.example.com"));
        assert.ok(regex.test("192.168.1.25"));

        for (const bad of ["smtp://example.com", "smtp.example.com/path", "smtp example.com", ""])
            assert.ok(!regex.test(bad), `${JSON.stringify(bad)} was accepted as a relay`);
    });
});
