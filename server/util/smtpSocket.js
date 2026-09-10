import net from "node:net";
import tls from "node:tls";
import {checkOutboundHost} from "./safeUrl.js";
import {bareHost} from "./helpers.js";
import {OUTBOUND_TIMEOUT} from "./integrationActivity.js";
import {smtpResolver, SMTP_DNS_QUERY_TIMEOUT_MS} from "./smtpResolver.js";

const ignoreError = () => {};

/**
 * Supply Nodemailer a connected socket so it cannot resolve a checked hostname
 * again. Implicit TLS finishes here; STARTTLS remains Nodemailer's job on the
 * same TCP socket. Only pre-handoff failures retry, never SMTP authentication
 * or a message that might already have been delivered.
 *
 * lookup/dial and an optional internal cancellation signal let tests exercise
 * socket ownership without contacting a real relay. No configuration fields or
 * new total-send/DNS deadlines are introduced.
 */
export const createSmtpSocket = ({lookup = smtpResolver.lookup, signal, dial} = {}) => (options, callback) => {
    let settled = false;
    let current = null;
    const host = bareHost(options.host);
    const dispose = attempt => {
        if (!attempt) return;
        clearTimeout(attempt.timer);
        if (attempt.socket) {
            attempt.socket.removeListener("error", attempt.onError);
            attempt.socket.removeListener("close", attempt.onClose);
            attempt.socket.removeListener(attempt.readyEvent, attempt.onReady);
            attempt.socket.on("error", ignoreError);
            attempt.socket.destroy();
        }
    };
    const finish = (error, result) => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener("abort", onAbort);
        if (error) dispose(current);
        callback(error, result);
    };
    const onAbort = () => finish(new Error("SMTP connection cancelled"));
    if (signal?.aborted) return onAbort();
    signal?.addEventListener("abort", onAbort, {once: true});
    if (!checkOutboundHost(host).safe) return finish(new Error("SMTP destination is blocked"));

    const resolved = (error, addresses) => {
        if (settled) return;
        if (error) return finish(error);
        // Recheck at the dial boundary, including callers with an injected
        // resolver and cached answers. Native numeric dialing bypasses lookup.
        const permitted = addresses.filter(({address}) => net.isIP(address) && checkOutboundHost(address).safe);
        let index = 0;
        const next = lastError => {
            if (settled) return;
            if (index >= permitted.length)
                return finish(lastError ?? new Error("SMTP destination has no permitted numeric address"));
            const {address, family} = permitted[index++];
            const attempt = {};
            current = attempt;
            const fail = failure => {
                if (settled || current !== attempt) return;
                current = null;
                dispose(attempt);
                next(failure);
            };
            attempt.onError = fail;
            attempt.onClose = () => fail(new Error("SMTP socket closed before connection completed"));
            attempt.readyEvent = options.secure ? "secureConnect" : "connect";
            attempt.onReady = () => {
                if (settled || current !== attempt) return;
                clearTimeout(attempt.timer);
                attempt.socket.removeListener("error", attempt.onError);
                attempt.socket.removeListener("close", attempt.onClose);
                // Nodemailer attaches its own error handler synchronously in
                // the callback. Keep an error sink across that handoff and
                // preserve the keepalive setting of its native connect path.
                attempt.socket.on("error", ignoreError);
                attempt.socket.setKeepAlive(true);
                finish(null, {connection: attempt.socket, secured: options.secure === true});
            };
            attempt.timer = setTimeout(() => fail(Object.assign(new Error("Connection timeout"), {code: "ETIMEDOUT"})),
                options.connectionTimeout || OUTBOUND_TIMEOUT);
            const connectOptions = {
                ...(options.secure ? (options.tls ?? {}) : {}),
                host: address, port: options.port, family,
                ...(options.secure ? {servername: options.tls?.servername ?? (net.isIP(host) ? undefined : host)} : {})
            };
            try {
                attempt.socket = (dial ?? (options.secure ? tls.connect : net.connect))(connectOptions);
                attempt.socket.once(attempt.readyEvent, attempt.onReady);
                attempt.socket.once("error", attempt.onError);
                attempt.socket.once("close", attempt.onClose);
            } catch (failure) { fail(failure); }
        };
        next();
    };
    if (net.isIP(host)) return resolved(null, [{address: host, family: net.isIP(host)}]);
    try {
        lookup(host, {all: true, timeout: options.dnsTimeout || SMTP_DNS_QUERY_TIMEOUT_MS,
            allowInternalNetworkInterfaces: options.allowInternalNetworkInterfaces}, resolved);
    } catch (error) { finish(error); }
};

export const smtpSocket = createSmtpSocket();
