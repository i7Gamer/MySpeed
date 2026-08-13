import express from 'express';
import * as config from '../controller/config.js';
import * as timer from '../tasks/timer.js';
import password from '../middlewares/password.js';

const app = express.Router();

/**
 * What a read-only visitor is not told about the instance.
 *
 * `interface` is the operator's own network adapter - a name that can say what
 * the host is, "vEthernet (External)" for a Hyper-V machine among them. Only
 * the provider dialog reads it and view mode never opens that, so it was
 * disclosed to every visitor of a public dashboard for nothing.
 *
 * The quiet hours joined the list for the same reason as the cron: they
 * describe the schedule, and rather more personally - they are the nightly
 * hours the operator set aside, which on a publicly exposed instance says when
 * nobody is home. The pause dialog reads them, and the frequency dialog reads
 * them to say when the next test will actually run; view mode opens neither,
 * and could not save from either.
 */
const WITHHELD_IN_VIEW_MODE = ["interface", "ooklaId", "libreId", "libreUrl",
    "cron", "scheduleOffset", "passwordLevel", "quietHoursStart", "quietHoursEnd"];

app.get("/", password(true), async (req, res) => {
    let configValues = {};
    (await config.listAll()).forEach(row => {
        if (row.key !== "password" && !(req.viewMode && WITHHELD_IN_VIEW_MODE.includes(row.key)))
            configValues[row.key] = row.value;
    });
    configValues['viewMode'] = req.viewMode;
    configValues['previewMode'] = process.env.PREVIEW_MODE === "true";

    // Whether a password exists, never the value. The client used to work this
    // out from its own localStorage, which meant the answer was per-browser:
    // an instance with a password showed as unprotected on every other device.
    configValues['passwordSet'] = (await config.getValue("password")) !== config.NO_PASSWORD;

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
    if (typeof value === "string") return res.status(400).json({message: value});

    if (!await config.updateValue(req.params.key, value.value))
        return res.status(500).json({message: `Error updating the key '${req.params.key}'`});

    if (req.params.key === "cron") {
        timer.stopTimer();
        timer.startTimer(req.body.value.toString());
    }

    res.json({message: `The key '${req.params.key}' has been successfully updated`});
});

export default app;