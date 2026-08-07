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
            // Only the UI guarantees a string here; a hand-crafted PATCH can
            // store a number, and .split would then throw inside the event
            // loop and abort every integration queued behind this one.
            ...(typeof c.tags === "string" && c.tags ? Object.fromEntries(c.tags.split(",")
                .map(t => t.split("=").map(s => s.trim()))
                .filter(([k, v]) => k && v)) : {})
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
            {name: "url", type: "text", required: true, regex: /^https?:\/\/.+/},
            {name: "org", type: "text", required: true},
            {name: "bucket", type: "text", required: true},
            {name: "token", type: "text", required: true},
            {name: "measurement", type: "text", required: false},
            {name: "host", type: "text", required: false},
            {name: "tags", type: "text", required: false}
        ]
    };
};
