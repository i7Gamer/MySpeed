import { truncate } from '../helpers.js';

/**
 * The one wording a refusal is stored under, whichever provider refused and
 * however it phrased it.
 *
 * Exported because it is no longer only a display string: the backoff that holds
 * the schedule after a refusal is the reader, and the tests that walk that path
 * need to name what they are looking for without keeping a copy of it.
 */
export const RATE_LIMIT_MESSAGE = "Too many requests. Please try again later";

/**
 * What a refusal looks like before it is normalised.
 *
 * Matched rather than compared, and case-insensitively: the three CLIs word this
 * differently, the wording changes between their versions, and it arrives
 * wrapped in whatever else the line said - "Error: Too many requests received,
 * please try again later." Ookla is the one observed to send it (upstream #846,
 * #1092), and this is the phrase it and its API use.
 *
 * Deliberately only that phrase. A bare "429" would match a byte count, a server
 * id or an elapsed time just as readily, and reading an ordinary failure as a
 * refusal is the one direction this must not fail in: it would silence the
 * schedule for up to two hours over a dropped socket. Another provider's
 * phrasing is one alternation away when one is actually seen.
 */
const RATE_LIMIT_PATTERN = /too many requests/i;

export const isRateLimitMessage = (text) => typeof text === "string" && RATE_LIMIT_PATTERN.test(text);

/**
 * Applied on both paths a CLI can report an error by, so that the two agree.
 *
 * Only the stderr fallback below used to do this, and the JSON branch that reads
 * `data.error` did not - so the same refusal was stored under its own wording
 * depending on which stream the CLI chose to write it on. That was invisible
 * while the message was only ever read by a human; the backoff reads it now, and
 * a refusal it cannot recognise is one the schedule asks for again a minute
 * later.
 *
 * Anything that is not a string passes through untouched, because it is not this
 * function's business to decide what such a value means - capError below already
 * has that job.
 */
const normaliseError = (text) => isRateLimitMessage(text) ? RATE_LIMIT_MESSAGE : text;

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

const capError = (message) => truncate(message, MAX_ERROR_LENGTH);

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

// Whatever a CLI wrote that was not one of its own JSON records, i.e. the part
// a human wrote for a human.
const plainTextLines = (text) => text.trim().split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("{") && !line.startsWith("["))
    .join('\n');

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

            // The unwrap above can leave nothing behind, and this read used to
            // sit outside the try that would have caught it. `[]` is valid JSON
            // and is what librespeed prints when its backend is down, so
            // `data[0]` was undefined and `data.error` threw a TypeError - from
            // inside a child process's 'close' listener, which makes it an
            // uncaughtException rather than a rejected promise. A line that
            // parsed to no object is chatter, the same as one that did not
            // parse at all.
            if (data === null || typeof data !== "object") continue;

            if (data.error) result.error = normaliseError(data.error);

            if (isResult(mode, data)) {
                result = data;
                hasResult = true;
            }
        }
    }

    if (!hasResult && !result.error) {
        // stdout as a last resort, and only its plain-text lines. A CLI that
        // explains itself there with nothing on stderr - "Fatal: host
        // unreachable" and an immediate exit - parsed as neither a result nor
        // an error, and the caller's empty-result guard then blamed the
        // three-minute timeout for a run that had failed in the first second.
        // The JSON lines are skipped because they are progress records, not an
        // explanation: reporting those would make every interrupted run cite
        // its own progress log as the reason it stopped.
        const text = stderr.trim() || plainTextLines(stdout);

        if (text) result.error = normaliseError(text);
    }

    // Capped in one place, so it holds however the error was arrived at.
    if (result.error !== undefined) result.error = capError(result.error);

    return result;
};
