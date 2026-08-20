import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/**
 * Teaches node the "@/" alias that vite.config.mjs gives the client.
 *
 * Client utilities import each other through it, so without this a test could
 * only reach the handful of modules that happen to import nothing. Note that it
 * resolves paths only - node still cannot parse JSX, so this reaches plain
 * modules, not components.
 */
const CLIENT_SRC = path.resolve(fileURLToPath(import.meta.url), "..", "..", "..", "client", "src");

const CANDIDATES = ["", ".js", ".mjs", ".json", "/index.js"];

const firstExisting = (base) => {
    for (const suffix of CANDIDATES) {
        const candidate = base + suffix;
        if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
    }
    return null;
};

// Stands in for a file inside the client package, so a retried lookup searches
// client/node_modules rather than the repository root's.
const CLIENT_PARENT = pathToFileURL(path.join(CLIENT_SRC, "index.js")).href;

const isBare = (specifier) => !specifier.startsWith(".") && !specifier.startsWith("/") && !specifier.includes("://");

export async function resolve(specifier, context, next) {
    if (specifier.startsWith("@/")) {
        const resolved = firstExisting(path.join(CLIENT_SRC, specifier.slice(2)));

        // Left to node when nothing matches, so the failure names the real
        // specifier instead of a path this hook invented.
        if (resolved) return next(pathToFileURL(resolved).href, context);
        return next(specifier, context);
    }

    try {
        return await next(specifier, context);
    } catch (error) {
        // The client keeps its own node_modules, but a test for client code
        // lives under tests/, so node looks for its dependencies in the root
        // package and does not find them. Retry as if the import had come from
        // inside the client.
        if (error?.code !== "ERR_MODULE_NOT_FOUND" || !isBare(specifier)) throw error;

        return next(specifier, {...context, parentURL: CLIENT_PARENT});
    }
}
