import { isHttpsListening, httpsPort } from '../config/tls.js';
import { isLoopbackRequest } from '../util/clientAddress.js';

/**
 * Sends network callers to the HTTPS listener when there is one.
 *
 * Both listeners serve the same app, so a user who typed http:// handed their
 * password to anyone on the path even though the instance had a working
 * certificate the whole time.
 *
 * Local callers are left alone: the container healthcheck talks plain HTTP to
 * 127.0.0.1 and would fail chasing a redirect to a self-signed certificate.
 *
 * Behind a TLS-terminating reverse proxy this does nothing, because req.secure
 * is already true - provided TRUST_PROXY is set. If it is not, and the instance
 * also happens to hold its own certificates, set HTTPS_REDIRECT=false.
 */

/**
 * Temporary, not permanent.
 *
 * A 308 is cacheable indefinitely, and the target is built from an internal
 * port number. Get that combination wrong once - a port clash, a certificate
 * the operator later removes, a host reached through a different port - and
 * every browser that saw it keeps redirecting to somewhere unreachable, with
 * no request to the server that could correct it. A 307 expires with the
 * response, so a misconfiguration stays fixable.
 */
const TEMPORARY_REDIRECT = 307;

const isEnabled = () => process.env.HTTPS_REDIRECT !== "false" && isHttpsListening();

/**
 * A host this middleware is willing to write into a Location.
 *
 * The target has to carry the name the caller asked for - one instance answers
 * on several, and rewriting the host would send every reader to whichever one
 * the operator happened to configure - but the name comes from the Host header,
 * which is whatever the caller wrote, and it is pasted into a URL. A header of
 * `myspeed.example@attacker.example` is read by a browser as userinfo followed
 * by a host: the instance answered a plain request by sending its reader to
 * somebody else's server, with its own name still at the front of the URL to
 * make the trip look right.
 *
 * So: letters, digits, dots and hyphens, or the bracketed IPv6 literal express
 * hands back with its brackets still on. Everything a URL parser splits on -
 * `@`, `/`, `\`, `?`, `#`, a space - is refused, and a request wearing one is
 * served over plain HTTP instead of redirected, which is what it was already
 * getting.
 */
const REDIRECTABLE_HOST = /^(?:[A-Za-z0-9.-]+|\[[0-9A-Fa-f:.]+])$/;

export default ({enabled = isEnabled, port = () => httpsPort} = {}) => (req, res, next) => {
    // Evaluated per request, not once at startup: the listener may not have
    // come up yet when the middleware stack is built, and it can fail later.
    if (!enabled() || req.secure || isLoopbackRequest(req)) return next();

    if (!REDIRECTABLE_HOST.test(String(req.hostname ?? ""))) return next();

    res.setHeader("Cache-Control", "no-store");
    return res.redirect(TEMPORARY_REDIRECT, `https://${req.hostname}:${port()}${req.originalUrl}`);
};
