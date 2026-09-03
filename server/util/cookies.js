import { basePath } from "../middlewares/basePath.js";

/**
 * The little bit of cookie handling this server needs.
 *
 * Hand-rolled rather than adding cookie-parser: one cookie is read and one is
 * written, and the whole of it is shorter than the lockfile entry would be.
 */
export const readCookie = (req, name) => {
    const header = req.headers?.cookie;
    if (typeof header !== "string") return null;

    for (const pair of header.split(";")) {
        const index = pair.indexOf("=");
        if (index === -1) continue;

        if (pair.slice(0, index).trim() !== name) continue;

        try {
            return decodeURIComponent(pair.slice(index + 1).trim());
        } catch {
            return null;
        }
    }

    return null;
};

/**
 * Builds the Set-Cookie value.
 *
 * HttpOnly is the entire reason this exists - it is what puts the credential
 * out of reach of any script on the page. SameSite=Strict is what stops the
 * cookie turning every state-changing endpoint into a CSRF target now that a
 * browser attaches it automatically. Secure is set only on a secure request, so
 * a plain-HTTP LAN install still works.
 *
 * Path follows BASE_PATH, and it is the one attribute here that was not already
 * about this instance. Hard-coded to "/" it is right for an install that owns
 * its origin and wrong for the deployment BASE_PATH exists for - one origin
 * serving several applications at different prefixes, which is the Traefik
 * setup upstream #771 described. There the browser attaches `myspeed_session`
 * to every request to the sibling application as well, putting a full-access
 * session token into another service's request logs; SameSite=Strict does not
 * help, because the token is sent to that server directly rather than read by a
 * script on a page.
 *
 * There is no argument for a call site to pass, deliberately: a browser keys a
 * cookie by name *and* path, so a sign-out clearing "/" after a login set
 * "/internet_speed" would not delete anything - it would write a second, empty
 * cookie beside the first and leave the live session id in the browser. Two
 * call sites that cannot disagree are worth more here than an option nothing
 * needs.
 *
 * Two things this is not. It is not retroactive: a session established before
 * this carries a Path=/ cookie that the new code never clears, so it keeps
 * reaching the sibling until its Max-Age runs out - harmless in the meantime,
 * since browsers send the longer path first and a stale id is simply an unknown
 * session. And it forecloses a future `__Host-` cookie name prefix, which
 * requires exactly Path=/: that prefix pins a cookie to its origin, a scoped
 * path isolates it from the siblings on that origin, and only one of the two
 * can be had. The siblings are the deployment this project actually has.
 */
export const serialiseCookie = (name, value, {maxAge, secure = false} = {}) => {
    const parts = [
        `${name}=${encodeURIComponent(value)}`,
        `Path=${basePath() || "/"}`,
        "HttpOnly",
        "SameSite=Strict"
    ];

    if (maxAge !== undefined) parts.push(`Max-Age=${maxAge}`);
    if (secure) parts.push("Secure");

    return parts.join("; ");
};
