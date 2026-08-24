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
 * Removes the prefix from the path the routes will read.
 *
 * `req.url` only. `req.originalUrl` is what the HTTPS redirect builds its
 * Location from, and a redirect that had dropped the prefix would send the
 * caller out of the application and into whatever else the proxy serves at the
 * root.
 *
 * A request that does not carry the prefix passes through untouched, and that is
 * load-bearing rather than lenient: the container healthcheck asks
 * 127.0.0.1:5216/api/health directly, with no proxy and no prefix in front of
 * it, so an instance that answered 404 there would be restarted forever.
 *
 * The boundary is checked rather than the characters. `/internet_speedy` starts
 * with `/internet_speed` and is a different path; stripping it would produce
 * `/y`, which is nobody's route and would 404 with nothing said about why.
 */
export const stripBasePath = (base) => (req, res, next) => {
    if (base === "") return next();

    const url = req.url;

    if (url === base || url.startsWith(`${base}/`)) req.url = url.slice(base.length) || "/";
    else if (url.startsWith(`${base}?`)) req.url = `/${url.slice(base.length)}`;

    next();
};

/** What the process was started with, read once. */
export const basePath = () => normaliseBasePath(process.env.BASE_PATH);
