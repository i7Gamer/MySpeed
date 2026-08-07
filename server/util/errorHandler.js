import fs from "node:fs";
const filePath = process.cwd() + "/data/logs/error.log";

/**
 * Records an error to data/logs/error.log.
 *
 * `fatal` decides whether the process goes down with it. An uncaught exception
 * leaves the runtime in an unknown state and is genuinely fatal; an unhandled
 * rejection usually is not, and exiting on one defeated the very handler that
 * was installed so "a single failing integration doesn't take the whole server
 * down" - a throw inside any integration callback ended the process.
 */
export default (error, {fatal = true} = {}) => {
    const date = new Date().toLocaleString();
    const lineStarter = fs.existsSync(filePath) ? "\n\n" : "# Found a bug? Report it here: https://github.com/i7Gamer/MySpeed/issues\n\n";

    console.error("An error occurred: " + error.message);

    fs.writeFile(filePath, lineStarter + "## " + date + "\n" + error, {flag: 'a+'}, err => {
        if (err) console.error("Could not save error log file.", error);

        if (fatal) process.exit(1);
    });
};
