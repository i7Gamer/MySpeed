const REQUEST_TIMEOUT = 10000;

export class RequestError extends Error {
    constructor(status, message) {
        super(message);
        this.name = "RequestError";
        this.status = status;
    }
}

const getApiRoot = () => {
    if (localStorage.getItem("currentNode") !== null && localStorage.getItem("currentNode") !== "0") {
        return "/api/nodes/" + localStorage.getItem("currentNode");
    } else return "/api";
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
    const response = await fetch("/api/session", {
        method: "POST",
        headers: {"content-type": "application/json"},
        body: JSON.stringify({password})
    });

    return response.ok;
}

export const logout = () => fetch("/api/session", {method: "DELETE"});

const STORED_PASSWORD_KEY = "password";

/**
 * Trades a password left over from the old scheme for a session, once.
 *
 * Without this every existing user would be signed out by the upgrade. The
 * stored password is removed either way: if it no longer works there is nothing
 * to keep, and leaving it behind would defeat the point of the change.
 */
export const migrateStoredPassword = async () => {
    const stored = localStorage.getItem(STORED_PASSWORD_KEY);
    if (stored === null) return;

    try {
        await login(stored);
    } finally {
        localStorage.removeItem(STORED_PASSWORD_KEY);
    }
}

// The session cookie travels on its own; nothing here needs to attach a
// credential. Node passwords are held server-side and injected by the proxy.
const getHeaders = () => ({"content-type": "application/json"});

// Run a plain request with all default values using the base path
export const baseRequest = async (path, method = "GET", body = {}, headers = {}) => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);

    try {
        return await fetch("/api" + path, {
            headers: {...getHeaders(), ...headers}, method,
            body: method !== "GET" ? JSON.stringify(body) : undefined,
            signal: controller.signal
        });
    } finally {
        clearTimeout(timeout);
    }
}

// Run a plain request with all default values
export const request = async (path, method = "GET", body = {}, headers = {}) => {
    return await fetch(getApiRoot() + path, {
        headers: {...getHeaders(), ...headers}, method,
        body: method !== "GET" ? JSON.stringify(body) : undefined
    });
}

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

// Download a specific file from the response output
export const downloadRequest = async (path, body = {}, headers = {}, fallbackName = "download") => {
    const file = await request(path, "GET", body, headers);
    await assertOk(file, path);

    const filename = filenameFromDisposition(file.headers.get('Content-Disposition')) ?? fallbackName;
    const blob = await file.blob();
    const url = window.URL.createObjectURL(blob);

    let element = document.createElement('a');
    element.setAttribute("download", filename);
    element.href = url;
    document.body.appendChild(element);
    element.click();
    element.remove();
    window.URL.revokeObjectURL(url);
}
