/**
 * Where a request that was refused for want of a session says so.
 *
 * Sessions live in the server's memory, so a restart signs out every open tab
 * at once - and the background polls, which are most of what an open tab does,
 * read a refusal as "nothing new" and carry on showing what they had. The tab
 * froze on stale figures and never asked for the password again until someone
 * reloaded it. RequestUtil reports here; ConfigProvider, which owns the prompt,
 * listens. A module of its own rather than a context because the reporter is a
 * plain function with no React around it.
 */
const listeners = new Set();

/** Calls the listener on every reported refusal; returns its unsubscribe. */
export const onSessionExpired = (listener) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
};

export const reportSessionExpired = () => {
    // A copy, so a listener that unsubscribes while being told cannot skip the
    // one after it.
    for (const listener of [...listeners]) listener();
};
