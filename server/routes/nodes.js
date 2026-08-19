import express from 'express';
import * as nodes from '../controller/node.js';
import password from '../middlewares/password.js';
import previewReadOnly from '../middlewares/previewReadOnly.js';
import { passwordHeaderNames, writePasswordHeaders } from '../util/passwordHeader.js';
import { stripTrailingSlashes } from '../util/helpers.js';
import { checkNodeTarget } from '../util/safeUrl.js';
import { isUntrustedReader } from '../util/untrustedReader.js';
import { importBody } from './storage.js';

const app = express.Router();

// What the client sends to mean "stop holding a password for this node". The
// column stores null; this is the wire spelling, which the dialog's remove
// button is the only thing that produces.
const NO_NODE_PASSWORD = "none";

/**
 * The configured nodes, and to anyone but the operator none.
 *
 * Answered empty rather than refused: the client polls this on every config
 * change and a demo visitor is not in view mode, so a 403 would be an error
 * the node context has no branch for - and "this instance offers you no nodes"
 * is exactly what an empty list already means everywhere else.
 *
 * What it withholds by answering is the operator's own host names and addresses
 * - the same category as the `interface` adapter name the config route keeps
 * back - and the ids the proxy below would have to be asked for.
 *
 * isUntrustedReader rather than a preview check written out here: only the demo
 * case is reachable today, since a read-only password holder is refused by
 * password(false) before this runs, but the guard that gets written out by hand
 * is the guard that gets forgotten - which is the whole reason previewReadOnly
 * exists two doors down.
 */
app.get("/", password(false), async (req, res) => {
    if (isUntrustedReader(req)) return res.json([]);

    return res.json(await nodes.listAll());
});

app.put("/", password(false),
    previewReadOnly.saying("For security reasons, you can't create nodes in preview mode"),
    async (req, res) => {
    // Optional chaining because body-parser 2.x leaves req.body undefined on a
    // request it did not parse - 1.x defaulted it to {} - so the guard itself
    // threw and Express answered its generic 500 where this 400 was owed.
    if (!req.body?.name || !req.body?.url) return res.status(400).json({message: "Missing parameters", type: "MISSING_PARAMETERS"});

    const url = stripTrailingSlashes(req.body.url);

    // Checked before the fetch, not after: without it this endpoint made the
    // server request any URL the caller named, which turns response timing into
    // an internal port scanner and puts the cloud metadata service one request
    // away. There is no route that changes a node's URL later, so validating it
    // here covers the node for its whole life.
    const target = await checkNodeTarget(url);
    if (!target.safe) return res.status(400).json({message: target.reason, type: "INVALID_URL"});

    // Awaited rather than left as a floating .then(): a rejection in there -
    // from the database write, not the guarded fetch - was an unhandled
    // rejection that left the caller waiting until its own timeout.
    const result = await nodes.checkStatus(url, req.body.password);

    if (result === "INVALID_URL")
        return res.status(400).json({message: "Invalid URL", type: "INVALID_URL"});

    if (result === "PASSWORD_REQUIRED")
        return res.status(400).json({message: "Invalid password", type: "PASSWORD_REQUIRED"});

    if (result === "NODE_BUSY")
        return res.status(503).set("Retry-After", "1")
            .json({message: "The node is busy right now. Please try again", type: "NODE_BUSY"});

    res.json({id: (await nodes.create(req.body.name, url, req.body.password)).id, type: "NODE_CREATED"});
});

app.delete("/:nodeId", password(false),
    previewReadOnly.saying("For security reasons, you can't delete nodes in preview mode"),
    async (req, res) => {
    const node = await nodes.getOne(req.params.nodeId);
    if (node === null) return res.status(404).json({message: "Node not found"});

    await nodes.deleteNode(req.params.nodeId);
    res.json({message: "Node successfully deleted"});
});

app.patch("/:nodeId/name", password(false),
    previewReadOnly.saying("For security reasons, you can't update nodes in preview mode"),
    async (req, res) => {
    if (!req.body?.name) return res.status(400).json({message: "Missing parameters", type: "MISSING_PARAMETERS"});

    const node = await nodes.getOne(req.params.nodeId);
    if (node === null) return res.status(404).json({message: "Node not found"});

    await nodes.updateName(req.params.nodeId, req.body.name);
    res.json({message: "Node name successfully updated"});
});

