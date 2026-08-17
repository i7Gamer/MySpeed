import { postJson } from "../util/http.js";
import { replaceVariables, truncate } from "../util/helpers.js";
import { DISCORD_MARKDOWN, stripMarkdown } from "../util/markdown.js";

/**
 * What discord will accept as an embed description.
 *
 * It answers anything longer with a 400 and delivers nothing. Neither half of
 * the message can reach this alone - validateInput caps a custom template at
 * 2000 and cliOutput caps a stored failure reason at 2000 - so it takes both
 * together, which is an ordinary enough pairing: a template with the server and
 * provider spelled out, and a CLI that logs one line per candidate server it
 * could not reach. Pushover was caught by exactly this and trims; this did not.
 */
export const DISCORD_DESCRIPTION_LIMIT = 4096;

const defaults = {
    finished: ":sparkles: **A speedtest is finished**\n > :ping_pong: `Ping`: %ping% ms (±%jitter% ms)\n > :arrow_up: `Upload`: %upload% Mbps\n > :arrow_down: `Download`: %download% Mbps",
    failed: ":x: **A speedtest has failed**\n > `Reason`: %error%"
};

/**
 * Discord's HTTP API documents a User-Agent as required, and the edge in front
 * of it does reject requests that arrive without one. Node's fetch sends no
 * default, so every notification went out headerless - which fits the half of
 * the reports that say the webhook saves and then never delivers. The webhook
 * integration beside this one has always identified itself.
 */
const USER_AGENT = "MySpeed (https://github.com/i7Gamer/MySpeed)";

// Trimmed here rather than at each call site, so a message added later cannot
// be the one that is sent whole and refused.
const send = (url, username, color, description, activity) =>
    postJson(url, {
        content: null, username,
        embeds: [{
            description: truncate(description, DISCORD_DESCRIPTION_LIMIT),
            color, footer: {text: "MySpeed"}, timestamp: new Date().toISOString()
        }]
    }, {headers: {"user-agent": USER_AGENT}, activity});

/**
 * A discord webhook URL, as discord itself issues them.
 *
 * Three things were wrong with the pattern this replaces,
 * `/https:\/\/.*discord.com\/api\/webhooks\/\d+\/.+/`:
 *
 * - `discordapp.com` was rejected. That host is still served and still handed
 *   out, and the unescaped `.` did not rescue it - "discord" plus any single
 *   character plus "com" does not match "discordapp.com". The reported
 *   workaround was to delete "app" from one's own webhook URL.
 * - It was unanchored, and both ends check it with `RegExp.test`, which matches
 *   anywhere in the string. Any URL at all that merely contained a
 *   webhook-shaped substring was accepted - and the value that is stored is
 *   where the speedtest results are then posted.
 * - The leading `.*` accepted any host ending in the pattern, so
 *   `notdiscord.com` passed.
 *
 * The optional query string is discord's own thread targeting (`?thread_id=`),
 * and the version segment is the equally valid `/api/v10/webhooks/...` form.
 */
const WEBHOOK_URL = /^https:\/\/(?:ptb\.|canary\.)?discord(?:app)?\.com\/api(?:\/v\d+)?\/webhooks\/\d+\/[\w-]+(?:\?\S*)?$/;

/**
 * Discord renders an embed description as markdown, and the values interpolated
 * into it are provider-supplied text: Ookla quotes server names in backticks,
 * and those re-pair with the ones the default template puts around `Ping` -
 * so part of the sentence arrived as a code span with the delimiters no longer
 * on screen. Masked links are live in a description too, so `[text](url)` in a
 * CLI error became a link nobody wrote.
 *
 * Telegram has cleaned its own values since 49154de1 and this did not, which is
 * the whole of the fault. Only the values: the operator's template keeps its
 * formatting, which is what the backticks in the default are.
 */
const clean = (variables) => stripMarkdown(variables, DISCORD_MARKDOWN);

export default (registerEvent) => {
    registerEvent('testFinished', async ({data: c}, data, activity) => {
        if (c.send_finished) await send(c.url, c.display_name || "MySpeed", 4572762,
            replaceVariables(c.finished_message || defaults.finished, clean(data)), activity);
    });

    registerEvent('testFailed', async ({data: c}, failure, activity) => {
        if (c.send_failed) await send(c.url, c.display_name || "MySpeed", 12993861,
            replaceVariables(c.error_message || defaults.failed, clean(failure)), activity);
    });

    return {
        // Opts in to the shared threshold settings; isNotifier in
        // controller/integrations.js explains the flag.
        notifier: true,
        icon: "fa-brands fa-discord",
        fields: [
            {name: "url", type: "text", required: true, secret: true, regex: WEBHOOK_URL},
            {name: "display_name", type: "text", required: false},
            {name: "send_finished", type: "boolean", required: false},
            {name: "finished_message", type: "textarea", required: false},
            {name: "send_failed", type: "boolean", required: false},
            {name: "error_message", type: "textarea", required: false}
        ]
    };
};
