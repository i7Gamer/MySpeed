import express from 'express';
import password from '../middlewares/password.js';
import previewReadOnly from '../middlewares/previewReadOnly.js';
import * as targets from '../controller/targets.js';
import { isUntrustedReader } from '../util/untrustedReader.js';

const app = express.Router();

// The fields a write may set. A whitelist rather than the body verbatim, for
// the reason importConfig skips unknown config keys: id, sortOrder and
// created are the server's to assign, and anything else in the body is a
// typo to ignore rather than a column to invent.
const WRITABLE = ["name", "provider", "serverId", "endpoint", "enabled", "alerts",
    "optimalPing", "optimalDownload", "optimalUpload"];

const writableFields = (body) =>
    Object.fromEntries(WRITABLE.filter((key) => key in (body ?? {})).map((key) => [key, body[key]]));

const ID = /^\d+$/;

app.get("/", password(true), async (req, res) => {
    const rows = await targets.listAll();

    // A viewer gets what the interface needs to label, order and grade - and
    // nothing that describes the operator's network. The endpoint can carry a
    // credential in its userinfo, and a server id says where the line is.
    res.json(isUntrustedReader(req) ? rows.map(targets.viewerFacing) : rows);
});

app.put("/", password(false), previewReadOnly, async (req, res) => {
    const fields = writableFields(req.body);

    const problem = targets.targetProblem(fields);
    if (problem !== null) return res.status(400).json({message: problem});

    // The name is the key the history backup files rows under, so two targets
    // wearing one would silently merge their histories on the next restore.
    if (await targets.nameTaken(fields.name))
        return res.status(400).json({message: "Another target already wears this name"});

    const row = await targets.create(fields);

    res.json({message: "The target has been created", id: row.id});
});

// Declared ahead of /:id, or "order" would be read as an id.
app.patch("/order", password(false), previewReadOnly, async (req, res) => {
    const ids = req.body?.ids;

    if (!Array.isArray(ids) || ids.some((id) => !ID.test(String(id))))
        return res.status(400).json({message: "You need to provide the target ids in order"});

    await targets.reorder(ids.map(Number));

    res.json({message: "The order has been updated"});
});

app.patch("/:id", password(false), previewReadOnly, async (req, res) => {
    if (!ID.test(req.params.id))
        return res.status(400).json({message: "You need to provide a numeric target id"});

    const current = await targets.getOne(Number(req.params.id));
    if (current === null) return res.status(404).json({message: "The target does not exist"});

    // Judged as the row it would become, not as the fragment that arrived:
    // a PATCH carrying only {endpoint} has to be held against the provider
    // it will run under.
    const merged = {...current, ...writableFields(req.body)};

    const problem = targets.targetProblem(merged);
    if (problem !== null) return res.status(400).json({message: problem});

    // Excluding the row itself, so keeping one's own name stays legal.
    if (await targets.nameTaken(merged.name, current.id))
        return res.status(400).json({message: "Another target already wears this name"});

    await targets.update(current.id, writableFields(req.body));

    res.json({message: "The target has been updated"});
});

app.delete("/:id", password(false), previewReadOnly, async (req, res) => {
    if (!ID.test(req.params.id))
        return res.status(400).json({message: "You need to provide a numeric target id"});

    if (await targets.getOne(Number(req.params.id)) === null)
        return res.status(404).json({message: "The target does not exist"});

    // The rows it measured keep their targetId: history is the history, and
    // the interface falls back to the provider label for an orphan.
    await targets.deleteTarget(Number(req.params.id));

    res.json({message: "The target has been deleted"});
});

export default app;
