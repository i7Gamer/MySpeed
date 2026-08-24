import { postJson } from "../util/http.js";
import { replaceVariables, truncate } from "../util/helpers.js";
import { TELEGRAM_MARKDOWN, stripMarkdown as strip, balancedForTelegram } from "../util/markdown.js";

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

/**
 * Trimmed here rather than at each call site, so a message added later cannot
 * be the one that is sent whole and refused.
 *
 * And rendered as markdown only while it still parses as markdown. The trim is
 * the one thing that reaches past stripMarkdown: it cuts the composed message,
 * which is where the operator's own delimiters are, so a template long enough
 * to be trimmed can lose the closing half of a pair it opened. Telegram answers
 * that with a 400 and delivers nothing - and what is being sent at that length
 * is a failure alert carrying a long CLI reason, which is the notification
 * least able to afford being dropped.
 *
 * Dropping parse_mode sends the same text unformatted, in the same single
 * request. The alternative - send, notice the 400, send again - doubles every
 * notification to an endpoint that is merely slow, and leaves the integration's
 * activity marked failed for a message that did arrive.
 */
/**
 * The forum topic to post into, or nothing at all - upstream #1176.
 *
 * Omitted rather than sent as null when there is none: telegram refuses a
 * `message_thread_id` for a chat that has no topics, and an ordinary group or a
 * channel is the common case. A 400 there delivers nothing, which is strictly
 * worse than the General topic this exists to move messages out of.
 *
 * Every shape a stored row can hold has to answer "nothing": no key at all on a
 * row written before the field existed, and the empty string on one saved with
 * the input cleared, since that is what a text field submits.
 */
const topic = (message_thread_id) =>
    message_thread_id ? {message_thread_id} : {};

const send = (token, chat_id, text, activity, message_thread_id) => {
    const message = truncate(text, TELEGRAM_MESSAGE_LIMIT);

    return postJson(`https://api.telegram.org/bot${token}/sendMessage`,
        {text: message, chat_id, ...topic(message_thread_id),
            ...(balancedForTelegram(message) ? {parse_mode: "markdown"} : {})},
        {activity});
};

export default (registerEvent) => {
    registerEvent('testFinished', async ({data: c}, data, activity) => {
        if (c.send_finished) await send(c.token, c.chat_id,
            replaceVariables(c.finished_message || defaults.finished, stripMarkdown(data)), activity,
            c.message_thread_id);
    });

    registerEvent('testFailed', async ({data: c}, failure, activity) => {
        if (c.send_failed) await send(c.token, c.chat_id,
            replaceVariables(c.error_message || defaults.failed, stripMarkdown(failure)), activity,
            c.message_thread_id);
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
            // The topic within a forum supergroup. Positive only, unlike the
            // chat id above: the negative spelling belongs to the group itself,
            // and a topic telegram cannot honour is a 400 rather than a
            // misfiled message. Not secret - it says nothing the chat id does
            // not, and redacting it would drop the routing from a config export
            // the operator restores from.
            {name: "message_thread_id", type: "text", required: false, regex: /^\d+$/},
            {name: "send_finished", type: "boolean", required: false},
            {name: "finished_message", type: "textarea", required: false},
            {name: "send_failed", type: "boolean", required: false},
            {name: "error_message", type: "textarea", required: false}
        ]
    };
};
