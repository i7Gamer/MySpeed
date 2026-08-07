import express from 'express';
import * as nodes from '../controller/node.js';
import password from '../middlewares/password.js';
import { passwordHeaderNames, writePasswordHeaders } from '../util/passwordHeader.js';
import { stripTrailingSlashes } from '../util/helpers.js';

const app = express.Router();

app.get("/", password(false), async (req, res) => {
    return res.json(await nodes.listAll());
});

app.put("/", password(false), async (req, res) => {
    if (process.env.PREVIEW_MODE === "true")
        return res.status(403).json({message: "For security reasons, you can't create nodes in preview mode"});

    if (!req.body.name || !req.body.url) return res.status(400).json({message: "Missing parameters", type: "MISSING_PARAMETERS"});

    const url = stripTrailingSlashes(req.body.url);

    // Awaited rather than left as a floating .then(): a rejection in there -
    // from the database write, not the guarded fetch - was an unhandled
    // rejection that left the caller waiting until its own timeout.
    const result = await nodes.checkStatus(url, req.body.password);

    if (result === "INVALID_URL")
        return res.status(400).json({message: "Invalid URL", type: "INVALID_URL"});

    if (result === "PASSWORD_REQUIRED")
        return res.status(400).json({message: "Invalid password", type: "PASSWORD_REQUIRED"});

    res.json({id: (await nodes.create(req.body.name, url, req.body.password)).id, type: "NODE_CREATED"});
});

app.delete("/:nodeId", password(false), async (req, res) => {
    if (process.env.PREVIEW_MODE === "true")
        return res.status(403).json({message: "For security reasons, you can't delete nodes in preview mode"});

    const node = await nodes.getOne(req.params.nodeId);
    if (node === null) return res.status(404).json({message: "Node not found"});

    await nodes.deleteNode(req.params.nodeId);
    res.json({message: "Node successfully deleted"});
});

app.patch("/:nodeId/name", password(false), async (req, res) => {
    if (process.env.PREVIEW_MODE === "true")
        return res.status(403).json({message: "For security reasons, you can't update nodes in preview mode"});

    if (!req.body.name) return res.status(400).json({message: "Missing parameters", type: "MISSING_PARAMETERS"});

    const node = await nodes.getOne(req.params.nodeId);
    if (node === null) return res.status(404).json({message: "Node not found"});

    await nodes.updateName(req.params.nodeId, req.body.name);
    res.json({message: "Node name successfully updated"});
});

app.patch("/:nodeId/password", password(false), async (req, res) => {
    if (process.env.PREVIEW_MODE === "true")
        return res.status(403).json({message: "For security reasons, you can't update nodes in preview mode"});

    if (!req.body.password) return res.status(400).json({message: "Missing parameters", type: "MISSING_PARAMETERS"});

    const node = await nodes.getOne(req.params.nodeId);
    if (node === null) return res.status(404).json({message: "Node not found"});

    const result = await nodes.checkStatus(node.url, req.body.password);

    if (result === "INVALID_URL")
        return res.status(400).json({message: "Invalid URL", type: "INVALID_URL"});

    if (result === "PASSWORD_REQUIRED")
        return res.status(400).json({message: "Invalid password", type: "PASSWORD_REQUIRED"});

    await nodes.updatePassword(req.params.nodeId, req.body.password === "none" ? null : req.body.password);
    res.json({message: "Node password successfully updated", type: "PASSWORD_UPDATED"});
});

app.all("/:nodeId/*route", password(false), async (req, res) => {
    const node = await nodes.getOne(req.params.nodeId);
    if (node === null) return res.status(404).json({message: "Node not found"});

    const url = node.url + req.originalUrl.replace("/api/nodes/" + req.params.nodeId, "/api");

    passwordHeaderNames.forEach(name => delete req.headers[name]);
    Object.assign(req.headers, writePasswordHeaders(node.password));
    delete req.headers['host'];

    await nodes.proxyRequest(url, req, res);
});

export default app;