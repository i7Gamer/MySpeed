import { isLocalNode } from "@/common/contexts/Node/nodeSelection";

/**
 * What the config provider should do with an answer from the server.
 *
 * This used to be a ternary inside the provider: navigate to /nodes, *or* store
 * the config. On a read-access instance with a remote node selected it took the
 * first branch, so setConfig was never called and `config` stayed {} - and
 * ConfigProvider sits above the router outlet, so it stayed {} for the rest of
 * the session rather than only until the navigation had finished. Both
 * HeaderComponent and NodeProvider bail on an empty config, so the header never
 * rendered and the node list was never fetched, on the very page the redirect
 * had just sent the visitor to.
 *
 * Storing the answer and deciding where to be are two answers, and this returns
 * both.
 */

/**
 * Whether the stored selection points at another instance.
 *
 * The sentinel and the comparison live in nodeSelection, which is the module
 * that owns which node is selected; this used to keep its own `"0"`.
 */
export const isRemoteNode = (storedNode) => !isLocalNode(storedNode);

export const configOutcome = (config, storedNode) => ({
    config,
    redirectToNodes: Boolean(config?.viewMode) && isRemoteNode(storedNode)
});

/**
 * The same decision for a config that could not be read at all. There is no
 * config to store, but a visitor who was looking at a remote node still belongs
 * on the node list rather than in front of an error about this instance.
 */
export const failureOutcome = (storedNode) => ({redirectToNodes: isRemoteNode(storedNode)});
