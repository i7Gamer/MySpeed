/**
 * Integrations are notified from inside the speedtest run, which holds the
 * run lock until every one of them has answered. A webhook pointed at a host
 * that accepts the connection and then says nothing would otherwise hang that
 * run forever, so every outbound post carries this deadline.
 *
 * getJson takes it only as the default for a caller that has no opinion. The
 * run lock says nothing about a GET, so a caller whose request is slower or
 * more expendable than a webhook is expected to name its own deadline instead.
 */
const OUTBOUND_TIMEOUT = 10000;

const jsonInit = (method, json, headers) => ({
    method,
    headers: {"content-type": "application/json", ...headers},
    body: JSON.stringify(json),
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

export const postJson = async (url, json, {headers, activity} = {}) => {
    try {
        const res = await fetch(url, jsonInit("POST", json, headers));
        activity?.(res.ok ? undefined : true);
        if (!res.ok) report(url, `HTTP ${res.status}`);
        return res;
    } catch (e) {
        activity?.(true);
        report(url, e);
        return null;
    }
};

export const postText = async (url, body, {headers, activity} = {}) => {
    try {
        const res = await fetch(url, {
            method: "POST",
            headers: {"content-type": "text/plain; charset=utf-8", ...headers},
            body,
            signal: AbortSignal.timeout(OUTBOUND_TIMEOUT)
        });
        activity?.(res.ok ? undefined : true);
        if (!res.ok) report(url, `HTTP ${res.status}`);
        return res;
    } catch (e) {
        activity?.(true);
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
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
};
