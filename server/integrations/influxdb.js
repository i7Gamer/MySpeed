import os from "os";
import { postText } from "../util/http.js";
import { stripTrailingSlashes } from "../util/helpers.js";

/**
 * Line protocol escaping.
 *
 * The backslash has to be inside the character class, not escaped in a second
 * pass - a separate pass would double the backslashes this one just inserted.
 * Leaving it out entirely meant a tag value ending in a backslash escaped the
 * delimiter that follows it, merging the next tag into the value.
 *
 * Measurement names take the same treatment minus the equals sign, which
 * carries no meaning there.
 */
const escapeTag = (value) => String(value).replace(/[\\ ,=]/g, "\\$&");
const escapeMeasurement = (value) => String(value).replace(/[\\ ,]/g, "\\$&");

export const buildLine = (measurement, tags, fields, timestampSeconds) => {
    const tagPart = Object.entries(tags)
        .filter(([, v]) => v !== undefined && v !== null && v !== "")
        .map(([k, v]) => `${escapeTag(k)}=${escapeTag(v)}`)
        .join(",");

    const fieldPart = Object.entries(fields)
        .filter(([, v]) => typeof v === "number" && Number.isFinite(v))
        .map(([k, v]) => `${k}=${v}`)
        .join(",");

    const name = escapeMeasurement(measurement);
    const prefix = tagPart ? `${name},${tagPart}` : name;
    return `${prefix} ${fieldPart} ${timestampSeconds}`;
};

/**
 * The extra tags an operator typed in, as `key=value,key=value`.
 *
 * Split at the *first* equals sign only. Splitting on every one and taking the
 * first two pieces cost a value everything from its second onwards, so an
 * ordinary `source=http://nas.local/?id=1` was stored as
 * `source=http://nas.local/?id` - silently, and wrong in the direction that
 * matters, since the tag is what the series gets grouped by.
 *
 * Only the form guarantees a string here; a hand-crafted PATCH can store a
 * number, and .split on that threw inside the event loop and aborted every
 * integration queued behind this one.
 */
export const parseTags = (raw) => {
    if (typeof raw !== "string" || !raw) return {};

    const entries = raw.split(",").map((fragment) => {
        const split = fragment.indexOf("=");
        if (split === -1) return ["", ""];

        return [fragment.slice(0, split).trim(), fragment.slice(split + 1).trim()];
    });

    return Object.fromEntries(entries.filter(([key, value]) => key && value));
};

const send = (c, line, activity) => {
    const baseUrl = stripTrailingSlashes(c.url);
    const url = `${baseUrl}/api/v2/write?org=${encodeURIComponent(c.org)}` +
        `&bucket=${encodeURIComponent(c.bucket)}&precision=s`;
    return postText(url, line, {
        headers: {
            "Authorization": `Token ${c.token}`,
            "Content-Type": "text/plain; charset=utf-8"
        },
        activity
    });
};

export default (registerEvent) => {
    registerEvent("testFinished", async ({data: c}, data, activity) => {
        const tags = {
            host: c.host || os.hostname(),
            ...parseTags(c.tags)
        };

        const fields = {
            download: data.download,
            upload: data.upload,
            ping: data.ping,
            jitter: data.jitter ?? 0
        };

        const timestamp = Math.floor(Date.now() / 1000);
        const line = buildLine(c.measurement || "speedtests", tags, fields, timestamp);

        await send(c, line, activity);
    });

    return {
        icon: "fa-solid fa-database",
        fields: [
            {name: "url", type: "text", required: true, regex: /^https?:\/\/\S+$/},
            {name: "org", type: "text", required: true},
            {name: "bucket", type: "text", required: true},
            {name: "token", type: "text", required: true, secret: true},
            {name: "measurement", type: "text", required: false},
            {name: "host", type: "text", required: false},
            {name: "tags", type: "text", required: false}
        ]
    };
};
