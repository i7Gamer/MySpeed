import crypto from 'node:crypto';

/**
 * Browser sessions, so the client never has to keep the password.
 *
 * It used to hold the password itself in localStorage and replay it on every
 * request. That put the actual credential somewhere any script on the page can
 * read, kept it there indefinitely, and gave no way to revoke it - changing the
 * password left every browser still holding the old one in clear.
 *
 * A session is a random token handed back in an HttpOnly cookie: script cannot
 * read it, it expires, and it can be revoked server-side. The x-password header
 * still works, because scripts and integrations authenticate that way.
 *
 * Deliberately in memory. Sessions do not survive a restart, which costs a
 * re-login and means nothing on disk is worth stealing.
 */
const TOKEN_BYTES = 32;
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_SESSIONS = 1000;

export const SESSION_COOKIE = "myspeed_session";
export const SESSION_MAX_AGE_SECONDS = SESSION_TTL_MS / 1000;

const sessions = new Map();

const prune = (now) => {
    for (const [token, expiresAt] of sessions)
        if (now >= expiresAt) sessions.delete(token);
};

export const createSession = () => {
    const now = Date.now();
    prune(now);

    // Bounded so a login loop cannot grow the map without limit. The oldest
    // goes first, which is the least likely to still be in use.
    if (sessions.size >= MAX_SESSIONS) sessions.delete(sessions.keys().next().value);

    const token = crypto.randomBytes(TOKEN_BYTES).toString("hex");
    sessions.set(token, now + SESSION_TTL_MS);

    return token;
};

export const isValidSession = (token) => {
    if (typeof token !== "string" || token === "") return false;

    const expiresAt = sessions.get(token);
    if (expiresAt === undefined) return false;

    if (Date.now() >= expiresAt) {
        sessions.delete(token);
        return false;
    }

    return true;
};

export const destroySession = (token) => {
    if (typeof token === "string") sessions.delete(token);
};

/**
 * Revokes every session.
 *
 * Called whenever the password changes or is cleared: the whole point of not
 * storing the password is that access can be taken back, and leaving old
 * sessions alive would undo that.
 */
export const destroyAllSessions = () => sessions.clear();

/** Number of live sessions. For tests. */
export const sessionCount = () => {
    prune(Date.now());
    return sessions.size;
};
