import { postJson } from "../util/http.js";
import { replaceVariables, stripTrailingSlashes } from "../util/helpers.js";

const defaults = {
    finished: "A speedtest is finished:\nPing: %ping% ms (±%jitter% ms)\nUpload: %upload% Mbps\nDownload: %download% Mbps",
    failed: "A speedtest has failed. Reason: %error%"
};

// Stripped first, as every other integration that composes a path does: the
// url field's regex is unanchored and its value is stored as pasted, so a base
// url copied out of the address bar arrives with a trailing slash and made
// `//message` - an empty path segment, which Gotify answers with a 404.
const send = ({url, key}, message, priority, activity) =>
    postJson(`${stripTrailingSlashes(url)}/message`, {message, priority: parseInt(priority)},
        {headers: {"Authorization": "Bearer " + key}, activity});

export default (registerEvent) => {
    registerEvent('testFinished', async ({data: c}, data, activity) => {
        if (c.send_finished) await send(c,
            replaceVariables(c.finished_message || defaults.finished, data), c.priority, activity);
    });

    registerEvent('testFailed', async ({data: c}, failure, activity) => {
        if (c.send_failed) await send(c,
            replaceVariables(c.error_message || defaults.failed, failure), 8, activity);
    });

    return {
        // Opts in to the shared threshold settings; isNotifier in
        // controller/integrations.js explains the flag.
        notifier: true,
        icon: "fa-solid fa-bell",
        fields: [
            // Anchored at both ends and whitespace-free: `test` is unanchored,
            // so the old pattern matched a url *inside* the value. See
            // tests/server/integrationFields.test.js for what that let through.
            {name: "url", type: "text", required: true, regex: /^https?:\/\/\S+$/},
            {name: "key", type: "text", required: true, secret: true, regex: /^.{15}$/},
            {name: "priority", type: "text", required: true, regex: /^[0-9]$/},
            {name: "send_finished", type: "boolean", required: false},
            {name: "finished_message", type: "textarea", required: false},
            {name: "send_failed", type: "boolean", required: false},
            {name: "error_message", type: "textarea", required: false}
        ]
    };
};
