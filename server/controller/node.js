import nodes from '../models/Node.js';
import { writePasswordHeaders } from '../util/passwordHeader.js';
import { checkNodeTarget } from '../util/safeUrl.js';
import { RESPONSE_TOO_LARGE, safeRequest } from '../util/safeRequest.js';
import { SERVER_BUSY } from '../util/authOutcome.js';
import { isBackupExportPath, relayPolicy } from '../util/backupPolicy.js';

// The child answers this while it already has as many password comparisons
// running for this caller as it will run at once. Transient by construction.
const SERVICE_UNAVAILABLE = 503;

// The far end produced something this relay will not pass on - a redirect, or
// an answer past the ceiling. The failure is the upstream's, not this server's.
const BAD_GATEWAY = 502;

/**
 * Whether a 503 came from MySpeed's own throttle rather than from whatever
 * sits in front of it.
 *
 * A reverse proxy fronting a stopped container answers 503 as well, and that
 * address will never start working - so telling the operator to retry would be
 * a lie with no end to it. Ours names itself.
 */
const isBusyResponse = (res) => {
    try {
        return JSON.parse(res.body.toString("utf8"))?.type === SERVER_BUSY;
    } catch {
        return false;
    }
};

const STATUS_TIMEOUT = 8000;

/**
 * A MySpeed node answers its own API; it has no reason to redirect. Following
 * one meant a node whose URL passed the address check could still hand the
 * server an internal destination of the remote host's choosing - and, through
 * the proxy, hand the body back to the caller. safeRequest never follows one.
 *
 * 304 is excluded, because it is not one. It carries no Location and means "the
 * copy you already have is still good" - the ordinary answer to a conditional
 * read. Classifying by range alone turned every revalidated proxied GET into
 * "The node redirected the request": Express puts an ETag on each proxied 200,
 * so the browser revalidates on its next poll, and a node whose answer had
 * stopped changing - i.e. for the whole gap between two speedtests - answered
 * 304 and the node view errored out.
 */
const NOT_MODIFIED = 304;

const isRedirect = (response) =>
    response.status >= 300 && response.status < 400 && response.status !== NOT_MODIFIED;

export const listAll = async () => await nodes.findAll()
    .then((result) => result.map((node) => ({...node, password: node.password !== null})));

export const create = async (name, url, password) => await nodes.create({name: name, url: url, password: password});

export const deleteNode = async (nodeId) => await nodes.destroy({where: {id: nodeId}});

export const getOne = async (nodeId) => await nodes.findOne({where: {id: nodeId}});

export const updateName = async (nodeId, name) => await nodes.update({name: name}, {where: {id: nodeId}});

export const updatePassword = async (nodeId, password) => await nodes.update({password: password}, {where: {id: nodeId}});

export const checkStatus = async (url, password) => {
    // Re-checked here rather than trusted from creation time: a stored row may
    // predate the guard, and a name that resolved somewhere harmless then can
    // resolve to loopback now. The connection itself is pinned by safeRequest.
    if (!(await checkNodeTarget(url)).safe) return "INVALID_URL";

    try {
        const res = await safeRequest(url + "/api/config", {
            headers: writePasswordHeaders(password),
            timeout: STATUS_TIMEOUT
        });

        if (isRedirect(res)) return "INVALID_URL";
        if (res.status === 401) return "PASSWORD_REQUIRED";
        /*
         * A node that is momentarily busy comparing passwords has a perfectly
         * good address, and calling it invalid sends the operator to check a
         * URL that was never wrong.
         *
         * The body has to say so, not just the status. A gateway in front of a
         * container that is down answers 503 too, and that URL will not start
         * working however long anyone retries - reporting it as busy would
         * invite exactly that. MySpeed names itself in the refusal, so the
         * discriminator is there to use.
         */
        if (res.status === SERVICE_UNAVAILABLE && isBusyResponse(res)) return "NODE_BUSY";
        if (res.status < 200 || res.status >= 300) return "INVALID_URL";

        const data = JSON.parse(res.body.toString("utf8"));
        if (!data.ping) return "INVALID_URL";
        if (data.viewMode) return "PASSWORD_REQUIRED";
        return "NODE_VALID";
    } catch {
        return "INVALID_URL";
    }
}

/**
 * Headers the proxy refuses to pass on.
 *
 * The last two are the caller's own credentials, which are the parent's and
 * mean nothing to the child - each instance keeps its own session map, so a
 * forwarded cookie could never authenticate anything there. routes/nodes.js
 * already strips the password headers and substitutes the node's own; `cookie`
 * carries exactly the same access now that `myspeed_session` is what the
 * browser holds, and `authorization` reaches the prometheus route, which
 * compares Basic auth against the parent's password hash. Left in, the
 * dashboard shipped a fresh copy of a seven-day full-access token to a third
 * host every few seconds for as long as a node stayed selected - usually over
 * plain http on the LAN.
 *
 * `accept-encoding` is here because this proxy cannot honour the answer.
 * safeRequest is raw node:http and never decodes a response, and only the two
 * headers below are copied back - so a browser's "gzip, deflate, br, zstd",
 * passed through to a child that sits behind a reverse proxy with compression
 * on, came back as compressed bytes that the parent then handed on labelled
 * application/json with nothing to say they were encoded.
 */
const SKIP_HEADERS = new Set(["host", "content-length", "connection", "cookie", "authorization",
    "accept-encoding"]);

// Enough for the caller to interpret the body it is handed. Everything else the
// child sends is the child's business and is dropped.
const FORWARDED_HEADERS = ["content-type", "content-disposition"];

