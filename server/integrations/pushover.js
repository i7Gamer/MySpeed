import { postJson } from "../util/http.js";
import { replaceVariables } from "../util/helpers.js";

const URL = "https://api.pushover.net/1/messages.json";

const defaults = {
    finished: "A speedtest is finished:\nPing: %ping% ms (±%jitter% ms)\nUpload: %upload% Mbps\nDownload: %download% Mbps",
    failed: "A speedtest has failed. Reason: %error%"
};

const send = ({token, user_key}, message, activity) =>
    postJson(URL, {token, user: user_key, message}, {activity});

/**
 * A pushover application token or user key.
 *
 * Thirty characters from a case-sensitive alphanumeric alphabet. The pattern
 * used to allow only lowercase, so a key holding a single capital - which is
 * most of them - could not be saved at all, and the reported workaround was to
 * lowercase the key by hand, which names a different account entirely.
 */
const CREDENTIAL = /^[A-Za-z0-9]{30}$/;

export default (registerEvent) => {
    registerEvent('testFinished', async ({data: c}, data, activity) => {
        if (c.send_finished) await send(c,
            replaceVariables(c.finished_message || defaults.finished, data), activity);
    });

    registerEvent('testFailed', async ({data: c}, failure, activity) => {
        if (c.send_failed) await send(c,
            replaceVariables(c.error_message || defaults.failed, failure), activity);
    });

    return {
        // Opts in to the shared threshold settings; isNotifier in
        // controller/integrations.js explains the flag.
        notifier: true,
        icon: "fa-solid fa-pushover",
        fields: [
            {name: "token", type: "text", required: true, secret: true, regex: CREDENTIAL},
            {name: "user_key", type: "text", required: true, secret: true, regex: CREDENTIAL},
            {name: "send_finished", type: "boolean", required: false},
            {name: "finished_message", type: "textarea", required: false},
            {name: "send_failed", type: "boolean", required: false},
            {name: "error_message", type: "textarea", required: false}
        ]
    };
};
