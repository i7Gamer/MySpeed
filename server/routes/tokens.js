import express from 'express';
import * as tokens from '../controller/tokens.js';
import password from '../middlewares/password.js';
import previewReadOnly from '../middlewares/previewReadOnly.js';
import { createQueue } from '../util/serialiseQueue.js';

const app = express.Router();
const createInOrder = createQueue();

/**
 * Sealed on a demo, reads included. A demo's password gate admits everyone,
 * so a read-only guard would hand every visitor the names and last uses of
 * whatever tokens the operator holds.
 */
const DEMO_MESSAGE = "For security reasons, API tokens cannot be managed in preview mode";

app.get("/", password(false), previewReadOnly.blocking(DEMO_MESSAGE), async (req, res) => {
    res.json(await tokens.list());
});

app.post("/", password(false), previewReadOnly.blocking(DEMO_MESSAGE), async (req, res) => {
    const problem = tokens.tokenNameProblem(req.body?.name);
    if (problem !== null) return res.status(400).json({message: problem});

    return createInOrder(async () => {
        if (await tokens.count() >= tokens.MAX_TOKENS)
            return res.status(400).json({message: `An instance holds at most ${tokens.MAX_TOKENS} API tokens. Revoke one first`});

        // The one answer that ever carries the secret.
        res.status(201).json(await tokens.create(req.body.name));
    });
});

app.delete("/:id", password(false), previewReadOnly.blocking(DEMO_MESSAGE), async (req, res) => {
    const id = Number(req.params.id);

    if (!Number.isInteger(id) || !(await tokens.remove(id)))
        return res.status(404).json({message: "The token does not exist"});

    res.json({message: "The token has been revoked"});
});

export default app;
