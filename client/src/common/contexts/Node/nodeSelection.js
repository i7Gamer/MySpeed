/**
 * Whether the node the app is pointed at still exists.
 *
 * Nothing reconciled the two. `currentNode` lives in the provider and in
 * localStorage, and RequestUtil routes every request in the app by it - so
 * deleting the node you were looking at left `getApiRoot()` returning
 * `/api/nodes/<a node that is gone>`. The node list itself is unaffected, since
 * that page and its cards use the fixed baseRequest, so nothing looked wrong
 * until the next navigation: from then on the status poll, the test list and
 * every dialog save went to a node the parent no longer knows, and the header
 * could not name where it was either - findNode returns undefined, so it fell
 * back to the generic title rather than saying anything was wrong.
 *
 * The delete path is not the only way in. A node removed from another browser,
 * or a config restored from a backup taken before it existed, leaves the same
 * stale id in localStorage - which is why this is a reconciliation against the
 * list rather than a line in the delete handler.
 */

/** The id that means "this instance", which is always there to fall back to. */
export const LOCAL_NODE = 0;

/**
 * The node the app should be pointed at, given the list the server just
 * returned. Returns `currentNode` unchanged when there is nothing to correct,
 * so the caller can compare and do nothing in the ordinary case.
 *
 * `loaded` because the list starts empty and is filled by a request: reconciling
 * before the answer arrives would send every session to the local instance on
 * page load, which is the one failure worse than the one being fixed. View mode
 * never fetches the list at all, so it never reconciles either.
 */
export const selectedNode = (currentNode, nodes, loaded) => {
    if (!loaded) return currentNode;
    if (currentNode === LOCAL_NODE) return currentNode;

    return nodes.some((node) => node.id === currentNode) ? currentNode : LOCAL_NODE;
};
