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
export const MAX_TRACKED_CLIENTS = 10000;
const MS_PER_SECOND = 1000;

const DEFAULT_MESSAGE = "Too many requests. Please slow down and try again later";

// `maxClients` and `now` are injected by the tests: the eviction policy is only
// observable at the cap, and a fixed window can only be stepped over with a
// clock. Both default to the real thing.
export const createRateLimit = ({limit, windowMs = DEFAULT_WINDOW_MS, message = DEFAULT_MESSAGE,
    maxClients = MAX_TRACKED_CLIENTS, now: clock = Date.now}) => {
    const hits = new Map();

    const middleware = (req, res, next) => {
        const key = clientKey(req);
        const now = clock();
        const entry = hits.get(key);

        if (entry === undefined || now >= entry.resetAt) {
            // Deleted before it is written back, so a client whose window just
            // reset moves to the back of the queue.
            //
            // The eviction below takes the entry at the front of the Map, which
            // is insertion order - and set() on a key that is already there
            // keeps its original position. So the longer a client had been
            // using the instance the nearer the front it stayed, permanently,
            // and filling the table evicted the most established caller rather
            // than an idle one: a fresh counter, and twice the limit, handed to
            // the one client that had earned neither, while callers that went
            // away hours ago sat behind them untouched. This is what makes the
            // order "not seen for longest" rather than "here longest".
            //
            // Only on this branch. A client under its limit is counted below
            // without being moved, which costs nothing and loses nothing: an
            // active client passes through here once a window regardless, and
            // that is often enough to keep it away from the front.
            hits.delete(key);

            // Evicting the oldest single entry bounds memory without handing an
            // attacker a way to wipe everyone else's counter by rotating IPs.
            if (hits.size >= maxClients) hits.delete(hits.keys().next().value);

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
