/**
 * Integrations are notified from inside the speedtest run, which holds the
 * run lock until every one of them has answered. A webhook pointed at a host
 * that accepts the connection and then says nothing would otherwise hang that
 * run forever, so every outbound call carries its own deadline.
 */
const OUTBOUND_TIMEOUT = 10000;

const jsonInit = (method, json, headers) => ({
    method,
    headers: {"content-type": "application/json", ...headers},
    body: JSON.stringify(json),
    signal: AbortSignal.timeout(OUTBOUND_TIMEOUT)
});

// The failure is reported to the caller through `activity`, but it was
// otherwise invisible - a webhook that never worked looked identical to one
// that was never configured.
const report = (url, error) =>
    console.error(`Integration request to ${new URL(url).host} failed: ${error?.message ?? error}`);

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

export const getJson = async (url, {headers, signal} = {}) => {
    const res = await fetch(url, {headers, signal});
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
};
