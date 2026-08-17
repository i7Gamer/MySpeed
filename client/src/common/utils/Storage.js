/**
 * localStorage, for a browser that may refuse to hand it over.
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
const memory = new Map();

/**
 * Resolved per call rather than captured once.
 *
 * Permission can be granted mid-session - the Storage Access API, or the reader
 * changing the setting in another tab - and a handle captured at import would go
 * on using the fallback for the life of the page.
 */
const store = () => {
    try {
        // The property access is the part that throws, so it has to be inside
        // the try. Touching a key as well, because a browser can hand back an
        // object whose methods then refuse.
        const local = globalThis.localStorage;
        local.getItem("__probe");
        return local;
    } catch {
        return null;
    }
};

export const readStored = (key) => {
    const local = store();
    if (local === null) return memory.has(key) ? memory.get(key) : null;

    try {
        return local.getItem(key);
    } catch {
        return memory.has(key) ? memory.get(key) : null;
    }
};

export const writeStored = (key, value) => {
    memory.set(key, String(value));

    try {
        // Also thrown when the quota is exhausted, which a reader can reach
        // without having blocked anything.
        store()?.setItem(key, String(value));
    } catch {
        // The memory copy above is what keeps the session working.
    }
};

export const removeStored = (key) => {
    memory.delete(key);

    try {
        store()?.removeItem(key);
    } catch {
        // Nothing to undo - the value is gone from the copy that is read first.
    }
};
