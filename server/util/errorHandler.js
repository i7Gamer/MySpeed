import fs from "node:fs";
import { describeError } from "./errorDetail.js";

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
const asError = (value) => {
    if (value instanceof Error) return value;

    try {
        return new Error(String(value));
    } catch {
        // An object with no prototype cannot be coerced to a string at all, and
        // this function is the uncaughtException handler - a throw in here ends
        // the process with neither the original error nor this one written
        // down. The last line of defence has to be unable to fail, so an
        // indescribable value is reported as being one.
        return new Error("An error that could not be described");
    }
};

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

    /**
     * The message with the parts sequelize keeps on the side put back.
     *
     * `reported.message` alone is "Validation error" for a whole class of
     * failures - upstream #1549 - and neither the console line nor the stack
     * below carries the column, the rule or the driver's code, all of which sit
     * on properties of the error. Taken from the original rather than from
     * asError's rewrapping, because that only ever produces a plain Error and
     * would have thrown those properties away.
     *
     * It reports no *values*, deliberately; errorDetail.js says why.
     */
    const described = describeError(error);

    console.error((context ?? "An error occurred") + ": " + described);

    // The stack, not the Error itself. Concatenating the Error calls toString(),
    // which is "Error: <message>" and nothing more - so the file held exactly
    // what the console line above already said, and the frames were dropped at
    // the one point they were being written down for. The log's own header
    // points bug reports here.
    //
    // A stack already begins with "Error: <message>", so this replaces the old
    // entry rather than adding to it. The fallbacks are for an Error that
    // carries no stack - built where Error.stackTraceLimit was 0, or assembled
    // by a caller - because this is the uncaughtException handler and
    // "undefined" is not an acceptable thing to write instead.
    const stack = reported.stack || reported.message || String(reported);

    // And the detail ahead of it when the stack does not already carry it. A
    // stack's first line is "Error: <message>", so for an ordinary error this
    // changes nothing; for the ORM errors describeError exists for, it is the
    // only place in the file the column and the rule appear at all - and this
    // file is the one the log's own header points bug reports at.
    const recorded = stack.includes(described) ? stack : described + "\n" + stack;

    fs.writeFile(filePath, lineStarter + "## " + date + "\n" + (context ? context + "\n" : "") + recorded,
        {flag: 'a+'}, err => {
            if (err) console.error("Could not save error log file.", reported);

            if (fatal) process.exit(1);
        });
};
