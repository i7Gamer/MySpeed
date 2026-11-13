import {bareHost} from "./helpers.js";
import {OUTBOUND_TIMEOUT} from "./integrationActivity.js";
import {smtpSocket} from "./smtpSocket.js";

/**
 * Whether the operator said their relay may be spoken to in the clear.
 *
 * Without `requireTLS`, nodemailer upgrades only when the server's greeting
 * advertises STARTTLS - and the greeting travels unencrypted, so anyone between
 * this instance and the relay removes that one line and receives the login and
 * the message in plaintext. The upgrade therefore has to be demanded rather
 * than hoped for, and a relay that genuinely speaks no TLS (a LAN postfix on
 * port 25) has to be something the operator stated, not something a stripped
 * greeting can state for them.
 *
 * Only the literal string, like ALLOW_NO_PASSWORD: a typo must not disarm it.
 */
const allowsPlaintext = () => process.env.SMTP_ALLOW_PLAINTEXT === "true";

// Kept in a leaf so native/compiled transport fixtures exercise the production
// options without loading notification templates or generated client assets.
export const transportOptions = ({host, port, secure, username, password}) => ({
    host: bareHost(host),
    port: Number(port),
    secure: secure === true,
    // Nothing to demand on a socket that is TLS from its first byte.
    ...(secure === true || allowsPlaintext() ? {} : {requireTLS: true}),
    ...(username ? {auth: {user: username, pass: password ?? ""}} : {}),
    allowInternalNetworkInterfaces: true,
    // A connected socket prevents the mailer's eager DNS resolution from
    // bypassing our filter. Nodemailer still handles STARTTLS on this socket.
    getSocket: smtpSocket,
    connectionTimeout: OUTBOUND_TIMEOUT,
    greetingTimeout: OUTBOUND_TIMEOUT,
    socketTimeout: OUTBOUND_TIMEOUT,
    // Preserve one connection per notification and the shared resolver cache.
    pool: false
});
