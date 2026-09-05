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
import {basePath} from "@/common/utils/BasePath";

/**
 * The separator between a BASE_PATH prefix and the logical key it scopes.
 *
 * A colon, because normaliseBasePath in server/middlewares/basePath.js only
 * ever produces a leading-slash path segment for the prefix - one that cannot
 * itself contain a colon - so a scoped key can never collide with a bare key
 * that happens to start with the same characters.
 */
const BASE_PATH_KEY_SEPARATOR = ":";

/**
 * The storage key a logical key maps to under `prefix` - the seventh-pass
 * finding that two MySpeeds behind different BASE_PATH prefixes on one origin
 * shared `currentNode`, the preferences, the theme, the language and
 * `welcomeShown`, because every prefix read and wrote the same bare key.
 *
 * "" answers the bare key, byte for byte, rather than the composed form. That
 * is not a special case trimmed for tidiness: BASE_PATH defaults to "", so
 * every install before two of these ever shared an origin is on this branch,
 * and an upgrade must not reset the node, the theme, the language and the
 * welcome-dialog state such an install already chose. Only a non-empty prefix
 * - which cannot have existed before BASE_PATH did - ever sees a different key
 * than it always has.
 *
 * Exported as a pure function of `prefix` - not read off this module's own
 * `basePath` constant below - so storageBasePathIsolation.test.js can drive
 * every prefix directly. `basePath` is fixed for the life of the process at
 * this module's first import, so a test could not otherwise reach a second
 * prefix without reloading the module.
 */
export const scopedStorageKey = (prefix, key) =>
    prefix === "" ? key : `${prefix}${BASE_PATH_KEY_SEPARATOR}${key}`;

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
 *
 * `prefix` is the BASE_PATH prefix the keys are scoped under, and defaults to
 * this instance's own. Exported, and a parameter rather than a read of the
 * constant, for storageBasePathIsolation.test.js: `basePath` is fixed for the
 * life of the process at first import, so the only way a test can drive two
 * prefixes over one store is to be handed the prefix.
 */
export const backedBy = (name, prefix = basePath) => {
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

    /** One key, out of whichever of the store or its memory fallback `read` below decided to ask. */
    const rawRead = (resolved, key) => {
        if (resolved === null) return remembered(key);

        try {
            return resolved.getItem(key);
        } catch {
            return remembered(key);
        }
    };

    return {
        read: (key) => {
            const resolved = store();
            const scoped = scopedStorageKey(prefix, key);
            const scopedValue = rawRead(resolved, scoped);

            if (scopedValue !== null) return scopedValue;

            // A prefixed instance that has never written the scoped key yet -
            // every one of them, the first time this runs after the upgrade -
            // goes on reading the bare key it has always used, so the choice
            // survives until the next write lands under the scoped name. Where
            // there is no prefix, `scoped` already is `key`, and reading it a
            // second time would just repeat the lookup above.
            return scoped === key ? null : rawRead(resolved, key);
        },

        write: (key, value) => {
            const scoped = scopedStorageKey(prefix, key);
            memory.set(scoped, String(value));

            try {
                // Also thrown when the quota is exhausted, which a reader can
                // reach without having blocked anything.
                store()?.setItem(scoped, String(value));
            } catch {
                // The memory copy above is what keeps the session working.
            }
        },

        remove: (key) => {
            const resolved = store();

            // Both the scoped and the bare key are cleared, so a bare value
            // left over from before this existed - the one the read fallback
            // above would otherwise keep surfacing - cannot reappear once the
            // scoped key is gone. Where there is no prefix the two names are
            // the same key, so this clears it once.
            for (const target of new Set([scopedStorageKey(prefix, key), key])) {
                memory.delete(target);

                try {
                    resolved?.removeItem(target);
                } catch {
                    // Nothing to undo - the value is gone from the copy that is
                    // read first.
                }
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
