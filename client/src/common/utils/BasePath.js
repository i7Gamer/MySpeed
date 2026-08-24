/**
 * Where this application is being served from - upstream #771.
 *
 * The server takes a configured BASE_PATH off the front of every request; this
 * is the other half, putting it back on the front of every URL the client emits.
 * Without it the browser asks the proxy for something outside the prefix and
 * gets whatever else is served there.
 *
 * Worked out at runtime rather than configured. A build ships as a Docker image
 * and as a compiled binary, so a prefix baked in at build time would mean one
 * image per deployment - and the operator has already told the server, which is
 * the only end that could not have worked it out for itself.
 *
 * The signal is where the entry module was loaded from. `base: "./"` in the vite
 * config makes index.html ask for `./assets/index-xxx.js`, so the browser
 * resolves that against wherever index.html itself was served - which is the
 * prefix, whether or not the proxy strips it before the server sees it.
 */

/**
 * The directories this application's entry module is ever served from: `assets`
 * in a build, `src` under the dev server.
 *
 * Named rather than "whatever directory it is in", because that assumption is
 * the whole of this function and a layout it does not cover has to be noticed
 * rather than guessed at.
 */
const ENTRY_DIRECTORIES = new Set(["assets", "src"]);

/**
 * The prefix implied by a module URL, or "" for the root.
 *
 * A layout this build does not produce answers "" - what every instance did
 * before this existed, and so the safe way to be wrong. Guessing would put a
 * directory name in front of every request the client makes.
 */
export const basePathFrom = (moduleUrl) => {
    let pathname;

    try {
        pathname = new URL(moduleUrl).pathname;
    } catch {
        return "";
    }

    const segments = pathname.split("/").filter(Boolean);

    // The file itself, then the directory it sits in - which has to be one this
    // application actually emits.
    segments.pop();
    if (!ENTRY_DIRECTORIES.has(segments.pop())) return "";

    return segments.length === 0 ? "" : `/${segments.join("/")}`;
};

/**
 * The prefix, computed once.
 *
 * No trailing slash, ever: it is concatenated with paths that start with one,
 * and "//api" is read by some proxies as a protocol-relative URL.
 */
export const basePath = basePathFrom(import.meta.url);

/** A path within the application, as a URL the browser should ask for. */
export const withBasePath = (path) => `${basePath}${path}`;
