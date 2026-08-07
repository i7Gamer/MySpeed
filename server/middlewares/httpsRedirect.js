import { hasSSLCerts, httpsPort } from '../config/tls.js';
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
const PERMANENT_REDIRECT = 308;

export default () => {
    // Evaluated once at startup, the same moment index.js decides whether to
    // open the HTTPS listener at all.
    const enabled = process.env.HTTPS_REDIRECT !== "false" && hasSSLCerts();

    return (req, res, next) => {
        if (!enabled || req.secure || isLoopbackRequest(req)) return next();

        return res.redirect(PERMANENT_REDIRECT, `https://${req.hostname}:${httpsPort}${req.originalUrl}`);
    };
};
