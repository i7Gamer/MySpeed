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

/**
 * Which providers let a target say how its run is shaped, rather than only
 * where it measures.
 *
 * One today: the other three are hosted services that decide their own run.
 * Kept as a question rather than an equality test at the call sites, so a
 * second tunable provider is one line here rather than a grep.
 */
export const takesTuning = (provider) => provider === "iperf3";

/*
 * The bounds the server holds these to, copied for the same reason
 * iperfHostAccepted is: nothing in this client can reach the server's rule,
 * and a field the editor accepts but the door refuses is a save that fails
 * naming a value the operator is looking at. tests/client/tuningParity.test.js
 * runs this copy and the server's own over one table so the two cannot drift
 * in silence.
 *
 * The duration's ceiling is not arbitrary: a run is armed with the CLI's own
 * timeout per invocation, and a minute of transfer plus the omitted
 * slow-start still leaves that timeout most of its headroom.
 */
const MIN_DURATION_SECONDS = 5;
const MAX_DURATION_SECONDS = 60;
const MIN_STREAMS = 1;
const MAX_STREAMS = 32;
const MIN_BITRATE_MBPS = 1;
const MAX_BITRATE_MBPS = 10000;

// Blank is not a bad value - it is the field left alone, which stores null and
// runs the registry's own default. Everything else must be a whole number
// inside the bounds: iperf3 takes -t and -P as integers, and 7.5 seconds
// reaches the CLI as an argument it refuses.
const withinBounds = (value, min, max) => {
    if (value === "" || value === null || value === undefined) return true;

    const figure = Number(value);

    return Number.isInteger(figure) && figure >= min && figure <= max;
};

export const durationAccepted = (value) => withinBounds(value, MIN_DURATION_SECONDS, MAX_DURATION_SECONDS);

export const streamsAccepted = (value) => withinBounds(value, MIN_STREAMS, MAX_STREAMS);

/**
 * The rate a UDP run sends at - the one field here where blank is not a valid
 * answer.
 *
 * iperf3's own default is 1 Mbit/s and nothing in its output says it was a
 * default: a capture measured 1.04 Mbit/s on the same loopback that measured
 * 99.2 when asked for 100. So an unnamed rate is not "inherit something
 * sensible", it is a gigabit line recorded as a megabit forever, and the door
 * refuses it - which means the button must too.
 *
 * Asked with the mode, because off it is not a field at all: the editor does
 * not draw it and the body drops whatever was left in it.
 */
export const bitrateAccepted = (value, udp) =>
    !udp || (value !== "" && value !== null && value !== undefined
        && withinBounds(value, MIN_BITRATE_MBPS, MAX_BITRATE_MBPS));

/**
 * Whether the run-shape fields the editor is actually DRAWING are acceptable.
 *
 * Asked of the provider and the mode rather than of the values alone, because
 * a field that is not on the screen cannot be corrected on it. Both ways of
 * getting one there are ordinary use, and both left the button dead with
 * nothing marked and no control that could revive it:
 *
 * - type 50 streams, then switch UDP on. The stream input is replaced by the
 *   bitrate, because a UDP run on this build carries one stream - so the 50
 *   is still refused and no longer anywhere.
 * - switch UDP on under iperf3, then change the provider to ookla. The whole
 *   run-settings block unmounts with the blank bitrate still refused inside
 *   it.
 *
 * The values themselves are not cleared, deliberately: switching back must
 * return the operator to what they typed. targetBody is what stops them
 * travelling - it nulls every field this returns true in spite of - so the
 * body the button now permits is exactly the one the door accepts, which
 * tuningParity asserts over the whole table.
 */
export const tuningAccepted = ({provider, iperfDuration, iperfStreams, iperfUdp, iperfBitrate}) => {
    if (!takesTuning(provider)) return true;

    return durationAccepted(iperfDuration)
        && (Boolean(iperfUdp) || streamsAccepted(iperfStreams))
        && bitrateAccepted(iperfBitrate, iperfUdp);
};

// The bounds themselves, for the inputs that state them to the operator: a
// spinner that steps past what the door takes is a control that offers a
// refusal.
export const TUNING_BOUNDS = {
    duration: {min: MIN_DURATION_SECONDS, max: MAX_DURATION_SECONDS},
    streams: {min: MIN_STREAMS, max: MAX_STREAMS},
    bitrate: {min: MIN_BITRATE_MBPS, max: MAX_BITRATE_MBPS}
};
