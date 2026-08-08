import path from 'node:path';
import fs from 'node:fs';

/**
 * Where the optional built-in HTTPS listener looks for its certificate.
 *
 * Shared with app.js so the HTTP listener knows whether there is an HTTPS one to
 * redirect to.
 */
const certsDir = path.join(process.cwd(), 'data', 'certs');

export const certPath = path.join(certsDir, 'cert.pem');
export const keyPath = path.join(certsDir, 'key.pem');

export const httpsPort = process.env.HTTPS_PORT || 5217;

export const hasSSLCerts = () => fs.existsSync(certPath) && fs.existsSync(keyPath);

/**
 * Whether the HTTPS listener is actually accepting connections.
 *
 * The redirect used to key on the certificate *files* existing, but index.js
 * opens the listener inside a try/catch - an unreadable key, a malformed
 * certificate or a port already in use logs a warning and carries on. Every
 * network caller was then sent to a port with nothing behind it, and the
 * instance became unreachable over HTTP without serving anything over HTTPS.
 */
let listening = false;

export const setHttpsListening = (value) => { listening = value; };

export const isHttpsListening = () => listening;
