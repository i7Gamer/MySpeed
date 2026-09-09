import { plainDefaults } from '../util/notificationLocale.js';
import { postText } from "../util/http.js";
import { headerSafe, replaceVariables, stripTrailingSlashes } from "../util/helpers.js";
import { wantsDigest } from "../util/digestOptIn.js";
import { IP_CHANGED_EVENT } from "../util/connectionChange.js";
import { OUTAGE_EVENT, RECOVERED_EVENT } from "../util/outage.js";

// Both templates name the target: on a multi-target instance every message
// otherwise reads identically whether it describes the WAN or the LAN box.
// The plain-text pair three notifiers share, in the integration's own
// language - see util/notificationLocale.js.
const defaults = plainDefaults;

// The range ntfy accepts, and the one the priority fields' own /^[1-5]$/ below
// spells out - kept as numbers here because this is where a value that never
// went through that regex is judged.
const NTFY_PRIORITY_MIN = 1;
const NTFY_PRIORITY_MAX = 5;

const NTFY_ATTACHMENT_THRESHOLD_BYTES = 4096;
const NTFY_MESSAGE_BYTES = NTFY_ATTACHMENT_THRESHOLD_BYTES - 1;

// ntfy treats a body reaching its default 4 KiB peek limit as an attachment,
// including exactly 4096 bytes (verified against ntfy 2.28.0). Stay below that
// threshold, count UTF-8 bytes, and preserve whole code points.
const messageBody = (message) => {
    if (Buffer.byteLength(message, "utf8") <= NTFY_MESSAGE_BYTES) return message;

    let bytes = 0;
    let text = "";
    for (const character of message) {
        const size = Buffer.byteLength(character, "utf8");
        if (bytes + size > NTFY_MESSAGE_BYTES) break;
        text += character;
        bytes += size;
    }
    return text;
};

const buildHeaders = ({token, title, tags}, priority) => {
    const headers = {};
    // A priority ntfy would refuse is dropped rather than sent - both one that
    // does not parse to a number, which would go out as the literal header
    // "NaN", and one that parses to a number outside 1-5. The form's regex
    // never allows either, but a config import writes the field unvalidated,
    // and "0" or "7" is truthy enough to survive the callers' fallback. ntfy
    // rejects the whole request over a Priority it does not accept - losing a
    // notification an absent priority would have delivered at the server's own
    // default.
    const level = parseInt(priority);
    if (Number.isInteger(level) && level >= NTFY_PRIORITY_MIN && level <= NTFY_PRIORITY_MAX)
        headers["Priority"] = String(level);
    if (title) headers["Title"] = headerSafe(title);
    if (tags) headers["Tags"] = headerSafe(tags);
    /*
     * Through the same filter as the title beside it. The token declares no
     * regex and a config import writes the field unvalidated, so a stray
     * newline or a character above U+00FF in a pasted credential made undici
     * throw on every send - and an integration that has stopped delivering
     * looks exactly like one that has nothing to say.
     */
    if (token) headers["Authorization"] = "Bearer " + headerSafe(token);
    return headers;
};

const send = (config, message, priority, activity) => {
    const url = stripTrailingSlashes(config.url);
    return postText(`${url}/${config.topic}`, messageBody(message),
        {headers: buildHeaders(config, priority), activity});
};

/**
 * The band a digest arrives in - ntfy's own default, fixed rather than read
 * from the stored priority: that setting says how loudly a measurement
 * arrives, and a summary of a period already past is not one.
 */
const DIGEST_PRIORITY = 3;

/** The band a failure arrives in when the operator set none - the top of ntfy's scale. */
const FAILED_PRIORITY = NTFY_PRIORITY_MAX;


export default (registerEvent) => {
    // `zone` is the instance's own clock, resolved once per event by
    // triggerEvent from the stored timezone setting - see discord.js for why
    // the six clock names could not go on being read off the process clock.
    registerEvent('testFinished', async ({data: c}, data, activity, zone) => {
        if (c.send_finished) await send(c,
            replaceVariables(c.finished_message || defaults(c.language).finished, data, zone),
            c.priority || DIGEST_PRIORITY, activity);
    });

    registerEvent('testFailed', async ({data: c}, failure, activity, zone) => {
        if (c.send_failed) await send(c,
            replaceVariables(c.error_message || defaults(c.language).failed, failure, zone),
            c.error_priority || FAILED_PRIORITY, activity);
    });

    // At the digest's band: a change is news rather than an alarm.
    registerEvent(IP_CHANGED_EVENT, async ({data: c}, change, activity, zone) => {
        if (c.send_ip_changed) await send(c,
            replaceVariables(c.ip_changed_message || defaults(c.language).ipChanged, change, zone),
            DIGEST_PRIORITY, activity);
    });

    // An outage at the failure's band, its end at the measurement's: the
    // first is the alarm a failure only hints at, the second is a good test.
    registerEvent(OUTAGE_EVENT, async ({data: c}, outage, activity, zone) => {
        if (c.send_outage) await send(c,
            replaceVariables(c.outage_message || defaults(c.language).outage, outage, zone),
            c.error_priority || FAILED_PRIORITY, activity);
    });

    registerEvent(RECOVERED_EVENT, async ({data: c}, recovery, activity, zone) => {
        if (c.send_outage) await send(c,
            replaceVariables(c.recovered_message || defaults(c.language).recovered, recovery, zone),
            c.priority || DIGEST_PRIORITY, activity);
    });

    registerEvent('digestReady', async ({data: c}, payload, activity) => {
        // No title of its own beyond the one the operator configured:
        // headerSafe drops everything above U+00FF, and the digest names the
        // period it covers on its first line - in the body, where every
        // character of it survives.
        if (wantsDigest(c, payload.kind)) await send(c, payload.text, DIGEST_PRIORITY, activity);
    });

    return {
        // Opts in to the shared threshold settings; isNotifier in
        // controller/integrations.js explains the flag.
        notifier: true,
        // And to the language setting, because what it sends is prose a person
        // reads; isLocalised in controller/integrations.js explains this one.
        localised: true,
        icon: "fa-solid fa-bell-concierge",
        fields: [
            // `.+` stops at a newline without an end anchor to refuse it, and
            // WHATWG url parsing strips that newline out before it resolves the
            // host - so "https://good\n@evil.com" read as one host and reached
            // another. \S+$ leaves no room for either.
            // Both secret, and for the reason discord's plain `url` is: send()
            // posts to `<url>/<topic>` and only attaches an Authorization
            // header when a token is set - and `token` is not required, so on
            // the ntfy.sh default the topic name is the entire publish and
            // subscribe control, exactly as an unguessable webhook path is.
            // Flagged singly they were left in the clear by withoutSecrets,
            // which handed the whole capability to any visitor of a public demo
            // and to anyone sent a config export marked `secretsRedacted`.
            {name: "url", type: "text", required: true, secret: true, regex: /^https?:\/\/\S+$/},
            // The hyphen is last in the class, where it is a literal already -
            // escaping it there reads as a range that got away.
            {name: "topic", type: "text", required: true, secret: true, regex: /^[A-Za-z0-9_-]{1,64}$/},
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
