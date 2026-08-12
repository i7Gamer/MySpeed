/**
 * Which name the header shows for the node currently being looked at.
 *
 * NodeContext stores currentNode as `parseInt(...) || 0`, so it is always a
 * number, and the header compared it with `currentNode === "0"` - strictly,
 * against a string. That is false for every value it has ever held, so the
 * local instance took the remote branch and looked itself up as node 0, which
 * is not a node any list contains. The `|| fallback` behind it produced the
 * right title anyway, which is why this went unnoticed: a type error with no
 * symptom, one findNode call away from having one.
 *
 * Compared as a string here, so it holds for both the number the context keeps
 * and the string localStorage hands back.
 */
const LOCAL_NODE = "0";

export const isLocalNode = (currentNode) =>
    currentNode === null || currentNode === undefined || String(currentNode) === LOCAL_NODE;

export const nodeTitle = (currentNode, findNode, fallback) => {
    if (isLocalNode(currentNode)) return fallback;

    return findNode(currentNode)?.name || fallback;
};
