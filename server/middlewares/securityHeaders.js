/**
 * The response headers a browser needs to defend the dashboard on a hostile
 * network. `x-powered-by` was previously the only header the app touched.
 *
 * Hand-rolled rather than pulling in helmet: the whole policy is a dozen lines,
 * and adding a dependency means regenerating bun.lock.
 */
const HSTS_MAX_AGE_SECONDS = 15552000;

// A month of `preload` cannot be undone quickly, so it is deliberately absent -
// that is a decision for whoever owns the domain, not a default.
const HSTS_VALUE = `max-age=${HSTS_MAX_AGE_SECONDS}; includeSubDomains`;

const DEFAULT_FRAME_ANCESTORS = "'none'";

/**
 * The operator's ancestor list, reduced to something a header can carry.
 *
 * The value is the operator's own, so this is not a way in - it is the way a
 * plausible mistake becomes an outage, or a policy nobody wrote.
 *
 * A semicolon ends the directive, so FRAME_ANCESTORS="'self'; sandbox" appends a
 * complete second directive to the policy composed below - and `sandbox` alone
 * leaves the dashboard unable to run its own scripts. A comma ends the whole
 * policy the same way, which is what the natural comma-separated spelling of a
 * list quietly does to the second origin in it.
 *
 * Anything outside printable ASCII goes for a different reason: res.setHeader
 * refuses those characters outright, so a value that keeps the newline it was
 * read with - a here-doc, a file, a copied line - throws from inside this
 * middleware on *every* request. The instance then answers 500 to everything,
 * including the health endpoint that would otherwise say what is wrong. A
 * source list is hosts, schemes and ports; none of it lives outside that range.
 *
 * Replaced with a space rather than deleted, so two origins with a stray
 * character between them stay two origins instead of being joined into one
 * address that matches nothing. A value left holding nothing at all falls back
 * to the default refusal: an empty directive is a policy no browser can read.
 */
const ancestorList = (value) => {
    const cleaned = String(value ?? "")
        .replace(/[^\x20-\x7E]/g, " ")
        .replace(/[;,]/g, " ")
        .trim()
        .replace(/\s+/g, " ");

    return cleaned === "" ? DEFAULT_FRAME_ANCESTORS : cleaned;
};

/**
 * `style-src` carries 'unsafe-inline' because the app genuinely needs it: React
 * sets `style` attributes for the target bars in the test detail view, and
 * @fortawesome/fontawesome-svg-core writes its CSS into a <style> element at
 * runtime. `script-src` does not - the Vite build emits only external modules,
 * and vite-plugin-pwa registers the service worker from /registerSW.js rather
 * than inline - so scripts stay restricted to same-origin files.
 *
 * The remaining directives cost nothing and are the ones that actually stop
 * clickjacking, plugin abuse, base-tag injection and off-site form posts.
 */
const buildPolicy = (frameAncestors) => [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    `frame-ancestors ${frameAncestors}`
].join("; ");

export default () => {
    // Self-hosters embed MySpeed in dashboards like Homepage or Heimdall, which
    // a bare 'none' breaks. The default stays restrictive; the escape hatch is
    // an explicit list of origins.
    const frameAncestors = ancestorList(process.env.FRAME_ANCESTORS);
    const policy = buildPolicy(frameAncestors);

    return (req, res, next) => {
        res.setHeader("Content-Security-Policy", policy);
        res.setHeader("X-Content-Type-Options", "nosniff");
        res.setHeader("Referrer-Policy", "no-referrer");

        // Redundant with frame-ancestors for modern browsers, kept for the ones
        // that only understand this. Skipped when the operator has opted into
        // framing, since this header cannot express an origin list.
        if (frameAncestors === DEFAULT_FRAME_ANCESTORS) res.setHeader("X-Frame-Options", "DENY");

        // Only meaningful over TLS, and actively misleading over plain HTTP.
        // req.secure honours X-Forwarded-Proto once `trust proxy` is set, which
        // is how it comes out true behind a terminating reverse proxy.
        if (req.secure) res.setHeader("Strict-Transport-Security", HSTS_VALUE);

        next();
    };
};
