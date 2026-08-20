/**
 * Why a request was refused, in a form the client can switch on.
 *
 * A 401 is not one situation. An instance with no password refuses network
 * callers until they present the setup token from its log; an instance with one
 * refuses a wrong password; and either refuses everything for a minute once too
 * many have been rejected. All three used to arrive as a bare 401, so the
 * interface asked the same question every time - "your password" - of an
 * operator who did not have one and had no way to learn that a token existed.
 *
 * The accompanying `message` stays the human sentence and is still the only
 * thing a curl user sees; these are for the interface, which cannot switch on
 * prose that changes with every translation. The shape - {message, type} -
 * is the one routes/nodes.js already answers with.
 */
export const SETUP_TOKEN_REQUIRED = "SETUP_TOKEN_REQUIRED";
export const PASSWORD_REQUIRED = "PASSWORD_REQUIRED";
export const TOO_MANY_ATTEMPTS = "TOO_MANY_ATTEMPTS";

/**
 * Not a refusal of the credential at all: the server is already running as many
 * password comparisons for this caller as it will run at once, and this one
 * arrived while they were in flight. It clears the moment a slot frees.
 *
 * It carries a type for the same reason the three above do. Without one the
 * client falls through to its default and says "the password you entered is
 * incorrect" - which is exactly the misreport that splitting the throttle into
 * two counters was meant to end, reintroduced one layer further out.
 */
export const SERVER_BUSY = "SERVER_BUSY";

/**
 * Set on a refusal this instance relayed rather than raised.
 *
 * Every request made while a remote node is selected travels through here, so
 * the parent's own session expiring and the child rejecting its stored password
 * both arrive at the client as a 401 with the same body - the proxy hands the
 * child's answer on verbatim, which is what makes CSV exports work. The two
 * want opposite things: the first wants the password box, and the second wants
 * the node list, because the credential it refused is the one only
 * PATCH /api/nodes/:id/password can change. Told apart by the body they would
 * be indistinguishable; told apart by who answered, they are not.
 *
 * Mirrored in client/src/common/utils/AuthOutcome.js, which reads it.
 */
export const NODE_REFUSAL_HEADER = "x-myspeed-node-refused";
