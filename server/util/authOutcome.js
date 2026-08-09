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