/**
 * The content types a node is allowed to pick for a response served from *this*
 * origin.
 *
 * The type was copied through unchecked, which let the far end choose what the
 * parent's own origin serves. `text/html` renders as a document there, and the
 * CSP that would otherwise stop it says `script-src 'self'` - which the node's
 * scripts satisfy, because they are proxied through the parent too. A script
 * that runs as the parent can read GET /api/storage/config?includeSecrets=true
 * with the operator's HttpOnly session attached: the admin password hash, every
 * node password in clear, every integration token. Stripping the caller's
 * credentials at this boundary is undone by handing the far end the origin.
 *
 * These three are what the proxy is actually used for - the API answers JSON,
 * both exports answer CSV, and the binary fallback covers anything else a
 * future endpoint streams. Everything else is delivered, and delivered as
 * bytes: the body still passes through untouched, it just stops being something
 * the browser will execute.
 */
const SAFE_CONTENT_TYPES = ["application/json", "text/csv", "application/octet-stream"];
const OPAQUE_CONTENT_TYPE = "application/octet-stream";

const safeContentType = (value) => {
    // The media type on its own: "text/csv; charset=utf-8" is the ordinary
    // spelling and the parameters are not what is being decided here.
    const media = String(value).split(";")[0].trim().toLowerCase();

    return SAFE_CONTENT_TYPES.includes(media) ? value : OPAQUE_CONTENT_TYPE;
};

const serverError = (res) => res.status(500).json({message: "Internal server error"});

export const proxyRequest = async (url, req, res) => {
    // The address check happens on every proxied request, not once when the
    // node was added. Validating only at creation left every row written before
    // the guard existed - and every name that has since been repointed - as a
    // standing channel to whatever the server can reach.
    const target = await checkNodeTarget(url);
    if (!target.safe) return res.status(400).json({message: target.reason, type: "INVALID_URL"});

    const headers = Object.fromEntries(
        Object.entries(req.headers).filter(([k]) => !SKIP_HEADERS.has(k.toLowerCase()))
    );

    const body = req.method === "GET" || req.method === "HEAD" ? undefined : JSON.stringify(req.body ?? {});
    if (body !== undefined) headers["content-length"] = String(Buffer.byteLength(body));

    // A caller that has gone away must not keep the upstream request open
    // until its 15s timeout. This used to pass `req.signal`, but an Express
    // request carries no such property - the signal was always undefined and
    // the wiring never fired. The response's 'close' is the real event; it
    // also fires after a normal answer, which writableEnded tells apart.
    const disconnect = new AbortController();
    res.on("close", () => {
        if (!res.writableEnded) disconnect.abort();
    });

    try {
        /*
         * The backup exports get the import limit as their ceiling; everything
         * else keeps safeRequest's default. A node with a year of history
         * legitimately exports more than the default allows - the one endpoint
         * whose size grows with faithful use was the one this relay refused -
         * and the import limit is the natural bound, because an export too
         * large to ever restore is not a backup.
         *
         * req.originalUrl rather than req.path: by the time this handler runs,
         * req.path has been rewritten relative to the router's mount and no
         * longer names these paths.
         */
        const response = await safeRequest(url, {method: req.method, headers, body, signal: disconnect.signal,
            maxBytes: isBackupExportPath(req.originalUrl) ? relayPolicy.backupAllowanceBytes : undefined});

        if (isRedirect(response))
            return res.status(BAD_GATEWAY).json({message: "The node redirected the request", type: "INVALID_URL"});

        /*
         * A busy child is not a broken one.
         *
         * Every proxied request re-authenticates on the child by header - the
         * parent holds no session there and never can, since the proxy strips
         * cookies both ways - so a dashboard's own polling can briefly fill the
         * child's in-flight comparison slots. The child says so with a 503 and
         * a Retry-After, and flattening that into "Internal server error" threw
         * away both the reason and the retry, telling the operator their node
         * had failed when it was answering perfectly.
         *
         * The body has to say it is ours, for the reason checkStatus checks the
         * same thing: a gateway in front of a stopped container answers 503 as
         * well, and inviting a retry against an address that will never work is
         * worse than calling it the server error it is.
         */
        if (response.status === SERVICE_UNAVAILABLE && isBusyResponse(response)) {
            const retryAfter = response.headers["retry-after"];
            if (retryAfter) res.setHeader("Retry-After", retryAfter);

            return res.status(SERVICE_UNAVAILABLE)
                .json({message: "The node is busy. Please try again", type: SERVER_BUSY});
        }

        if (response.status >= 500) return serverError(res);

        for (const name of FORWARDED_HEADERS) {
            const value = response.headers[name];
            if (value) res.setHeader(name, name === "content-type" ? safeContentType(value) : value);
        }

        // Handed on verbatim. Forcing the body through JSON.parse turned every
        // non-JSON response - both CSV export endpoints - into a literal null.
        res.status(response.status).send(response.body);
    } catch (error) {
        // Nothing to answer when the failure is the caller having left.
        if (disconnect.signal.aborted) return;

        // The one failure worth naming: it looks exactly like a broken node
        // from the outside, and the fix - a smaller export, a direct download
        // from the child - is nothing "Internal server error" would suggest.
        if (error?.code === RESPONSE_TOO_LARGE)
            return res.status(BAD_GATEWAY).json({message: "The node's answer was too large to relay"});

        // Everything else stays a 500, but no longer a silent one.
        console.error(`Proxying to the node failed: ${error?.message ?? error}`);
        serverError(res);
    }
}
