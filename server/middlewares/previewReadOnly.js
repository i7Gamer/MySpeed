// Methods that cannot change anything, and so need no guard.
const SAFE_METHODS = ["GET", "HEAD", "OPTIONS"];

const DEFAULT_MESSAGE = "You can't change anything on this instance in preview mode";

const refuses = (message) => (req, res, next) => {
    if (process.env.PREVIEW_MODE !== "true") return next();
    if (SAFE_METHODS.includes(req.method)) return next();

    return res.status(403).json({message});
};

/**
 * Refuses a request that would change something on a demo instance.
 *
 * In preview mode the password middleware waves every request through - there
 * is no password on a public demo and nobody to hold one - so the only thing
 * between an anonymous visitor and the admin API was a `if (process.env
 * .PREVIEW_MODE === "true") return res.status(403)` written out by hand on each
 * route that remembered to. Most routes carried a copy; the ones that did not
 * were DELETE /api/storage/tests/history, which empties the history, DELETE
 * /api/storage/config, which factory-resets the instance - each sitting
 * directly beside a PUT sibling that did have the check - and the node proxy,
 * which reaches a different machine entirely with that machine's stored
 * password substituted in.
 *
 * One middleware instead, so the guard is applied rather than reproduced. It is
 * mounted per route rather than globally on /api because a demo is meant to be
 * usable: running a test is the thing visitors come to press, and preview mode
 * has a whole branch in tasks/speedtest.js that answers it with a plausible
 * result. Read-only would be a simpler rule and the wrong one.
 *
 * `saying` exists so converting the hand-written copies did not have to flatten
 * their wording. "You can't create nodes in preview mode" tells a visitor which
 * door they tried; the generic sentence is right for a route that never had a
 * sentence of its own. What matters is that the *rule* has one home - the
 * message is presentation.
 */
const previewReadOnly = refuses(DEFAULT_MESSAGE);

previewReadOnly.saying = (message) => refuses(message);

export default previewReadOnly;
