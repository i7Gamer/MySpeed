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
 *
 * Except when the refusal wants a credential *this instance* can be given. The
 * redirect was written for a node that has gone away - the list is then the only
 * useful place to be - but every request made while a remote node is selected
 * travels through the parent, so the parent's own session expiring refuses them
 * too. Redirecting that pre-empted the password prompt, and the node list
 * refuses for the same reason and swallows it: the visitor landed on an empty
 * page with no error, no prompt, and a reload that returned them to it.
 *
 * A refusal the parent only relayed is the opposite case, and looks identical
 * from here - which is why the parent marks it. When a child rejects the
 * password stored for it, the box in front of the visitor is the wrong box:
 * login() posts to this instance's /api/session, the parent accepts its own
 * password, the page reloads, and the child refuses again. The right password
 * is called right for ever. The one thing that fixes it is updatePassword() on
 * the node list, so a node's own refusal goes back to being a redirect.
 */
const answerableHere = (reason) => reason?.credential && !reason.node;

export const failureOutcome = (storedNode, reason) =>
    ({redirectToNodes: isRemoteNode(storedNode) && !answerableHere(reason)});

/**
 * Whether a session may reach the admin controls.
 *
 * The header's admin login exchanges the password for a session and then
 * re-reads /api/config to see what that session is worth: read-level access
 * authenticates, but not for the controls the dialog was opened to reach, so it
 * counts as a refusal there.
 *
 * That judgement was `!config?.viewMode`, which is true of every answer that is
 * not an admin config - including no answer at all. checkConfig calls `.json()`
 * without asserting the status and the call site catches into null, so a 401
 * body, a 503 from a proxy in front of a stopped container, and a request that
 * threw each read as a successful admin sign-in: the prompt closed, the
 * dashboard showed its admin controls, and every one of them failed.
 *
 * Only an instance that answered has said anything about the session, and what
 * it said is `viewMode: false`. Everything else is not a grant.
 */
export const grantsAdminAccess = (config) => config?.viewMode === false;
