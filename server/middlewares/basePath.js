/**
 * Serving the whole application from a subdirectory - upstream #771.
 *
 * The reporter runs Traefik with `PathPrefix('/internet_speed')` and no
 * StripPrefix beside it, so every request arrives carrying the prefix, and asked
 * for "an env var that I could set and all requests are prepended with this
 * value". BASE_PATH is that variable.
 *
 * It is taken off at the very front rather than threaded through thirty route
 * mounts. Two reasons, and the second is the one that decided it: every route
 * below then sees exactly the path it was written for, so nothing about
 * authentication, rate limiting or body size has to learn about prefixes - and
 * the security scans in tests/ that read those mounts out of the source keep
 * being able to read them. A refactor that moved every `app.use("/api/…")`
 * behind a router would have made a dozen guards unreadable in exchange for
 * nothing the operator can see.
 *
 * The client needs no configuration to match: its assets are emitted relative to
 * wherever index.html was served from, and it works out its own prefix at
 * runtime. So one variable on the server is the whole of it.
 */

/**
 * The configured prefix, in the one spelling everything downstream expects: a
 * leading slash, no trailing one, or the empty string for "no prefix".
 *
 * Typed by a person, so "internet_speed", "/internet_speed" and
 * "/internet_speed/" are all the same intention - and only one of them
 * concatenates correctly against a route that already begins with a slash.
 *
 * "/" is read as no prefix rather than as a prefix of one slash: it is what
 * somebody writes to mean "the root", and taking it literally would strip a
 * character off the front of every request.
 */
export const normaliseBasePath = (value) => {
    if (typeof value !== "string") return "";

    const trimmed = value.trim().replace(/^\/+/, "").replace(/\/+$/, "");

    return trimmed === "" ? "" : `/${trimmed}`;
};

/**
 * Temporary, not permanent, for the redirect below.
 *
 * An operator who takes BASE_PATH off again should not have to fight a redirect
 * that every browser in the house has cached forever.
 */
const REDIRECT_TO_PREFIX_ROOT = 302;

/** The methods a browser follows without dropping the request body on the way. */
const REDIRECTABLE = new Set(["GET", "HEAD"]);

/**
 * Removes the prefix from the path the routes will read.
 *
 * `req.url` only. `req.originalUrl` is what the HTTPS redirect builds its
 * Location from, and a redirect that had dropped the prefix would send the
 * caller out of the application and into whatever else the proxy serves at the
 * root. Handlers that need the whole path without the prefix get `appPath(req)`
 * below rather than either of them.
 *
 * A request that does not carry the prefix passes through untouched, and that is
 * load-bearing rather than lenient: the container healthcheck asks
 * 127.0.0.1:5216/api/health directly, with no proxy and no prefix in front of
 * it, so an instance that answered 404 there would be restarted forever.
 *
 * The boundary is checked rather than the characters. `/internet_speedy` starts
 * with `/internet_speed` and is a different path; stripping it would produce
 * `/y`, which is nobody's route and would 404 with nothing said about why.
 *
 * The bare prefix is redirected to the prefix root rather than served as it.
 * That one slash is what lets the client be told nothing at all: index.html asks
 * for `./assets/index-x.js`, and the browser resolves that against the URL the
 * page came from. Served at `/internet_speed`, the last segment is not read as a
 * directory and the asset resolves to `https://host/assets/index-x.js` - outside
 * the prefix, where the proxy serves something else or nothing, and the page
 * comes up blank. Served at `/internet_speed/`, every one of those URLs lands
 * back inside.
 */
export const stripBasePath = (base) => (req, res, next) => {
    if (base === "") {
        req.appOriginalUrl = req.url;
        return next();
    }

    const url = req.url;

    if ((url === base || url.startsWith(`${base}?`)) && REDIRECTABLE.has(req.method))
        return res.redirect(REDIRECT_TO_PREFIX_ROOT, `${base}/${url.slice(base.length)}`);

    if (url === base || url.startsWith(`${base}/`)) req.url = url.slice(base.length) || "/";
    else if (url.startsWith(`${base}?`)) req.url = `/${url.slice(base.length)}`;

    req.appOriginalUrl = req.url;
    next();
};

/**
 * The whole path a handler should match on, with the prefix already off.
 *
 * Neither of the two paths Express offers is this one. `req.url` holds only the
 * part below the mount once a router has been entered, which is why the callers
 * of this reach for `originalUrl` - but `originalUrl` still carries the prefix,
 * and both of them match it against a pattern anchored at `^/api`. Under a
 * prefix that made the node proxy ask a child for a path the child does not
 * serve, and made the backup relay lose its larger size allowance without
 * saying so.
 *
 * Falls back to `originalUrl` rather than answering undefined: several suites
 * exercise a router with no middleware in front of it, and undefined would match
 * nothing at all rather than failing where it could be seen.
 */
export const appPath = (req) => req.appOriginalUrl ?? req.originalUrl;

/** What the process was started with, read once. */
export const basePath = () => normaliseBasePath(process.env.BASE_PATH);
