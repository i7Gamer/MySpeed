import { postText } from "../util/http.js";
import { replaceVariables, stripTrailingSlashes } from "../util/helpers.js";

const defaults = {
    finished: "A speedtest is finished:\nPing: %ping% ms (±%jitter% ms)\nUpload: %upload% Mbps\nDownload: %download% Mbps",
    failed: "A speedtest has failed. Reason: %error%"
};

/**
 * What a header value is allowed to be.
 *
 * The title and the tags are free text from the integration form and go into
 * headers verbatim, so anything undici refuses is a notification that never
 * leaves the process - postText catches the throw, logs it and answers null,
 * while the integration goes on showing as configured.
 *
 * Two things are refused, not one. A line break, because a value split across
 * lines is also how a request smuggles a second header in. And any code point
 * above U+00FF, because a header is Latin-1 on the wire - which matters more in
 * practice than the newline did: ntfy's own documentation shows emoji titles,
 * and a Cyrillic or CJK instance name is entirely ordinary. Dropping those
 * characters costs a nicer-looking title; keeping them cost the whole message.
 *
 * The bounds are written as escapes rather than as the characters themselves.
 * Spelling the upper bound literally is how this class first ended up holding a
 * stray byte instead of the intended one - which git read as binary, and which
 * nothing else caught because the resulting range still behaved.
 */
const HEADER_SAFE = /[^\x20-\xFF]/g;

const headerSafe = (value) => String(value)
    .replace(/[\r\n]+/g, " ")
    .replace(HEADER_SAFE, "");

const buildHeaders = ({token, title, tags}, priority) => {
    const headers = {};
    if (priority) headers["Priority"] = String(parseInt(priority));
    if (title) headers["Title"] = headerSafe(title);
    if (tags) headers["Tags"] = headerSafe(tags);
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

    registerEvent('testFailed', async ({data: c}, failure, activity) => {
        if (c.send_failed) await send(c,
            replaceVariables(c.error_message || defaults.failed, failure),
            c.error_priority || 5, activity);
    });

    return {
        // Opts in to the shared threshold settings; isNotifier in
        // controller/integrations.js explains the flag.
        notifier: true,
        icon: "fa-solid fa-bell-concierge",
        fields: [
            {name: "url", type: "text", required: true, regex: /^https?:\/\/.+/},
            {name: "topic", type: "text", required: true, regex: /^[A-Za-z0-9_\-]{1,64}$/},
            {name: "token", type: "text", required: false, secret: true},
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
