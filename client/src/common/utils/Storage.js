/**
 * The web storage APIs, for a browser that may refuse to hand them over.
 *
 * Reading `window.localStorage` throws a SecurityError rather than answering
 * null when the store is blocked - Chrome and Edge with third-party cookies off
 * (which Incognito is by default), and any browser set to block all site data.
 * The dashboard is embedded in cross-origin iframes on purpose: FRAME_ANCESTORS
 * exists so it can sit in Homepage or Heimdall, and that is exactly where a
 * partitioned or blocked store turns up.
 *
 * That throw used to land during module evaluation - i18n.js seeded the language
 * at the top level, ThemeContext read the theme in a useState initialiser - so
 * nothing rendered at all. Not a degraded page: a blank one, with no error
 * boundary above it to say why, because the router that carries the error
 * element had not been constructed yet.
 *
 * The fallback is a plain Map rather than nothing, so a blocked store costs the
 * reader their preferences surviving a reload and nothing else. Choosing a
 * language, a theme or a node all keep working for the life of the page.
 */
/**
 * One implementation for both stores, named rather than copied.
 *
 * sessionStorage is refused in exactly the same conditions as localStorage and
 * throws the same way, and PasswordSetup.js reached for it directly - so the
 * note a setup-token sign-in leaves threw a SecurityError out of a mount effect
 * on the dashboard header, where the only thing beneath it is the error
 * boundary. A second copy of this in that file would have been a second thing to
 * keep right.
 *
 * The fallback Map is per store, so the two cannot answer each other's keys.
 */
const backedBy = (name) => {
    const memory = new Map();

    /**
     * Resolved per call rather than captured once.
     *
     * Permission can be granted mid-session - the Storage Access API, or the
     * reader changing the setting in another tab - and a handle captured at
     * import would go on using the fallback for the life of the page.
     */
    const store = () => {
        try {
            // The property access is the part that throws, so it has to be
            // inside the try. Touching a key as well, because a browser can hand
            // back an object whose methods then refuse.
            const resolved = globalThis[name];
            resolved.getItem("__probe");
            return resolved;
        } catch {
            return null;
        }
    };

    const remembered = (key) => memory.has(key) ? memory.get(key) : null;

    return {
        read: (key) => {
            const resolved = store();
            if (resolved === null) return remembered(key);

            try {
                return resolved.getItem(key);
            } catch {
                return remembered(key);
            }
        },

        write: (key, value) => {
            memory.set(key, String(value));

            try {
                // Also thrown when the quota is exhausted, which a reader can
                // reach without having blocked anything.
                store()?.setItem(key, String(value));
            } catch {
                // The memory copy above is what keeps the session working.
            }
        },

        remove: (key) => {
            memory.delete(key);

            try {
                store()?.removeItem(key);
            } catch {
                // Nothing to undo - the value is gone from the copy that is read
                // first.
            }
        }
    };
};

const local = backedBy("localStorage");

export const readStored = local.read;
export const writeStored = local.write;
export const removeStored = local.remove;

/**
 * The same three for sessionStorage, which belongs to the one visit rather than
 * to the browser: PasswordSetup.js keeps its note there because the note belongs
 * to the sign-in that just happened, not to the reader for ever.
 */
const session = backedBy("sessionStorage");

export const readSession = session.read;
export const writeSession = session.write;
export const removeSession = session.remove;
