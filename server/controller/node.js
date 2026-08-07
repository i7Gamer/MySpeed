import nodes from '../models/Node.js';
import { writePasswordHeaders } from '../util/passwordHeader.js';

const STATUS_TIMEOUT = 8000;

export const listAll = async () => await nodes.findAll()
    .then((result) => result.map((node) => ({...node, password: node.password !== null})));

export const create = async (name, url, password) => await nodes.create({name: name, url: url, password: password});

export const deleteNode = async (nodeId) => await nodes.destroy({where: {id: nodeId}});

export const getOne = async (nodeId) => await nodes.findOne({where: {id: nodeId}});

export const updateName = async (nodeId, name) => await nodes.update({name: name}, {where: {id: nodeId}});

export const updatePassword = async (nodeId, password) => await nodes.update({password: password}, {where: {id: nodeId}});

export const checkStatus = async (url, password) => {
    try {
        const res = await fetch(url + "/api/config", {
            headers: writePasswordHeaders(password),
            signal: AbortSignal.timeout(STATUS_TIMEOUT)
        });

        if (res.status === 401) return "PASSWORD_REQUIRED";
        if (!res.ok) return "INVALID_URL";

        const data = await res.json();
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
    const headers = Object.fromEntries(
        Object.entries(req.headers).filter(([k]) => !SKIP_HEADERS.has(k.toLowerCase()))
    );

    try {
        const response = await fetch(url, {
            method: req.method,
            headers,
            body: req.method === "GET" ? undefined : JSON.stringify(req.body),
            signal: req.signal
        });

        if (response.status >= 500) return serverError(res);

        for (const name of FORWARDED_HEADERS) {
            const value = response.headers.get(name);
            if (value) res.setHeader(name, value);
        }

        // Handed on verbatim. Forcing the body through JSON.parse turned every
        // non-JSON response - both CSV export endpoints - into a literal null.
        res.status(response.status).send(Buffer.from(await response.arrayBuffer()));
    } catch {
        serverError(res);
    }
}
