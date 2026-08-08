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

export const safeRequest = (url, {method = "GET", headers = {}, body, timeout = DEFAULT_TIMEOUT, signal} = {}) =>
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

            response.on("data", (chunk) => chunks.push(chunk));
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
