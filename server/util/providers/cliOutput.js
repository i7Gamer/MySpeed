const RATE_LIMIT_MESSAGE = "Too many requests. Please try again later";

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

            if ((mode === "ookla" && data.type === "result") || mode === "libre" || mode === "cloudflare") {
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
