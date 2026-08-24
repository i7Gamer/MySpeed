import { postJson } from "../util/http.js";
import { replaceVariables, stripTrailingSlashes } from "../util/helpers.js";

const defaults = {
    finished: "A speedtest is finished:\nPing: %ping% ms (±%jitter% ms)\nUpload: %upload% Mbps\nDownload: %download% Mbps",
    failed: "A speedtest has failed. Reason: %error%"
};

/**
 * What a finished test carries when the stored priority cannot be read.
 *
 * Gotify's scale runs 0-10 and pops a notification up from 8, which is where a
 * failure sits. A finished test is information rather than an alarm, so this
 * falls in the ordinary band beneath it.
 */
const FINISHED_PRIORITY = 5;

// A failure pops up, which is what the top of the scale is for.
const FAILED_PRIORITY = 8;

/**
 * The stored priority as a number Gotify will accept.
 *
 * parseInt(undefined) is NaN, and JSON.stringify writes NaN as `null` - which
 * Gotify, being Go, refuses outright: encoding/json will not unmarshal null into
 * the int its Message struct declares, so the whole request comes back 400 and
 * the notification is lost for as long as the row stays that way.
 *
 * The form cannot produce such a row - the field is required and validated
 * against a single digit - but importConfig bulk-creates the integration rows a
 * backup carries without running them through validateInput, and a row written
 * before the field existed has no priority at all. A notification is the one
 * thing that must not depend on where its row came from.
 */
const priorityOf = (priority, fallback) => {
    const parsed = parseInt(priority);

    return Number.isFinite(parsed) ? parsed : fallback;
};

// Stripped first, as every other integration that composes a path does: the
// url field's regex is unanchored and its value is stored as pasted, so a base
// url copied out of the address bar arrives with a trailing slash and made
// `//message` - an empty path segment, which Gotify answers with a 404.
const send = ({url, key}, message, priority, activity) =>
    postJson(`${stripTrailingSlashes(url)}/message`, {message, priority},
        {headers: {"Authorization": "Bearer " + key}, activity});

export default (registerEvent) => {
    registerEvent('testFinished', async ({data: c}, data, activity) => {
        if (c.send_finished) await send(c,
            replaceVariables(c.finished_message || defaults.finished, data),
            priorityOf(c.priority, FINISHED_PRIORITY), activity);
    });

    registerEvent('testFailed', async ({data: c}, failure, activity) => {
        if (c.send_failed) await send(c,
            replaceVariables(c.error_message || defaults.failed, failure), FAILED_PRIORITY, activity);
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
