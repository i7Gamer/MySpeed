const RATE_LIMIT_MESSAGE = "Too many requests. Please try again later";

/**
 * Whether a parsed line is the measurement itself rather than progress chatter.
 *
 * Ookla labels its result; librespeed prints only the one object. Cloudflare
 * reports a single object too - {metadata, latency_measurement,
 * speed_measurements} - so a top-level array is not a result it produces, and
 * accepting one would be worse than rejecting it: the caller returns
 * `{...result, elapsed}`, and spreading an array gives an object keyed by index
 * that parseCloudflare quietly reads as a measurement of zero.
 */
const isResult = (mode, data) => {
    if (mode === "ookla") return data.type === "result";
    if (mode === "cloudflare") return !Array.isArray(data);
    return true;
};

/**
 * Turns what a provider CLI printed into either a result or an error.
 *
 * stdout is the authority. The CLIs also write to stderr while they are still
 * working - Ookla logs every candidate server it could not open a socket to,
 * which happens routinely when it is bound to one address family and a server
 * answers on the other - and then go on to finish the test against a server
 * that does work. So stderr only describes the outcome when stdout never
 * carried a result.
 */
export const parseCliOutput = (mode, stdout, stderr) => {
    let result = {};
    let hasResult = false;

    if (stdout.trim()) {
        for (const line of stdout.trim().split('\n')) {
            if (!(line.startsWith("{") || line.startsWith("["))) continue;

            let data;
            try {
                data = JSON.parse(line);
                if (line.startsWith("[") && mode !== "cloudflare") data = data[0];
            } catch (e) {
                console.error("JSON parse error:", e.message, "Line:", line);
                continue;
            }

            if (data.error) result.error = data.error;

            if (isResult(mode, data)) {
                result = data;
                hasResult = true;
            }
        }
    }

    if (!hasResult && !result.error && stderr.trim()) {
        result.error = stderr.includes("Too many requests") ? RATE_LIMIT_MESSAGE : stderr.trim();
    }

    return result;
};
