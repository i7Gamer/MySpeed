import nodes from '../models/Node.js';
import { writePasswordHeaders } from '../util/passwordHeader.js';
import { checkNodeTarget } from '../util/safeUrl.js';
import { safeRequest } from '../util/safeRequest.js';

const STATUS_TIMEOUT = 8000;

/**
 * A MySpeed node answers its own API; it has no reason to redirect. Following
 * one meant a node whose URL passed the address check could still hand the
 * server an internal destination of the remote host's choosing - and, through
 * the proxy, hand the body back to the caller. safeRequest never follows one.
 */
const isRedirect = (response) => response.status >= 300 && response.status < 400;

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
        if (res.status < 200 || res.status >= 300) return "INVALID_URL";

        const data = JSON.parse(res.body.toString("utf8"));
        if (!data.ping) return "INVALID_URL";
        if (data.viewMode) return "PASSWORD_REQUIRED";
        return "NODE_VALID";
    } catch {
        return "INVALID_URL";
    }
}

const SKIP_HEADERS = new Set(["host", "content-length", "connection"]);

// Enough for the caller to interpret the body it is handed. Everything else the
// child sends is the child's business and is dropped.
const FORWARDED_HEADERS = ["content-type", "content-disposition"];

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

    try {
        const response = await safeRequest(url, {method: req.method, headers, body, signal: req.signal});

        if (isRedirect(response))
            return res.status(502).json({message: "The node redirected the request", type: "INVALID_URL"});

        if (response.status >= 500) return serverError(res);

        for (const name of FORWARDED_HEADERS) {
            const value = response.headers[name];
            if (value) res.setHeader(name, value);
        }

        // Handed on verbatim. Forcing the body through JSON.parse turned every
        // non-JSON response - both CSV export endpoints - into a literal null.
        res.status(response.status).send(response.body);
    } catch {
        serverError(res);
    }
}
