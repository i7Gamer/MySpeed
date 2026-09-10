import {bareHost} from "./helpers.js";
import {OUTBOUND_TIMEOUT} from "./integrationActivity.js";
import {smtpSocket} from "./smtpSocket.js";

// Kept in a leaf so native/compiled transport fixtures exercise the production
// options without loading notification templates or generated client assets.
export const transportOptions = ({host, port, secure, username, password}) => ({
    host: bareHost(host),
    port: Number(port),
    secure: secure === true,
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
