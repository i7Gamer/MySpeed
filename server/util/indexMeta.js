/**
 * The one thing in index.html that BASE_PATH cannot reach on its own.
 *
 * Every asset reference the bundler processes is emitted relative to wherever
 * index.html was served from, which is what lets the client work out its own
 * prefix at runtime and why the server needs no matching client setting. A
 * `<meta content="/api/...">` is not an asset reference: vite leaves it exactly
 * as it was written, so on an instance behind `PathPrefix('/internet_speed')`
 * the OpenGraph image pointed at the proxy's root, outside the application
 * entirely, and every link preview showed whatever lives there instead.
 *
 * Relative would not do. A crawler resolves the value against the page it was
 * handed, so `./api/opengraph/image` is right for `/internet_speed/` and wrong
 * for every route under it. The prefix is known here and nowhere else.
 *
 * A protocol-relative `//host/...` is left alone: it already names a host.
 */
const ROOTED_META = /(<meta\b[^>]*\bcontent=")\/(?!\/)/gi;

/**
 * @param prefix  normaliseBasePath's spelling: "" or "/internet_speed".
 * @returns the html, unchanged where there is no prefix - which is every
 * ordinary install, and the case that must stay byte-for-byte what the build
 * produced.
 */
export const withBasePathMeta = (html, prefix) =>
    prefix ? String(html).replace(ROOTED_META, `$1${prefix}/`) : String(html);
