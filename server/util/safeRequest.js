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

/**
 * Names the one failure a caller can honestly explain, the way safeUrl's
 * EBLOCKEDADDRESS does: the proxy answers a too-large export differently from
 * a node that fell over, and a bare message string is nothing to branch on.
 */
export const RESPONSE_TOO_LARGE = "ERESPONSETOOLARGE";

const tooLargeError = (maxBytes) => {
    const error = new Error(`Response too large: more than ${maxBytes} bytes`);
    error.code = RESPONSE_TOO_LARGE;
    return error;
};

// Named like the errno codes a socket failure carries, so a caller sorting
// failures by code can file a request that got no answer beside a host that
// refused one, rather than parsing the message for it.
export const REQUEST_TIMED_OUT = "EREQUESTTIMEDOUT";

const timedOutError = (timeout) => {
    const error = new Error(`Timed out after ${timeout}ms`);
    error.code = REQUEST_TIMED_OUT;
    return error;
};

const DEFAULT_TRANSPORTS = {http, https};

/**
 * `transports` exists for the tests: Node fires the idle timer during a
 * connect and Bun does not, so the gap the answer deadline closes can only be
 * shown with a transport that behaves like Bun.
 */
export const safeRequest = (url, {method = "GET", headers = {}, body, timeout = DEFAULT_TIMEOUT, signal,
    maxBytes = MAX_RESPONSE_BYTES, transports = DEFAULT_TRANSPORTS} = {}) =>
    new Promise((resolve, reject) => {
        let target;
        try {
            target = new URL(url);
        } catch (error) {
            return reject(error);
        }

        const transport = target.protocol === "https:" ? transports.https : transports.http;

        // The deadline for an answer, kept here rather than left to `timeout`:
        // that is the socket's idle timer, and Bun never fires it while the
        // lookup or the connect is still waiting - a node whose host drops
        // packets held the caller until the kernel gave up, about 21s against
        // the 15s asked for. Cleared once the response begins, so a large
        // export that keeps arriving is not cut off; the idle timer covers a
        // body that stalls.
        let answerDeadline;
        const stopAnswerDeadline = () => clearTimeout(answerDeadline);

        const request = transport.request(target, {method, headers, lookup: safeLookup, timeout}, (response) => {
            stopAnswerDeadline();
            const chunks = [];
            let held = 0;

            response.on("data", (chunk) => {
                held += chunk.length;

                // Refused as the body arrives, not once it is assembled: a
                // check on the finished buffer would reject the request having
                // already paid the memory the ceiling exists to save.
                if (held > maxBytes) {
                    request.destroy(tooLargeError(maxBytes));
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

        request.on("error", (error) => {
            stopAnswerDeadline();
            reject(error);
        });

        // Only for a real bound: 0 switches the transport's idle timer off,
        // and as a deadline it would end every request on the next tick.
        if (Number.isFinite(timeout) && timeout > 0)
            answerDeadline = setTimeout(() => request.destroy(timedOutError(timeout)), timeout);

        // `timeout` only arms the socket's idle timer; it does not end the
        // request. Without this a node that accepts the connection and then says
        // nothing would hold the caller open indefinitely.
        request.on("timeout", () => {
            request.destroy(timedOutError(timeout));
        });

        if (signal) {
            if (signal.aborted) return request.destroy(new Error("Request aborted"));
            signal.addEventListener("abort", () => request.destroy(new Error("Request aborted")), {once: true});
        }

        if (body !== undefined && body !== null) request.write(body);
        request.end();
    });
