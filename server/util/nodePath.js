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

export const childPath = (path) => path.replace(NODE_PREFIX, "/api");