app.patch("/:nodeId/password", password(false),
    previewReadOnly.saying("For security reasons, you can't update nodes in preview mode"),
    async (req, res) => {
    if (!req.body?.password) return res.status(400).json({message: "Missing parameters", type: "MISSING_PARAMETERS"});

    const node = await nodes.getOne(req.params.nodeId);
    if (node === null) return res.status(404).json({message: "Node not found"});

    // Forgetting a credential is not setting one, and needs no proof the far
    // end still accepts anything. Checked as though it were a password, the
    // sentinel was presented to the node as one - which nothing accepts, and
    // which the node whose own password has just been removed refuses hardest,
    // that being the only reason anyone sends this. So the clear was refused
    // 400 and the parent kept the stale credential while the client reported
    // success, and every poll afterwards authenticated with a password the node
    // no longer had.
    const clearing = req.body.password === NO_NODE_PASSWORD;

    if (!clearing) {
        const result = await nodes.checkStatus(node.url, req.body.password);

        if (result === "INVALID_URL")
            return res.status(400).json({message: "Invalid URL", type: "INVALID_URL"});

        if (result === "PASSWORD_REQUIRED")
            return res.status(400).json({message: "Invalid password", type: "PASSWORD_REQUIRED"});

        if (result === "NODE_BUSY")
            return res.status(503).set("Retry-After", "1")
                .json({message: "The node is busy right now. Please try again", type: "NODE_BUSY"});
    }

    await nodes.updatePassword(req.params.nodeId, clearing ? null : req.body.password);
    res.json({message: "Node password successfully updated", type: "PASSWORD_UPDATED"});
});

// importBody only does anything on the proxied import paths, where app.js
// deliberately skipped its 100kb parser; everywhere else the body has already
// been read and this is a no-op. Mounted after password(false), so the large
// limit stays behind authentication.
//
// previewReadOnly matters more here than on any route it guards directly: this
// one reaches a *different machine*, and it substitutes that machine's stored
// password on the way, so an unguarded verb would hand an anonymous demo
// visitor administrative access to a node the operator owns. It was the only
// mutating route in the app with no preview check of any kind - the four above
// it each had one, and it was missed because `app.all` looks like nothing in
// particular.
//
// Sealed rather than made read-only, which is what it was first given and not
// enough. A read here is not a read of the demo: line 117 attaches the node's
// own password, so the far end answers as though its operator had asked, and
// `GET /api/nodes/<id>/integrations/active` came back with that node's telegram
// token and webhook URLs in clear. Every redaction this instance applies to its
// own routes was reachable through this one, unredacted, because the machine
// answering could not tell it was serving a stranger.
/**
 * The node this request is for, resolved before its body is read.
 *
 * Ahead of importBody, and that is the whole point of it being a middleware
 * rather than the first line of the handler. The import paths are deliberately
 * exempted from the 100kb parser and given a 50mb one, and isLargeBodyPath
 * rewrites the node prefix away before deciding - so
 * `/api/nodes/<anything>/storage/config` is handed the large parser whether or
 * not that node exists. With the parser first, a 50mb body was buffered,
 * decoded and parsed into around 194 MiB of heap - some 300 MB resident once the
 * raw buffer and the decoded string are counted - and then thrown away by a 404
 * for an id nobody had to guess right.
 */
const resolveNode = async (req, res, next) => {
    const node = await nodes.getOne(req.params.nodeId);
    if (node === null) return res.status(404).json({message: "Node not found"});

    req.node = node;
    next();
};

app.all("/:nodeId/*route", password(false),
    previewReadOnly.blocking("For security reasons, you can't reach other nodes in preview mode"),
    resolveNode, importBody, async (req, res) => {
    const node = req.node;

    const url = node.url + req.originalUrl.replace("/api/nodes/" + req.params.nodeId, "/api");

    passwordHeaderNames.forEach(name => delete req.headers[name]);
    Object.assign(req.headers, writePasswordHeaders(node.password));
    delete req.headers['host'];

    await nodes.proxyRequest(url, req, res);
});

export default app;