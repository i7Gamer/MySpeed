const RATE_LIMIT_MESSAGE = "Too many requests. Please try again later";

/**
 * How much of a failing run's output is worth storing.
 *
 * The whole of stderr used to go into the database verbatim, and a run can
 * spend its full three-minute timeout logging one line per candidate server it
 * could not reach - three of those already exceed the 255 characters the column
 * used to hold. MySQL in its default strict mode then refused the insert from
 * inside the very handler that exists to record failures, so the failed test
 * was never written, the integrations were never told, and the running flag was
 * left set. The column is TEXT now; this keeps a runaway CLI from filling it.
 *
 * The beginning is kept because that is where the reason is - the rest is the
 * same line repeated - and the mark makes a cut message visibly incomplete.
 */
export const MAX_ERROR_LENGTH = 2000;

const TRUNCATION_MARK = "…";

const capError = (message) => {
    const text = String(message);

    return text.length <= MAX_ERROR_LENGTH
        ? text
        : text.slice(0, MAX_ERROR_LENGTH - TRUNCATION_MARK.length) + TRUNCATION_MARK;
};

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

    // Capped in one place, so it holds however the error was arrived at.
    if (result.error !== undefined) result.error = capError(result.error);

    return result;
};
