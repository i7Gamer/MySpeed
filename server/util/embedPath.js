/**
 * The cache key for an asset baked into the compiled binary.
 *
 * scripts/generate-client-embed.js keys its map by the filename as it sits on
 * disk - `/assets/my icon.png` - while `req.path` keeps whatever
 * percent-encoding the browser sent, and a browser encodes a space. The lookup
 * therefore missed for any asset whose name is not plain ASCII, and in binary
 * mode a miss falls through to the SPA fallback: the image request was answered
 * with index.html under a text/html content type, which presents as a routing
 * bug rather than a missing file.
 *
 * This lives here rather than inside the generated module because a generated
 * module cannot be unit-tested - it only exists after a binary build, and it
 * names files that only exist alongside it.
 */
export const decodeEmbedPath = (requestPath) => {
    if (typeof requestPath !== "string") return requestPath;

    try {
        return decodeURIComponent(requestPath);
    } catch {
        // A malformed escape is not a reason to answer 500. Falling back to the
        // raw path simply misses the cache, which is what an unknown url is
        // supposed to do.
        return requestPath;
    }
};
