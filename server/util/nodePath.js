/**
 * The path a proxied request asks the child node for.
 *
 * Only the prefix that opens the path is folded back to /api. The replace
 * this grew out of matched the literal decoded id anywhere in the string: a
 * node id that arrived percent-encoded - `/api/nodes/%35/config` - is `5` in
 * req.params but spelled as sent in the path, so nothing matched and the
 * child was asked for `/api/nodes/%35/config`, which its SPA fallback
 * answered with the index page.
 */
// Case-insensitive, as Express's own routing is: a request spelled
// /API/nodes/1/config reaches the proxy handler, and a fold that then did
// not match asked the child for /API/nodes/1/config - which the child's
// proxy, if it has a node 1 of its own, sends on again, unshortened.
const NODE_PREFIX = /^\/api\/nodes\/[^/?#]+/i;

const API_ROOT = "/api";

export const childPath = (path) => path.replace(NODE_PREFIX, API_ROOT);

// Never dialled: it only gives the parser an origin to resolve the path
// against, and `.invalid` is reserved so that it cannot name a real host.
const PLACEHOLDER_ORIGIN = "http://node.invalid";

/**
 * Whether the path the child is about to be asked for is still inside its API.
 *
 * The proxy joins this path to the node's address as text, and safeRequest
 * parses the result - which resolves dot segments. `/api/nodes/5/../../x`
 * folds to `/api/../../x` above and leaves here as `/x`: a request outside the
 * API this route exists to reach, carrying the node's stored password.
 *
 * Decided by the same parser the request goes through rather than by looking
 * for `..`, because that parser is what defines a dot segment: it reads `%2e`
 * as a dot and, for http, a backslash as a slash, and a check that knew fewer
 * spellings than it does would wave through exactly the ones it missed.
 */
export const staysWithinApi = (path) => {
    if (typeof path !== "string" || !path.startsWith("/")) return false;

    try {
        const {pathname} = new URL(PLACEHOLDER_ORIGIN + path);

        return pathname === API_ROOT || pathname.startsWith(`${API_ROOT}/`);
    } catch {
        return false;
    }
};
