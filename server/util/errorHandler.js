import fs from "node:fs";
const filePath = process.cwd() + "/data/logs/error.log";

/**
 * Whatever was thrown, as an Error.
 *
 * A rejected promise carries anything at all - `throw "…"` and a plain object
 * both reach the catches that report through here - and `.message` on either is
 * undefined, so the console line read "An error occurred: undefined" and the
 * log recorded the same nothing. index.js normalised before calling; doing it
 * here means the callers that report a rejection do not each have to remember.
 */
const asError = (value) => value instanceof Error ? value : new Error(String(value));

/**
 * Records an error to data/logs/error.log.
 *
 * `fatal` decides whether the process goes down with it. An uncaught exception
 * leaves the runtime in an unknown state and is genuinely fatal; an unhandled
 * rejection usually is not, and exiting on one defeated the very handler that
 * was installed so "a single failing integration doesn't take the whole server
 * down" - a throw inside any integration callback ended the process.
 *
 * `context` says what was being attempted, which the message on its own does
 * not. The scheduled jobs catch their own rejections rather than leaving them
 * to the unhandledRejection handler, and reporting those with a bare
 * console.error would have kept them out of this file altogether - the one the
 * log's own header points bug reports at. "Could not open the database" says
 * nothing about which of the two schedules was the one that could not.
 */
export default (error, {fatal = true, context = null} = {}) => {
    const reported = asError(error);
    const date = new Date().toLocaleString();
    const lineStarter = fs.existsSync(filePath) ? "\n\n" : "# Found a bug? Report it here: https://github.com/i7Gamer/MySpeed/issues\n\n";

    console.error((context ?? "An error occurred") + ": " + reported.message);

    fs.writeFile(filePath, lineStarter + "## " + date + "\n" + (context ? context + "\n" : "") + reported,
        {flag: 'a+'}, err => {
            if (err) console.error("Could not save error log file.", reported);

            if (fatal) process.exit(1);
        });
};
