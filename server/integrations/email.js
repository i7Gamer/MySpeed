import nodemailer from "nodemailer";
import { replaceVariables, truncate } from "../util/helpers.js";
import { checkOutboundHost } from "../util/safeUrl.js";
import { OUTBOUND_TIMEOUT, noteActivity } from "../util/integrationActivity.js";

/**
 * Email, which is upstream #1259.
 *
 * The one notification channel missing from the eight, and the only one that is
 * not an HTTP POST - so none of util/http.js reaches it. Two things that every
 * other module inherits from there have to be rebuilt in this file, and they are
 * the reason it is longer than gotify: the address guard 1.3.4 put in front of
 * every outbound send, and the activity note that turns a failure into "this
 * endpoint is not working" on the integration card.
 *
 * nodemailer rather than a hand-written SMTP client. The protocol's long tail -
 * STARTTLS against implicit TLS, which AUTH mechanism a given server offers,
 * multi-line continuations, dot-stuffing, header encoding - lives in other
 * people's mail servers rather than in anything this project controls, which is
 * the opposite of the case for the bun-sqlite shim next door. It carries no
 * dependencies of its own, so the usual argument against a library does not
 * apply here.
 */

const defaults = {
    finished_subject: "MySpeed: speedtest finished",
    finished: "A speedtest is finished:\nPing: %ping% ms (±%jitter% ms)\nDownload: %download% Mbps\nUpload: %upload% Mbps",
    error_subject: "MySpeed: speedtest failed",
    failed: "A speedtest has failed.\nReason: %error%"
};

/**
 * The name in front of the address, so a mailbox shows what sent the message
 * without a field asking for it.
 *
 * Only the address is the operator's: relays commonly require the addr-spec to
 * match the identity that authenticated, and a display name in front of it does
 * not affect that.
 */
const SENDER_NAME = "MySpeed";

/**
 * How much subject a header may carry.
 *
 * A header is not a body. The failure template can interpolate `%error%`, which
 * carries up to cliOutput's MAX_ERROR_LENGTH of raw CLI output - and a subject
 * that long is refused outright by some servers and folded into nonsense by
 * others, which loses the alert rather than shortening it. Well inside the 998
 * octets a line may hold once folding and any encoding are accounted for.
 */
export const SUBJECT_LIMIT = 200;

/**
 * One address, in the shape both fields want it.
 *
 * Deliberately a bare addr-spec rather than `Name <addr>`. A display name is put
 * in front of the sender below, and allowing one here would mean parsing the
 * angle brackets to find the addr-spec - which is the part a relay checks
 * against the identity that authenticated, and the part a recipient list has to
 * be split on.
 *
 * `<`, `>` and `,` are excluded from every position on purpose: they are the
 * characters that would let one value become two, or become a header of its own.
 */
const ADDRESS = String.raw`[^\s@<>,]+@[^\s@<>,.]+(?:\.[^\s@<>,.]+)+`;

const ONE_ADDRESS = new RegExp(`^${ADDRESS}$`);

/**
 * One or more, comma-separated.
 *
 * Built from the same fragment rather than a looser "anything with commas in
 * it", so a list is refused whole when any one address in it is malformed. A
 * relay handed `ops@example.com,nonsense` answers 550 for the bad one and the
 * notification is lost - or, worse, delivered to some and not others with
 * nothing said.
 */
// String.raw, like the fragment above: a template literal reduces an
// unrecognised escape, so a plain `\s` here would have compiled to a literal "s"
// and the pattern would have refused every list with a space in it while
// accepting "opss,soncall".
const SPACE = String.raw`\s*`;

const ADDRESS_LIST = new RegExp(`^${SPACE}${ADDRESS}(?:${SPACE},${SPACE}${ADDRESS})*${SPACE}$`);

/**
 * The stored value as a relay wants to read it: one comma-and-space separated
 * list, however it was typed.
 */
const recipientList = (value) => String(value ?? "").split(",").map((address) => address.trim())
    .filter(Boolean).join(", ");

/**
 * A subject that cannot become more than a subject.
 *
 * A header ends at the newline, so one inside this value would end it early and
 * let whatever follows be read as a header of its own - a `Bcc:` among it, on a
 * value the operator typed into their own template. nodemailer encodes what it
 * is given rather than refusing it, so the cut is ours to make.
 *
 * Collapsed to a space rather than dropped, so two lines of a pasted subject do
 * not run together into one word.
 */
const headerSafe = (value) => truncate(String(value).replace(/[\r\n]+/g, " ").trim(), SUBJECT_LIMIT);

/**
 * An address the module is willing to dial.
 *
 * The guard util/http.js applies to every other integration, reached here
 * through checkOutboundHost because there is no URL to hand it - just a host and
 * a port. Loopback and the LAN stay allowed, which is the same policy and the
 * one that matters most for mail: a relay on the operator's own network is the
 * ordinary case rather than the suspicious one.
 */
const refuseBlocked = (host, activity) => {
    const target = checkOutboundHost(host);
    if (target.safe) return false;

    noteActivity(activity, true);
    console.error(`Integration request to ${host} failed: ${target.reason}`);

    return true;
};

