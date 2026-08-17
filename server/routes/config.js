import express from 'express';
import * as config from '../controller/config.js';
import * as timer from '../tasks/timer.js';
import password from '../middlewares/password.js';
import previewReadOnly from '../middlewares/previewReadOnly.js';
import { isUntrustedReader } from '../util/untrustedReader.js';
import { isPreviewInstance } from '../util/previewMode.js';

const app = express.Router();

/**
 * What a caller who is not the operator is not told about the instance.
 *
 * `interface` is the operator's own network adapter - a name that can say what
 * the host is, "vEthernet (External)" for a Hyper-V machine among them. Only
 * the provider dialog reads it and neither a read-only viewer nor a demo
 * visitor ever opens that, so it was disclosed to every visitor of a public
 * dashboard for nothing.
 *
 * The quiet hours joined the list for the same reason as the cron: they
 * describe the schedule, and rather more personally - they are the nightly
 * hours the operator set aside, which on a publicly exposed instance says when
 * nobody is home. The pause dialog reads them, and the frequency dialog reads
 * them to say when the next test will actually run; neither dialog opens for
 * these callers, and neither could save from it.
 *
 * "Untrusted" rather than "in view mode": the list was applied to the read-only
 * password holder alone, and a public demo - the more exposed of the two, and
 * the one whose address is meant to be handed to strangers - was handed the
 * whole of it. isUntrustedReader carries why the two had to stop being one flag.
 */
const WITHHELD_FROM_UNTRUSTED = ["interface", "ooklaId", "libreId", "libreUrl",
    "cron", "scheduleOffset", "passwordLevel", "quietHoursStart", "quietHoursEnd"];

app.get("/", password(true), async (req, res) => {
    const withhold = isUntrustedReader(req);

    let configValues = {};
    (await config.listAll()).forEach(row => {
        if (row.key !== "password" && !(withhold && WITHHELD_FROM_UNTRUSTED.includes(row.key)))
            configValues[row.key] = row.value;
    });
    // Not `withhold`, on purpose. This is what the client is allowed to *do*,
    // and a demo visitor may do everything - preview mode answers a run with a
    // generated result, and StatusUtil would hide the button this reported true.
    // What the server discloses is the question above; they are not the same one.
    configValues['viewMode'] = req.viewMode;
    configValues['previewMode'] = isPreviewInstance();

    // Whether a password exists, never the value. The client used to work this
    // out from its own localStorage, which meant the answer was per-browser:
    // an instance with a password showed as unprotected on every other device.
    configValues['passwordSet'] = (await config.getValue("password")) !== config.NO_PASSWORD;

    if (isPreviewInstance())
        configValues['previewMessage'] = String(process.env.PREVIEW_MESSAGE || "The owner of this instance has not provided a message");

    if (Object.keys(configValues).length === 0) return res.status(404).json({message: "Hmm. There are no config values. Weird..."});
    res.json(configValues);
});

// Clearing the password is its own operation. It used to be a PATCH carrying
// the sentinel "none", which meant a user who chose that as their password
// silently unprotected the instance instead.
app.delete("/password", password(false), previewReadOnly, async (req, res) => {
    await config.clearPassword();
    res.json({message: "The password has been successfully removed"});
});

// Guarded for the reason the password beside it was: in preview mode the
// password middleware waves every request through, so without this any visitor
// to the public demo could rewrite the schedule, the provider or the retention
// period. validateInput refuses `password` and `passwordLevel` on a preview
// instance already, which left every other key open.
app.patch("/:key", password(false), previewReadOnly, async (req, res) => {
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