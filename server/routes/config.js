import express from 'express';
import * as config from '../controller/config.js';
import * as timer from '../tasks/timer.js';
import password from '../middlewares/password.js';

const app = express.Router();

app.get("/", password(true), async (req, res) => {
    let configValues = {};
    (await config.listAll()).forEach(row => {
        if (row.key !== "password" && !(req.viewMode && ["ooklaId", "libreId", "libreUrl", "cron", "scheduleOffset", "passwordLevel"].includes(row.key)))
            configValues[row.key] = row.value;
    });
    configValues['viewMode'] = req.viewMode;
    configValues['previewMode'] = process.env.PREVIEW_MODE === "true";

    if (process.env.PREVIEW_MODE === "true")
        configValues['previewMessage'] = String(process.env.PREVIEW_MESSAGE || "The owner of this instance has not provided a message");

    if (Object.keys(configValues).length === 0) return res.status(404).json({message: "Hmm. There are no config values. Weird..."});
    res.json(configValues);
});

// Clearing the password is its own operation. It used to be a PATCH carrying
// the sentinel "none", which meant a user who chose that as their password
// silently unprotected the instance instead.
app.delete("/password", password(false), async (req, res) => {
    if (process.env.PREVIEW_MODE === "true")
        return res.status(400).json({message: "You can't change the password in preview mode"});

    await config.clearPassword();
    res.json({message: "The password has been successfully removed"});
});

app.patch("/:key", password(false), async (req, res) => {
    const value = await config.validateInput(req.params.key, req.body?.value);
    if (Object.keys(value).length !== 1) return res.status(400).json({message: value});

    if (!await config.updateValue(req.params.key, value.value))
        return res.status(500).json({message: `Error updating the key '${req.params.key}'`});

    if (req.params.key === "cron") {
        timer.stopTimer();
        timer.startTimer(req.body.value.toString());
    }

    res.json({message: `The key '${req.params.key}' has been successfully updated`});
});

export default app;