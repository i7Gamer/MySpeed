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
/**
 * A newline cannot be escaped, so it is swapped for a space before anything
 * else runs.
 *
 * Line protocol has no spelling for one inside a tag - it is the record
 * separator itself. A value carrying one therefore did not produce a tag with a
 * newline in it: it ended the line early and left the remainder to be read as a
 * second, malformed point, which influx answers with a 400. Every write from
 * that integration then failed, for a reason nothing on screen connects to the
 * host field somebody pasted a trailing newline into.
 *
 * A space rather than nothing, so the two halves of the value stay apart, and a
 * run of them collapses to one. It has to happen before the escaping below or
 * the space it introduces ends the tag section early instead - the same break
 * by a different route.
 */
const NEWLINES = /[\r\n]+/g;
const oneLine = (value) => String(value).replace(NEWLINES, " ");

const escapeTag = (value) => oneLine(value).replace(/[\\ ,=]/g, "\\$&");
const escapeMeasurement = (value) => oneLine(value).replace(/[\\ ,]/g, "\\$&");

/**
 * @returns the line, or null when nothing survived the field filter.
 *
 * A point with no field set is not a point: the middle section would be empty -
 * `speedtests,host=x  1786100000`, two spaces where the fields belong - and
 * influx answers that with a 400, losing the write. Reporting it as "there is
 * no line to send" lets the caller skip the request rather than make one that
 * cannot succeed.
 */
export const buildLine = (measurement, tags, fields, timestampSeconds) => {
    const tagPart = Object.entries(tags)
        .filter(([, v]) => v !== undefined && v !== null && v !== "")
        .map(([k, v]) => `${escapeTag(k)}=${escapeTag(v)}`)
        .join(",");

    const fieldPart = Object.entries(fields)
        .filter(([, v]) => typeof v === "number" && Number.isFinite(v))
        .map(([k, v]) => `${k}=${v}`)
        .join(",");

    if (!fieldPart) return null;

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

        // The quality figures ride along with the throughput. They are null
        // where the provider does not measure them, and buildLine keeps only
        // finite numbers - so an absent figure stays out of the line rather
        // than charting a loss-free connection nobody measured.
        const fields = {
            download: data.download,
            upload: data.upload,
            ping: data.ping,
            jitter: data.jitter ?? 0,
            packetLoss: data.packetLoss,
            downloadLatency: data.downloadLatency,
            uploadLatency: data.uploadLatency
        };

        const timestamp = Math.floor(Date.now() / 1000);
        const line = buildLine(c.measurement || "speedtests", tags, fields, timestamp);

        // Nothing measurable in the payload, so there is nothing to write and a
        // request would only be refused. Returning without touching `activity`
        // leaves the integration's last-run state as the last real send found
        // it, which is what it still says about whether this endpoint works.
        if (line === null) return;

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
