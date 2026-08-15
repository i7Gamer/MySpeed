import express from 'express';
import * as integrations from '../controller/integrations.js';
import password from '../middlewares/password.js';
import previewReadOnly from '../middlewares/previewReadOnly.js';
import { validateInput } from '../controller/integrations.js';

const app = express.Router();

app.get("/", password(false), (req, res) => res.json(integrations.getIntegrations()));

app.get("/active", password(false), async (req, res) => res.json(await integrations.getActive()));

// Guarded before the lookup, not after it: a refusal that first reports
// whether an integration name exists tells a demo visitor the registry.
app.put("/:integrationName", password(false),
    previewReadOnly.saying("For security reasons, you can't create integrations in preview mode"),
    async (req, res) => {
    const integration = integrations.getIntegration(req.params.integrationName);
    if (!integration) return res.status(404).json({message: "Integration not found"});

    if (!req.body) return res.status(400).json({message: "Missing data"});

    const validatedInput = validateInput(req.params.integrationName, req.body);
    if (!validatedInput) return res.status(400).json({message: "Invalid data"});

    const id = await integrations.create(req.params.integrationName, validatedInput);
    return res.json({message: "Integration created", id});
});

app.patch("/:id", password(false),
    previewReadOnly.saying("For security reasons, you can't update integrations in preview mode"),
    async (req, res) => {
    if (!req.body) return res.status(400).json({message: "Missing data"});

    const integration = await integrations.getIntegrationById(req.params.id);
    if (!integration) return res.status(404).json({message: "Integration not found"});

    const validatedInput = validateInput(integration?.name, req.body, true);
    if (!validatedInput) return res.status(400).json({message: "Invalid data"});

    await integrations.patch(req.params.id, validatedInput);
    return res.json({message: "Integration updated"});
});

app.delete("/:id", password(false),
    previewReadOnly.saying("For security reasons, you can't delete integrations in preview mode"),
    async (req, res) => {
    const result = await integrations.deleteIntegration(req.params.id);
    if (result === null) return res.status(404).json({message: "Integration not found"});
    return res.json({message: "Integration deleted"});
});


export default app;