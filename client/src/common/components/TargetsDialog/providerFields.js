/**
 * What each provider lets a target say about where it measures.
 *
 * The same questions the server asks in targetProblem, kept here so the
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

// A TCP port is sixteen bits, and iperfEndpointProblem refuses anything outside
// 1-65535 - 0 included, which is a port no server listens on.
const PORT_DIGITS = /^\d+$/;
const MAX_PORT = 65535;

/**
 * Whether an iperf3 target's `host[:port]` is one the server will take.
 *
 * A copy of iperfEndpointProblem (server/controller/targets.js), because
 * nothing in this client can reach it. Asking only whether the field is filled
 * in was not enough: an operator who typed "http://iperf.lan:5201" or
 * "10.0.0.5:0" was let past the chooser, and the refusal arrived on the *next*
 * step - where the host field is no longer rendered, there is no control that
 * lowers the step, and the dialog is mounted disableClose. A Done button that
 * failed every time, naming a field the wizard had taken off the screen, with
 * a page reload as the only way out.
 *
 * Copied rule for rule rather than approximated with a `host[:port]` pattern,
 * which is the tempting version and is wrong in the case that matters most
 * here - an operator pointing this at their own machine. "fd00::1" and
 * "[fd00::1]" are both hosts the server accepts (the last colon separates the
 * port, so an unbracketed literal has none, and splitEndpoint names the
 * bracketed spelling outright), and both are rejected by any such pattern.
 * That would trade a button that fails for a button that never enables at all,
 * which no reload escapes. tests/client/iperfHostParity.test.js runs this and
 * the server's copy over the same table so they cannot drift in silence.
 */
export const iperfHostAccepted = (endpoint) => {
    // Nullish-guarded where the server writes a bare String(): the server only
    // ever judges a value that arrived in a request body, and this judges a
    // field that may never have been typed in - String(undefined) is
    // "undefined", which is a perfectly well-shaped host.
    const value = String(endpoint ?? "").trim();

    if (value === "") return false;
    if (/\s/.test(value)) return false;

    // Brackets wrap the whole address once, with nothing but an optional
    // :port after the "]" - the rule the server states with its own message.
    const closing = value.indexOf("]");
    if (value.includes("[") || closing !== -1) {
        const wrapped = value.startsWith("[") && closing !== -1
            && value.lastIndexOf("[") === 0 && closing === value.lastIndexOf("]");
        const rest = closing === -1 ? "" : value.slice(closing + 1);

        if (!wrapped || (rest !== "" && !rest.startsWith(":"))) return false;
    }
    // A host and a port, not a URL: an iperf3 server is dialled directly and
    // there is no scheme to speak of, so a pasted address is refused here
    // rather than by the server two steps later.
    if (value.includes("/") || value.includes("@")) return false;

    // The last colon separates the port, so a bracketed IPv6 literal keeps its
    // own. iperfEndpointProblem and splitEndpoint both read it this way.
    const separator = value.lastIndexOf(":");
    const bracketed = value.startsWith("[");
    const hasPort = separator !== -1
        && (bracketed ? value.indexOf("]") < separator : value.indexOf(":") === separator);
    const host = hasPort ? value.slice(0, separator) : value;

    if (host === "" || host === "[]") return false;
    if (!hasPort) return true;

    const port = value.slice(separator + 1);

    return PORT_DIGITS.test(port) && Number(port) >= 1 && Number(port) <= MAX_PORT;
};
