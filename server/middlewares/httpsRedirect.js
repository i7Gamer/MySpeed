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

export default ({enabled = isEnabled, port = () => httpsPort} = {}) => (req, res, next) => {
    // Evaluated per request, not once at startup: the listener may not have
    // come up yet when the middleware stack is built, and it can fail later.
    if (!enabled() || req.secure || isLoopbackRequest(req)) return next();

    res.setHeader("Cache-Control", "no-store");
    return res.redirect(TEMPORARY_REDIRECT, `https://${req.hostname}:${port()}${req.originalUrl}`);
};
