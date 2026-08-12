/**
 * A provider's server list, indexed by id, or null when the payload was not a
 * list at all.
 *
 * loadServers.js used `(data ?? []).map(...)`, which guards against null and
 * nothing else - and an API that answers 200 with `{"error": "Rate limit
 * exceeded"}` is not null, so .map ran on an object and threw. The rejection
 * was caught, but all it could say was "Could not load servers", which is what
 * a network failure says too, and the provider dialog was left with an empty
 * list until the next restart with nothing pointing at the real cause.
 *
 * Separate from loadServers.js because that module fetches at import time, so
 * it cannot be imported to be tested.
 */
export const serverListFrom = (data, format) => {
    if (!Array.isArray(data)) return null;

    return Object.fromEntries(data.map((row) => [row.id, format(row)]));
};
