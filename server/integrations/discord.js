import { phrase } from '../util/notificationLocale.js';
import { postJson } from "../util/http.js";
import { replaceVariables, truncate } from "../util/helpers.js";
import { DISCORD_MARKDOWN, stripMarkdown } from "../util/markdown.js";
import { wantsDigest } from "../util/digestOptIn.js";

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

/**
 * What discord will accept as a username override.
 *
 * 1-80 characters; a longer one is answered with a 400 and nothing is
 * delivered. Worse than an over-long description, because it is the same value
 * on every request - so it kills the finished *and* the failed notification
 * unconditionally, rather than only the ones whose text happens to run long.
 *
 * Nothing upstream bounds it: `display_name` declares no regex, so the only
 * gate is validateInput's generic 250-character cap on a text field, which is
 * three times what discord will take.
 */
export const DISCORD_USERNAME_LIMIT = 80;

// Both templates name the target: on a multi-target instance every message
// otherwise reads identically whether it describes the WAN or the LAN box. A
// pre-target row renders it as N/A, the shape every unmeasured figure takes.
/**
 * The messages a notifier sends when nothing was edited, in the language the
 * integration was set to - see util/notificationLocale.js. A function of the
 * language rather than a constant, because the language is the integration's
 * own setting and two integrations may hold two.
 */
const defaults = (language) => {
    const word = (key) => phrase(language, key);

    return {
        finished: `:sparkles: **${word("finished")}**\n > :dart: \`${word("target")}\`: %targetName%\n > :ping_pong: \`${word("ping")}\`: %ping% ms (±%jitter% ms)\n > :arrow_up: \`${word("upload")}\`: %upload% Mbps\n > :arrow_down: \`${word("download")}\`: %download% Mbps%alertSummary%`,
        failed: `:x: **${word("failed")}**\n > \`${word("target")}\`: %targetName%\n > \`${word("reason")}\`: %error%`
    };
};

/**
 * Discord's HTTP API documents a User-Agent as required, and the edge in front
 * of it does reject requests that arrive without one. Node's fetch sends no
 * default, so every notification went out headerless - which fits the half of
 * the reports that say the webhook saves and then never delivers. The webhook
 * integration beside this one has always identified itself.
 */
const USER_AGENT = "MySpeed (https://github.com/i7Gamer/MySpeed)";

/**
 * The name the webhook posts under, or MySpeed.
 *
 * The fallback used to be a bare `||` at each call site, which caught only the
 * empty string - so a name of spaces passed through and discord answered 400
 * for a username that is blank once trimmed, dropping the notification.
 *
 * Coerced with String() rather than reached through `?.trim()`. Optional
 * chaining guards null and undefined and not a number, and importConfig
 * bulk-writes integration rows without running them through validateInput - so
 * a numeric display name, which is delivered today because truncate coerces the
 * same way, would start throwing into triggerEvent's per-integration catch and
 * the notification would vanish.
 *
 * Resolved inside send, beside the truncate, for the reason that one is here:
 * it also catches a name that is blank only after being cut to the limit.
 */
const username = (name) => String(name ?? "").trim() || "MySpeed";

// Trimmed here rather than at each call site, so a message added later cannot
// be the one that is sent whole and refused.
const send = (url, name, color, description, activity) =>
    postJson(url, {
        content: null, username: truncate(username(name), DISCORD_USERNAME_LIMIT),
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

/**
 * The stripe a digest carries.
 *
 * Neither of the two the per-test messages wear: the green of a finished test
 * would read as "the period was fine" and the red of a failure as an alarm,
 * and a summary is neither - it reports the period whatever was in it.
 */
const DIGEST_COLOR = 4543686;


export default (registerEvent) => {
    registerEvent('testFinished', async ({data: c}, data, activity) => {
        if (c.send_finished) await send(c.url, c.display_name, 4572762,
            replaceVariables(c.finished_message || defaults(c.language).finished, clean(data)), activity);
    });

    registerEvent('testFailed', async ({data: c}, failure, activity) => {
        if (c.send_failed) await send(c.url, c.display_name, 12993861,
            replaceVariables(c.error_message || defaults(c.language).failed, clean(failure)), activity);
    });

    registerEvent('digestReady', async ({data: c}, payload, activity) => {
        // Through the same embed the per-test messages use, so the digest
        // inherits the trim at DISCORD_DESCRIPTION_LIMIT. A bare `content`
        // field is capped at 2000 instead, and nothing here enforces that one.
        if (wantsDigest(c, payload.kind))
            await send(c.url, c.display_name, DIGEST_COLOR, payload.text, activity);
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
