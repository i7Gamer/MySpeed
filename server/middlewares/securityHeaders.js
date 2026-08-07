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
 * `script-src` and `style-src` carry 'unsafe-inline' because the app genuinely
 * needs it today: vite-plugin-pwa runs with `injectRegister: "auto"`, which
 * injects the service-worker registration as an inline script, and
 * @fortawesome/fontawesome-svg-core writes its CSS into a <style> element at
 * runtime. Tightening either one means changing the client build first.
 *
 * The remaining directives cost nothing and are the ones that actually stop
 * clickjacking, plugin abuse, base-tag injection and off-site form posts.
 */
const buildPolicy = (frameAncestors) => [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline'",
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
    const frameAncestors = process.env.FRAME_ANCESTORS || DEFAULT_FRAME_ANCESTORS;
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
