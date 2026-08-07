import express from 'express';
import password from '../middlewares/password.js';
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
    if (process.env.PREVIEW_MODE === "true") return res.json({local: version, remote: "0"});

    try {
        const data = await getJson(remote_url);
        res.json({local: version, remote: data.tag_name.replace("v", "")});
    } catch (e) {
        res.json({local: version, remote: "0"});
    }
});

app.get("/server/:provider", password(false), (req, res) => {
    if (!["ookla", "libre"].includes(req.params.provider))
        return res.status(400).json({message: "Invalid provider"});

    res.json(serverController.getByMode(req.params.provider));
});

app.get("/interfaces", password(false), async (req, res) => {
    res.json(interfaces.interfaces);
});

export default app;