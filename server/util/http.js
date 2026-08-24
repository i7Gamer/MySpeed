import { checkOutboundTarget } from "./safeUrl.js";
// The deadline and the activity note both live beside each other now, because
// the SMTP integration needs both and neither is HTTP's to own alone.
// integrationActivity.js carries the reasoning for each.
import { OUTBOUND_TIMEOUT, noteActivity as note } from "./integrationActivity.js";

/**
 * Refuses a destination the server may not reach, as an ordinary send failure.
 *
 * Every URL these two helpers post to is one the operator typed into an
 * integration, and the only check on it was the field's own
 * /^https?:\/\/\S+$/ - which matches http://127.0.0.1:9200/ and
 * http://169.254.169.254/ as happily as anything else. The address guard that
 * covers the node endpoint never covered this path, and routes/nodes.js already
 * spells out why that matters.
 *
 * Reported the way a refused request is, rather than thrown: `activity` is what
 * turns a failure into "this endpoint is not working" on the integration card,
 * and a destination that cannot be reached is exactly that. getJson is left
 * alone deliberately - it fetches the GitHub release list and the provider
 * server lists, which are the project's own URLs and not the operator's.
 */
const refuseBlocked = (url, activity) => {
    const target = checkOutboundTarget(url);
    if (target.safe) return false;

    note(activity, true);
    report(url, target.reason);
    return true;
};

/**
 * Never follows a redirect, exactly as safeRequest never does for a node: the
 * address guard above runs on the stored URL, so a redirect is the far end
 * choosing a fresh destination - method and body intact - after that check has
 * passed. fetch's default is to follow; "error" turns the redirect into the
 * ordinary send failure the catch below already reports.
 */
const REFUSE_REDIRECTS = "error";

const jsonInit = (method, json, headers) => ({
    method,
    headers: {"content-type": "application/json", ...headers},
    body: JSON.stringify(json),
    redirect: REFUSE_REDIRECTS,
    signal: AbortSignal.timeout(OUTBOUND_TIMEOUT)
});

/**
 * The host to name in a failure report, or the URL itself when there is none.
 *
 * The report is built inside a catch, so parsing there could not be allowed to
 * throw: when the reason the request failed *was* an unparseable URL - an
 * unbracketed IPv6 literal is a plausible thing for a self-hoster to type, and
 * the stored value only has to match /https?:\/\/.+/ - the report threw again
 * from inside the handler. postJson then rejected instead of answering null,
 * and triggerEvent awaits each integration in turn, so every integration
 * registered after the broken one silently missed the event.
 */
const hostOf = (url) => {
    try {
        return new URL(String(url)).host;
    } catch {
        return String(url);
    }
};

// The failure is reported to the caller through `activity`, but it was
// otherwise invisible - a webhook that never worked looked identical to one
// that was never configured.
const report = (url, error) =>
    console.error(`Integration request to ${hostOf(url)} failed: ${error?.message ?? error}`);

/**
 * Finishes with a response body nobody is going to read.
 *
 * Read to the end rather than cancelled. Cancelling aborts the fetch, and an
 * HTTP client that has not received the whole message cannot reuse the
 * connection - it has to destroy the socket - so the next notification in the
 * same burst pays a fresh handshake. Worse, whether that happens is a matter of
 * timing rather than size: the abort is a no-op only if the whole response
 * already arrived in one pass, so a chunked reply or a slow hop loses the
 * socket even for a two-byte body. Draining completes the message and leaves
 * the connection reusable.
 *
 * Un-awaited, so an integration's reply never delays the run that triggered it,
 * and bounded by the same deadline the request carries - a hostile endpoint
 * cannot make this read forever.
 */
const drain = (res) => {
    try {
        Promise.resolve(res?.arrayBuffer?.()).catch(() => undefined);
    } catch {
        // A response object that offers no body at all.
    }
};

/**
 * What an outbound send reports back.
 *
 * The Response itself is deliberately not returned. Its body has been drained
 * by the time the caller sees it, so a Response is exactly the wrong shape to
 * hand over: the one thing that makes it useful is already spent, and a future
 * caller reaching for `res.json()` would get "body is unusable" from a file
 * they were not looking at. None of the eight integrations reads it - the
 * status has already become `activity` and a log line - so what is left is the
 * outcome, and that is what goes back. `null` on a thrown request, as before.
 */
const outcome = (res) => ({ok: res.ok, status: res.status});

export const postJson = async (url, json, {headers, activity} = {}) => {
    if (refuseBlocked(url, activity)) return null;

    try {
        const res = await fetch(url, jsonInit("POST", json, headers));
        note(activity, res.ok ? undefined : true);
        if (!res.ok) report(url, `HTTP ${res.status}`);
        drain(res);
        return outcome(res);
    } catch (e) {
        note(activity, true);
        report(url, e);
        return null;
    }
};

export const postText = async (url, body, {headers, activity} = {}) => {
    if (refuseBlocked(url, activity)) return null;

    try {
        const res = await fetch(url, {
            method: "POST",
            headers: {"content-type": "text/plain; charset=utf-8", ...headers},
            body,
            redirect: REFUSE_REDIRECTS,
            signal: AbortSignal.timeout(OUTBOUND_TIMEOUT)
        });
        note(activity, res.ok ? undefined : true);
        if (!res.ok) report(url, `HTTP ${res.status}`);
        drain(res);
        return outcome(res);
    } catch (e) {
        note(activity, true);
        report(url, e);
        return null;
    }
};

/**
 * The deadline is composed with the caller's signal, never replaced by it.
 * `signal` used to default to the timeout, which meant a caller that passed a
 * signal of its own to gain cancellation silently lost the deadline - and got
 * back exactly the hang the deadline was there to prevent.
 */
export const getJson = async (url, {headers, signal, timeout = OUTBOUND_TIMEOUT} = {}) => {
    const deadline = AbortSignal.timeout(timeout);
    const res = await fetch(url, {headers, signal: signal ? AbortSignal.any([signal, deadline]) : deadline});

    if (!res.ok) {
        // The refusal's body still has to be finished with. This threw with it
        // unread, which is the leak the drain above exists to close - one
        // function down, on the path a rate-limited GitHub release check takes
        // every time an unauthenticated caller asks for the version.
        drain(res);
        throw new Error(`HTTP ${res.status}`);
    }

    return res.json();
};