/**
 * What nodemailer is asked to build.
 *
 * `secure` is "wrap the socket in TLS immediately", which is port 465. False is
 * not plaintext: nodemailer still upgrades through STARTTLS when the server
 * offers it, which is what port 587 does.
 *
 * `auth` is omitted rather than sent empty when no username is set. A relay that
 * needs no credentials is ordinary on a LAN, and nodemailer answers an auth
 * object carrying an empty user by trying to authenticate anyway.
 *
 * `allowInternalNetworkInterfaces` because nodemailer refuses private and
 * loopback addresses by default, which is the opposite of this project's policy
 * - checkOutboundTarget allows both on purpose, and the guard above is what
 * decides the question here.
 *
 * The three timeouts are the deadline every other integration's send carries.
 * Without them a relay that accepts a connection and then says nothing holds the
 * notification, and the run that triggered it, on nodemailer's own defaults.
 */
export const transportOptions = ({host, port, secure, username, password}) => ({
    host,
    port: Number(port),
    secure: secure === true,
    ...(username ? {auth: {user: username, pass: password ?? ""}} : {}),
    allowInternalNetworkInterfaces: true,
    connectionTimeout: OUTBOUND_TIMEOUT,
    greetingTimeout: OUTBOUND_TIMEOUT,
    socketTimeout: OUTBOUND_TIMEOUT,
    // One connection per notification. These arrive at most once per speedtest,
    // so a pool would hold a socket open across the whole gap between two runs
    // for no saving - and would need tearing down on shutdown, which nothing
    // else in here has to think about.
    pool: false
});

/**
 * @param createTransport  defaulted, and passed only by the tests, which hand in
 * a recorder. The registry calls `setup(registerEvent(name))` with one argument,
 * so nothing in production ever supplies it. The alternative is a test that
 * opens a real socket to a real relay, which is the one thing tests/server must
 * never do.
 */
export default (registerEvent, createTransport = nodemailer.createTransport) => {
    const send = async (c, subject, text, activity) => {
        if (refuseBlocked(c.host, activity)) return;

        try {
            const transport = createTransport(transportOptions(c));

            await transport.sendMail({
                from: `${SENDER_NAME} <${c.from}>`,
                to: recipientList(c.to),
                subject: headerSafe(subject),
                text
            });

            noteActivity(activity, false);
        } catch (error) {
            // Reported rather than thrown, like every other module's send.
            // triggerEvent works through the integrations one at a time, so a
            // throw escaping here takes the ones after it down with this one.
            noteActivity(activity, true);
            console.error(`Integration request to ${c.host} failed: ${error?.message ?? error}`);
        }
    };

    registerEvent('testFinished', async ({data: c}, data, activity) => {
        if (c.send_finished) await send(c,
            replaceVariables(c.finished_subject || defaults.finished_subject, data),
            replaceVariables(c.finished_message || defaults.finished, data), activity);
    });

    registerEvent('testFailed', async ({data: c}, failure, activity) => {
        if (c.send_failed) await send(c,
            replaceVariables(c.error_subject || defaults.error_subject, failure),
            replaceVariables(c.error_message || defaults.failed, failure), activity);
    });

    return {
        // Opts in to the shared threshold settings; isNotifier in
        // controller/integrations.js explains the flag.
        notifier: true,
        icon: "fa-solid fa-envelope",
        fields: [
            // A host or an address, and not a URL: this is dialled directly
            // rather than fetched, so a scheme or a path in here names nothing
            // and would be silently ignored at connect time. Anchored, as every
            // pattern here is - `test` matches anywhere otherwise.
            {name: "host", type: "text", required: true, regex: /^\[?[A-Za-z0-9._:-]+]?$/},
            // A number rather than a pattern, so the range is stated once and
            // read by validateInput rather than spelled out as a regex nobody
            // can check by eye.
            {name: "port", type: "number", required: true, min: 1, max: 65535},
            {name: "secure", type: "boolean", required: false},
            /*
             * Neither half is required: a relay that needs no login is ordinary
             * on a LAN. Both are withheld though - the password because it is
             * the credential, and the username because on most relays it *is*
             * the mailbox address, so disclosing it turns a password guess into
             * a targeted one.
             */
            {name: "username", type: "text", required: false, secret: true},
            {name: "password", type: "text", required: false, secret: true},
            /*
             * Withheld for a different reason from every other secret here:
             * these are somebody's mailboxes rather than a capability. A demo
             * visitor has no business reading the operator's address, and a
             * config export is a file people attach to bug reports.
             *
             * The relay host and port stay in the clear on purpose. A hostname
             * is not a capability - reaching it still needs the credentials
             * above - and blanking it would cost the diagnosis such an export
             * exists for.
             *
             * Deliberately a bare address on both. A display name is put in
             * front of the sender above, and allowing one here would mean
             * parsing `Name <addr>` to find the addr-spec, which is the part a
             * relay checks against the identity that authenticated.
             */
            {name: "from", type: "text", required: true, secret: true, regex: ONE_ADDRESS},
            // A list, unlike the sender: an alert usually wants an operator and
            // whoever is on call, and one address per integration would mean a
            // second one configured identically. Spacing either side of the
            // comma is tolerated because a list pasted out of a mail client
            // carries it; recipientList below tidies it on the way out.
            {name: "to", type: "text", required: true, secret: true, regex: ADDRESS_LIST},
            {name: "send_finished", type: "boolean", required: false},
            {name: "finished_subject", type: "text", required: false},
            {name: "finished_message", type: "textarea", required: false},
            {name: "send_failed", type: "boolean", required: false},
            {name: "error_subject", type: "text", required: false},
            {name: "error_message", type: "textarea", required: false}
        ]
    };
};
