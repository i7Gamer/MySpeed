import http from 'node:http';
import https from 'node:https';
import { safeLookup } from './safeUrl.js';

/**
 * The HTTP client used for every request to a remote node.
 *
 * node:http rather than fetch, for one reason: it accepts a `lookup`, and fetch
 * does not. That hook is what pins the connection to an address the SSRF guard
 * has cleared. With fetch the only options were to check the name and then hand
 * the same name over to be resolved again - which a record change in between
 * defeats - or to take on a dependency for a custom dispatcher.
 *
 * Redirects are never followed. A MySpeed node answers its own API, so a
 * redirect is only ever a way for the far end to pick a destination after the
 * check has passed.
 */
const DEFAULT_TIMEOUT = 15000;

/**
 * The most of a node's answer this will hold in memory.
 *
 * Every chunk went into an array that nothing bounded, so how much the process
 * allocated was the far end's decision. A node is a machine an admin pointed at
 * rather than a trusted one, the server is a single process, and the proxy in
 * controller/node.js hands a caller's own request to it - so one node that has
 * been compromised, or is simply something else at that address by now, could
 * be made to take down the scheduler, the API and the database handle together.
 *
 * Ten megabytes is far above any real answer: these are JSON config and test
 * listings, and the largest of them is a few hundred kilobytes.
 */
export const MAX_RESPONSE_BYTES = 10 * 1024 * 1024;

export const safeRequest = (url, {method = "GET", headers = {}, body, timeout = DEFAULT_TIMEOUT, signal,
    maxBytes = MAX_RESPONSE_BYTES} = {}) =>
    new Promise((resolve, reject) => {
        let target;
        try {
            target = new URL(url);
        } catch (error) {
            return reject(error);
        }

        const transport = target.protocol === "https:" ? https : http;

        const request = transport.request(target, {method, headers, lookup: safeLookup, timeout}, (response) => {
            const chunks = [];
            let held = 0;

            response.on("data", (chunk) => {
                held += chunk.length;

                // Refused as the body arrives, not once it is assembled: a
                // check on the finished buffer would reject the request having
                // already paid the memory the ceiling exists to save.
                if (held > maxBytes) {
                    request.destroy(new Error(`Response too large: more than ${maxBytes} bytes`));
                    return;
                }

                chunks.push(chunk);
            });
            response.on("error", reject);
            response.on("end", () => resolve({
                status: response.statusCode,
                headers: response.headers,
                body: Buffer.concat(chunks)
            }));
        });

        request.on("error", reject);

        // `timeout` only arms the socket's idle timer; it does not end the
        // request. Without this a node that accepts the connection and then says
        // nothing would hold the caller open indefinitely.
        request.on("timeout", () => {
            request.destroy(new Error(`Timed out after ${timeout}ms`));
        });

        if (signal) {
            if (signal.aborted) return request.destroy(new Error("Request aborted"));
            signal.addEventListener("abort", () => request.destroy(new Error("Request aborted")), {once: true});
        }

        if (body !== undefined && body !== null) request.write(body);
        request.end();
    });
