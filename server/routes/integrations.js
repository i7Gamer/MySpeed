import express from 'express';
import * as integrations from '../controller/integrations.js';
import password from '../middlewares/password.js';
import previewReadOnly from '../middlewares/previewReadOnly.js';
import { validateInput } from '../controller/integrations.js';
import { isUntrustedReader } from '../util/untrustedReader.js';

const app = express.Router();

app.get("/", password(false), (req, res) => res.json(integrations.getIntegrations()));

/**
 * The stored rows, and on a demo the stored rows without their credentials.
 *
 * This answered with them until now: preview mode admits every caller and left
 * `req.viewMode` unset, so an anonymous visitor to a public demo was handed the
 * telegram bot token, the discord webhook URL, the influxdb token and the
 * healthchecks ping URL of whoever configured the instance. withoutSecrets was
 * already written, for the config export, and reached only that.
 *
 * Blanked rather than withheld, for the same reason the export blanks them: the
 * keys stay, so the dialog still renders the integration a demo is there to
 * show, and a reader can tell "configured, not shown" from "not configured".
 *
 * The read-only *password* holder never reaches this route at all - it is
 * mounted password(false), and the read-access branch needs password(true) -
 * so preview mode is the whole of what this covers today. The predicate rather
 * than an inline preview check regardless: the next route to be mounted
 * password(true) must not have to rediscover any of this.
 */
app.get("/active", password(false), async (req, res) => {
    const active = await integrations.getActive();

    return res.json(isUntrustedReader(req) ? integrations.withoutSecrets(active) : active);
});

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