import express from 'express';
import password from '../middlewares/password.js';
import previewReadOnly from '../middlewares/previewReadOnly.js';
import { isPreviewInstance } from '../util/previewMode.js';
import * as serverController from '../controller/servers.js';
import * as interfaces from '../util/loadInterfaces.js';
import { getJson } from '../util/http.js';
// The import attribute is required by the ESM spec for JSON modules; bun is
// lenient about it, node is not.
import packageJson from '../../package.json' with { type: 'json' };

const version = packageJson.version;
const remote_url = "https://api.github.com/repos/i7Gamer/MySpeed/releases/latest";
const app = express.Router();

app.get("/version", password(false), async (req, res) => {
    // Not a disclosure decision: a public demo has no business calling out
    // to the GitHub API on every visitor's page load.
    if (isPreviewInstance()) return res.json({local: version, remote: "0"});

    try {
        const data = await getJson(remote_url);
        res.json({local: version, remote: data.tag_name.replace("v", "")});
    } catch {
        res.json({local: version, remote: "0"});
    }
});

app.get("/server/:provider", password(false), (req, res) => {
    if (!["ookla", "libre"].includes(req.params.provider))
        return res.status(400).json({message: "Invalid provider"});

    res.json(serverController.getByMode(req.params.provider));
});

/**
 * The host's network adapters, which are the operator's alone.
 *
 * GET /api/config withholds the *selected* `interface` from a caller who is not
 * the operator, and its comment gives the reason: an adapter name can say what
 * the host is, "vEthernet (External)" among them. Serving the whole list here
 * made that withholding worth nothing on a demo - the name was one request
 * away. The only consumer is the provider dialog, which preview mode already
 * refuses to open, and the client falls back to an empty list on a refusal.
 */
app.get("/interfaces", password(false),
    previewReadOnly.blocking("For security reasons, you can't list the network interfaces in preview mode"),
    async (req, res) => {
        res.json(interfaces.interfaces);
    });

export default app;