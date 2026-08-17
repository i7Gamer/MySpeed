import { isPreviewInstance } from "./previewMode.js";

/**
 * Whether this caller is a reader the instance does not owe its operator's own
 * details to.
 *
 * Two kinds of caller are, and only one of them was ever marked. `req.viewMode`
 * is set by the password middleware for someone who gave the read-only
 * password. A visitor to a public demo is set nothing at all: preview mode
 * returns early from that middleware without touching the flag, so it stayed
 * undefined - which is falsy, which every `if (req.viewMode)` on a read route
 * took to mean "this caller is the operator". Three redactions were skipped at
 * once, on the one kind of instance whose address exists to be handed to
 * strangers: the stored integration credentials, the withheld config keys, and
 * the provider and external address of the line being measured.
 *
 * Deliberately *not* fixed by setting `req.viewMode = true` in preview mode.
 * That flag is echoed straight to the client in GET /api/config and drives the
 * whole interface - StatusUtil gates the run button on it, the dropdown hides
 * entries behind it, configOutcome redirects to the node list - so setting it
 * would have taken away the one thing a demo exists to let a visitor press.
 * "What the client may do" and "what the server will disclose" are two
 * questions, and the demo answers them differently; this is the second one.
 */
export const isUntrustedReader = (req) => Boolean(req?.viewMode) || isPreviewInstance();
