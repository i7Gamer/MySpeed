/**
 * What each provider lets a target say about where it measures.
 *
 * The same three questions the server asks in targetProblem, kept here so the
 * editor draws exactly the fields that will be accepted - a field offered for
 * a provider the server refuses it on is a save that fails naming a value the
 * operator can see on screen.
 *
 * Its own module, apart from the provider cards, because the cards import
 * their logos: a plain .js file the suite can execute must not drag a .webp
 * into a test runner that has no idea what one is.
 */

// A server pinned out of the provider's own published list. Cloudflare has one
// endpoint, and an iperf3 server is named on the target itself.
export const takesServerId = (provider) => provider === "ookla" || provider === "libre";

// An address of its own: a LibreSpeed backend URL, or an iperf3 host and port.
export const takesEndpoint = (provider) => provider === "libre" || provider === "iperf3";

// And the one that cannot do without it. A libre target with no endpoint uses
// the public backend list; an iperf3 target with no host has nothing to
// measure against at all.
export const requiresEndpoint = (provider) => provider === "iperf3";
