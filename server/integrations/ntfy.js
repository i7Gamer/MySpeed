import { postText } from "../util/http.js";
import { replaceVariables } from "../util/helpers.js";

const defaults = {
    finished: "A speedtest is finished:\nPing: %ping% ms (±%jitter% ms)\nUpload: %upload% Mbps\nDownload: %download% Mbps",
    failed: "A speedtest has failed. Reason: %error%"
};

const buildHeaders = ({token, title, tags}, priority) => {
    const headers = {};
    if (priority) headers["Priority"] = String(parseInt(priority));
    if (title) headers["Title"] = title;
    if (tags) headers["Tags"] = tags;
    if (token) headers["Authorization"] = "Bearer " + token;
    return headers;
};

const send = (config, message, priority, activity) => {
    const url = stripTrailingSlashes(config.url);
    return postText(`${url}/${config.topic}`, message,
        {headers: buildHeaders(config, priority), activity});
};

export default (registerEvent) => {
    registerEvent('testFinished', async ({data: c}, data, activity) => {
        if (c.send_finished) await send(c,
            replaceVariables(c.finished_message || defaults.finished, data),
            c.priority || 3, activity);
    });

    registerEvent('testFailed', async ({data: c}, error, activity) => {
        if (c.send_failed) await send(c,
            replaceVariables(c.error_message || defaults.failed, {error}),
            c.error_priority || 5, activity);
    });

    return {
        icon: "fa-solid fa-bell-concierge",
        fields: [
            {name: "url", type: "text", required: true, regex: /^https?:\/\/.+/},
            {name: "topic", type: "text", required: true, regex: /^[A-Za-z0-9_\-]{1,64}$/},
            {name: "token", type: "text", required: false},
            {name: "title", type: "text", required: false},
            {name: "tags", type: "text", required: false},
            {name: "priority", type: "text", required: false, regex: /^[1-5]$/},
            {name: "error_priority", type: "text", required: false, regex: /^[1-5]$/},
            {name: "send_finished", type: "boolean", required: false},
            {name: "finished_message", type: "textarea", required: false},
            {name: "send_failed", type: "boolean", required: false},
            {name: "error_message", type: "textarea", required: false}
        ]
    };
};
