import {t} from "i18next";

export const errors = () => ({
    "Network unreachable": t("errors.network_unreachable"),
    "Timeout occurred in connect": t("errors.took_too_long"),
    "permission denied": t("errors.no_permission"),
    "Resource temporarily unavailable": t("errors.resource_unavailable"),
    "No route to host": t("errors.no_route"),
    "Connection refused": t("errors.connection_refused"),
    "timed out": t("errors.timed_out"),
    "Could not retrieve or read configuration": t("errors.config"),
    // What the Ookla CLI reports when it cannot reach the chosen server from the
    // address it was bound to - most often a server that answers over IPv6 while
    // the test is pinned to an IPv4 interface.
    "Cannot open socket": t("errors.cannot_open_socket"),
    "Latency test failed": t("errors.latency_failed"),
    // Not a CLI's words but the server's own, normalised onto one wording by
    // server/util/providers/cliOutput.js however the provider phrased its
    // refusal. It is the failure the whole rate-limit backoff exists for, and
    // it was the only one of them with no entry here - so the single most
    // expected way for a test to fail rendered as the bare "Unknown error".
    "Too many requests": t("errors.rate_limited"),
    // The two MySpeed writes itself, in server/tasks/speedtest.js. Everything
    // above is text a third-party binary printed, which is why these were
    // missed: nobody thinks to register a sentence they wrote.
    "finished without reporting any measurement": t("errors.no_measurement"),
    "reported an impossible": t("errors.impossible_measurement"),
});

/**
 * The reason a test failed, in words, or null if it cannot be explained.
 *
 * Matched against the whole stored output rather than compared to it: what the
 * CLI printed is often several log records around the phrase that matters.
 *
 * Null rather than the raw text for anything unrecognised, because the caller
 * decides where it is going - the row has space for a sentence, and the detail
 * panel below it is where the unabridged output belongs.
 */
export const describeError = (error) => {
    if (!error) return null;

    for (const phrase in errors())
        if (error.includes(phrase)) return errors()[phrase];

    return null;
};
