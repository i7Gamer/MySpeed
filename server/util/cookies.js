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
 * The characters a prefix may carry into the Path attribute.
 *
 * `normaliseBasePath` takes the slashes off the ends and passes everything else
 * through, which is right for routing - any byte is a legal path segment, and
 * the router only ever compares it to itself. A header is not routing: ";" ends
 * this attribute and begins another, so `BASE_PATH="/x; Domain=evil.example"`
 * would widen every session cookie to a domain the operator typed by accident,
 * and a control character has node refuse the whole response.
 *
 * An allow-list rather than a list of the two characters that bite, because the
 * question here is "is this the ordinary prefix this attribute is for", and
 * every prefix anybody deploys - /myspeed, /internet_speed, /apps/speed - is
 * inside it.
 */
const WRITABLE_PATH = /^\/[A-Za-z0-9\-._~%/]*$/;

/**
 * Where the browser should send the session cookie back to.
 *
 * The configured prefix if the request came in carrying it, and the root if it
 * did not - which is a distinction this server actually has to make, because it
 * answers on both. `stripBasePath` passes an un-prefixed request through
 * untouched on purpose: the container healthcheck asks 127.0.0.1:5216/api/health
 * with no proxy in front of it. So an instance with BASE_PATH set is reachable
 * at the prefix and at the root, and which one a browser is on is a property of
 * that browser rather than of the configuration.
 *
 * Scoping to the configured prefix regardless is a login loop for the second
 * kind of browser: the sign-in succeeds and hands back a cookie for a path it
 * will never ask under, so the next request carries nothing and the page asks
 * for the password again, with nothing said about why.
 *
 * `req.originalUrl` is the one path that still has the prefix on it by the time
 * a route runs - `req.url` had it stripped, and `appPath` exists to hand out the
 * stripped one. The boundary is checked the way stripBasePath checks it, so
 * `/internet_speedy` is not read as this application.
 *
 * A request that cannot be read scopes to the root: nothing to decide with, and
 * the root is the scope every browser can send back. What is given up there is
 * the cookie's reach, not the session.
 */
export const cookiePath = (req) => {
    const base = basePath();
    if (base === "" || !WRITABLE_PATH.test(base)) return "/";

    const url = req?.originalUrl;
    if (typeof url !== "string") return "/";

    return url === base || url.startsWith(`${base}/`) || url.startsWith(`${base}?`) ? base : "/";
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
 * The request is taken rather than the path, deliberately: a browser keys a
 * cookie by name *and* path, so a sign-out clearing "/" after a login set
 * "/internet_speed" would not delete anything - it would write a second, empty
 * cookie beside the first and leave the live session id in the browser. Handing
 * over the request instead of a Path is what keeps the two call sites from
 * disagreeing while still letting the answer depend on the route asked: one
 * browser loads the page under one prefix and asks for both endpoints the same
 * way, so it gets one scope by construction.
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
export const serialiseCookie = (name, value, {req, maxAge, secure = false} = {}) => {
    const parts = [
        `${name}=${encodeURIComponent(value)}`,
        `Path=${cookiePath(req)}`,
        "HttpOnly",
        "SameSite=Strict"
    ];

    if (maxAge !== undefined) parts.push(`Max-Age=${maxAge}`);
    if (secure) parts.push("Secure");

    return parts.join("; ");
};
