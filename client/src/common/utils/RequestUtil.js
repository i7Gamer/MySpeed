import { SERVER_BUSY } from "@/common/utils/AuthOutcome";
import {readStored, removeStored} from "@/common/utils/Storage";

const REQUEST_TIMEOUT = 10000;

// How long a download's blob url is kept alive after the click that uses it.
// Long enough for any browser to have started reading it, short enough that the
// data is not held for the life of the page.
const BLOB_LIFETIME = 1000;

export class RequestError extends Error {
    constructor(status, message) {
        super(message);
        this.name = "RequestError";
        this.status = status;
    }
}

const getApiRoot = () => {
    if (readStored("currentNode") !== null && readStored("currentNode") !== "0") {
        return "/api/nodes/" + readStored("currentNode");
    } else return "/api";
}

/**
 * A fetch that cannot outlive REQUEST_TIMEOUT.
 *
 * One wrapper rather than a copy per helper, because the copies drifted: three
 * of the four calls in this file armed an AbortController and login() did not.
 * A refusal and a dropped connection both reject, so login's callers handled
 * those - but a request that is accepted and then never answered does neither,
 * and the one place login is awaited is the top level of index.jsx. Nothing
 * catches a promise that never settles: module evaluation stops there and the
 * render below it never runs, which is a blank page with nothing said.
 *
 * The bound guards the time to the response headers only. It is cleared once
 * fetch resolves, so reading a large export body afterwards is not raced.
 */
const timedFetch = async (url, init = {}) => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);

    try {
        return await fetch(url, {...init, signal: controller.signal});
    } finally {
        clearTimeout(timeout);
    }
}

/**
 * Signs in, so the browser holds a session cookie instead of the password.
 *
 * The password used to live in localStorage and be replayed on every request:
 * readable by any script on the page, kept indefinitely, and impossible to
 * revoke. The cookie the server sets in exchange is HttpOnly, so nothing here
 * can read it either - which is the point.
 */
export const login = async (password) => {
    const response = await timedFetch("/api/session", {
        method: "POST",
        headers: {"content-type": "application/json"},
        body: JSON.stringify({password})
    });

    if (response.ok) return {ok: true};

    // Why it was refused, not merely that it was: a mistyped setup token, a
    // wrong password and a lockout each want a different sentence, and the
    // first two want a different question. An unparseable body leaves `type`
    // absent, which asks for the password - what it did before any of this.
    const body = await response.json().catch(() => ({}));

    // Except when the server is not answering at all. A reverse proxy in front
    // of a stopped container answers 503 with no body of ours, and asking for
    // the password again - then calling it wrong when the retry fails
    // identically - is the loop this reports instead. ConfigContext makes the
    // same check on the config load; this is the half the operator types into.
    if (response.status === 503 && body?.type !== SERVER_BUSY)
        return {ok: false, unreachable: true};

    return {ok: false, type: body?.type};
}

export const logout = () => timedFetch("/api/session", {method: "DELETE"});

const STORED_PASSWORD_KEY = "password";

/**
 * Trades a password left over from the old scheme for a session, once.
 *
 * Without this every existing user would be signed out by the upgrade. The
 * stored password is removed either way: if it no longer works there is nothing
 * to keep, and leaving it behind would defeat the point of the change.
 */
export const migrateStoredPassword = async () => {
    const stored = readStored(STORED_PASSWORD_KEY);
    if (stored === null) return;

    try {
        await login(stored);
    } finally {
        removeStored(STORED_PASSWORD_KEY);
    }
}

// The session cookie travels on its own; nothing here needs to attach a
// credential. Node passwords are held server-side and injected by the proxy.
const getHeaders = () => ({"content-type": "application/json"});

// Run a plain request with all default values using the base path
export const baseRequest = async (path, method = "GET", body = {}, headers = {}) =>
    timedFetch("/api" + path, {
        headers: {...getHeaders(), ...headers}, method,
        body: method !== "GET" ? JSON.stringify(body) : undefined
    });

// Run a plain request with all default values. Bounded like the rest - without
// it a stalled connection, or a proxied node that accepted and then went quiet,
// hung the fetch forever with nothing said on screen.
export const request = async (path, method = "GET", body = {}, headers = {}) =>
    timedFetch(getApiRoot() + path, {
        headers: {...getHeaders(), ...headers}, method,
        body: method !== "GET" ? JSON.stringify(body) : undefined
    });

/**
 * Turns a non-2xx response into a RequestError carrying the server's own
 * message.
 *
 * Exported because the mutating helpers below deliberately hand back the raw
 * Response - several callers branch on res.ok themselves - which leaves the
 * ones that do not treating a refusal as a success. Those wrap their call in
 * this instead.
 */
export const assertOk = async (response, path) => {
    if (response.ok) return response;

    const body = await response.json().catch(() => null);
    throw new RequestError(response.status, body?.message ?? `Request to ${path} failed with status ${response.status}`);
}

/**
 * Pulls the filename out of a Content-Disposition header.
 *
 * Returns null when the header is absent or carries no filename - fetch only
 * rejects on network errors, so error responses reach here too and must not
 * blow up with a TypeError.
 */
export const filenameFromDisposition = (disposition) => {
    if (!disposition) return null;

    const match = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(disposition);
    if (!match) return null;

    // The server controls this value, but never let it escape the download name.
    const name = match[1].trim().split(/[/\\]/).pop();
    return name || null;
}

// Run a GET request and get the json of the response
export const jsonRequest = async (path, headers = {}) => {
    const response = await request(path, "GET", null, headers);
    await assertOk(response, path);
    return await response.json();
}

// Run a POST request and post some values
export const postRequest = async (path, body = {}, headers = {}) => {
    return await request(path, "POST", body, headers);
}

// Run a PUT request update a resource
export const putRequest = async (path, body = {}, headers = {}) => {
    return await request(path, "PUT", body, headers);
}

// Run a PATCH request update a resource
export const patchRequest = async (path, body = {}, headers = {}) => {
    return await request(path, "PATCH", body, headers);
}

// Run a DELETE request and delete a resource
export const deleteRequest = async (path, body = {}, headers = {}) => {
    return await request(path, "DELETE", body, headers);
}

/**
 * Downloads a file from the response output.
 *
 * The caller names the file when it cares, and the server names it otherwise.
 * That order used to be reversed, which left the export of "all time" carrying
 * the server's echo of the very wide window standing in for it - a name only
 * the client can improve on, since only it knows the range was a stand-in.
 * Callers that pass no name are unaffected: they still take the server's.
 */
export const downloadRequest = async (path, body = {}, headers = {}, preferredName = null) => {
    const file = await request(path, "GET", body, headers);
    await assertOk(file, path);

    const filename = preferredName
        ?? filenameFromDisposition(file.headers.get('Content-Disposition'))
        ?? "download";
    const blob = await file.blob();
    const url = window.URL.createObjectURL(blob);

    let element = document.createElement('a');
    element.setAttribute("download", filename);
    element.href = url;
    document.body.appendChild(element);
    element.click();
    element.remove();

    // Not in the same tick as the click. The click only *starts* the download -
    // the browser reads the blob afterwards - so revoking here dropped the only
    // reference to the data before it had been read, and the download landed as
    // "Failed - Network error". Chrome usually survives it by reading the blob
    // synchronously, which is why every export worked in development and failed
    // for anyone on Firefox or Safari. Still revoked, so the blob is not held
    // for the life of the page.
    setTimeout(() => window.URL.revokeObjectURL(url), BLOB_LIFETIME);
}
