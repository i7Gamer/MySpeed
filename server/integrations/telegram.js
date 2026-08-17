import { postJson } from "../util/http.js";
import { replaceVariables, truncate } from "../util/helpers.js";
import { TELEGRAM_MARKDOWN, stripMarkdown as strip } from "../util/markdown.js";

/**
 * What sendMessage will accept as text.
 *
 * A longer one is answered with a 400 and nothing is delivered - the same way
 * the unbalanced markdown above is refused, and for the same reason it matters:
 * a failure notification is the one nobody can afford to lose. Neither the
 * template nor the reason reaches this alone, since validateInput caps a custom
 * template at 2000 and cliOutput caps a stored reason at 2000; together they do.
 */
export const TELEGRAM_MESSAGE_LIMIT = 4096;

const defaults = {
    finished: "✨ *A speedtest is finished*\n🏓 `Ping`: %ping% ms (±%jitter% ms)\n🔼 `Upload`: %upload% Mbps\n🔽 `Download`: %download% Mbps",
    failed: "❌ *A speedtest has failed*\n`Reason`: %error%"
};

/**
 * Strips the characters Telegram's legacy markdown treats as formatting.
 *
 * That parser has no escape syntax, and it rejects the whole message with a 400
 * when the formatting does not balance. Speedtest errors are raw CLI output and
 * routinely contain a stray backtick or asterisk, so the failure notification
 * was dropped exactly when it mattered most. Only the interpolated values are
 * cleaned - the operator's own template keeps its formatting.
 *
 * The cleaning itself lives in util/markdown.js, which discord.js - the other
 * module that renders these values as markdown, and did not clean them - now
 * reads too.
 */
export const stripMarkdown = (variables) => strip(variables, TELEGRAM_MARKDOWN);

// Trimmed here rather than at each call site, so a message added later cannot
// be the one that is sent whole and refused.
const send = (token, chat_id, text, activity) =>
    postJson(`https://api.telegram.org/bot${token}/sendMessage`,
        {text: truncate(text, TELEGRAM_MESSAGE_LIMIT), chat_id, parse_mode: "markdown"}, {activity});

export default (registerEvent) => {
    registerEvent('testFinished', async ({data: c}, data, activity) => {
        if (c.send_finished) await send(c.token, c.chat_id,
            replaceVariables(c.finished_message || defaults.finished, stripMarkdown(data)), activity);
    });

    registerEvent('testFailed', async ({data: c}, failure, activity) => {
        if (c.send_failed) await send(c.token, c.chat_id,
            replaceVariables(c.error_message || defaults.failed, stripMarkdown(failure)), activity);
    });

    return {
        // Opts in to the shared threshold settings; isNotifier in
        // controller/integrations.js explains the flag.
        notifier: true,
        icon: "fa-brands fa-telegram",
        fields: [
            // Anchored: the token is interpolated into the request path as
            // `/bot${token}/sendMessage`, and `test` is unanchored - so a token
            // pasted with its "bot" prefix already on it, or one carrying a
            // ../ out of its own segment, was accepted by the form and then
            // answered 404 for as long as it stayed configured.
            {name: "token", type: "text", required: true, secret: true, regex: /^(\d+):[a-zA-Z0-9_-]+$/},
            // Negative on purpose: a group or channel id is, and that is the
            // common case for an alert. Anchoring this to digits alone would
            // have refused every one of them.
            {name: "chat_id", type: "text", required: true, regex: /^-?\d+$/},
            {name: "send_finished", type: "boolean", required: false},
            {name: "finished_message", type: "textarea", required: false},
            {name: "send_failed", type: "boolean", required: false},
            {name: "error_message", type: "textarea", required: false}
        ]
    };
};
