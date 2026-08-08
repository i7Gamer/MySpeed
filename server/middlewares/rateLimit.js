import { clientKey } from '../util/clientKey.js';

/**
 * A fixed-window per-client request limiter.
 *
 * Hand-rolled rather than pulled from npm on purpose: the project pins its
 * dependencies through bun.lock, and the whole limiter is smaller than the
 * lockfile churn adding one would cost. It follows the shape of the bcrypt
 * throttle in middlewares/password.js, which solves the same problem one layer
 * further in.
 *
 * The window is fixed, not sliding, so a caller can burst up to 2x `limit`
 * across a window boundary. That is an accepted trade for O(1) memory per
 * client: this exists to stop a stranger monopolising the box, not to meter
 * anything precisely.
 */
const DEFAULT_WINDOW_MS = 60000;
const MAX_TRACKED_CLIENTS = 10000;
const MS_PER_SECOND = 1000;

const DEFAULT_MESSAGE = "Too many requests. Please slow down and try again later";

export const createRateLimit = ({limit, windowMs = DEFAULT_WINDOW_MS, message = DEFAULT_MESSAGE}) => {
    const hits = new Map();

    const middleware = (req, res, next) => {
        const key = clientKey(req);
        const now = Date.now();
        const entry = hits.get(key);

        if (entry === undefined || now >= entry.resetAt) {
            // Evicting the oldest single entry bounds memory without handing an
            // attacker a way to wipe everyone else's counter by rotating IPs.
            if (hits.size >= MAX_TRACKED_CLIENTS) hits.delete(hits.keys().next().value);

            hits.set(key, {count: 1, resetAt: now + windowMs});
            return next();
        }

        entry.count += 1;

        if (entry.count > limit) {
            res.setHeader("Retry-After", String(Math.ceil((entry.resetAt - now) / MS_PER_SECOND)));
            return res.status(429).json({message});
        }

        return next();
    };

    /** Drops all counters. Exists so tests do not have to wait out the window. */
    middleware.reset = () => hits.clear();

    return middleware;
};
