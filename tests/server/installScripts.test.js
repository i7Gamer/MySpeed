import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPTS = path.resolve(fileURLToPath(import.meta.url), "..", "..", "..", "scripts");

/**
 * Comments stripped before anything is asserted against a script.
 *
 * These scripts explain the bug they were fixed for right beside the fix, so an
 * assertion about the order of two commands otherwise matches the sentence
 * describing them. What is asserted is what the script runs, not what it says.
 */
const withoutComments = (source) => source
    .split("\n")
    .filter((line) => !/^\s*#/.test(line))
    .join("\n");

const read = (name) => withoutComments(fs.readFileSync(path.join(SCRIPTS, name), "utf8"));

// Every script that refuses to run without root.
const ROOT_GUARDED = ["chooser.sh", "docker-install.sh", "install.sh", "uninstall.sh"];

/**
 * The block a script runs when it finds it is not root, up to and including the
 * exit that ends it.
 */
const rootGuardOf = (source) => {
    const start = source.indexOf("$EUID -ne 0");
    assert.notEqual(start, -1, "the script no longer checks for root at all");

    const end = source.indexOf("fi", start);
    return source.slice(start, end);
};

describe("the root privilege guard", () => {
    /**
     * A bare `exit` returns the status of the last command that ran, which here
     * is the echo that just printed the refusal - so every one of these scripts
     * announced "ABORTED" and exited 0. Anything driving an install from a
     * pipeline read that as a success and carried on deploying against a
     * machine where nothing had been installed.
     */
    for (const name of ROOT_GUARDED) {
        it(`${name} exits non-zero when it is not root`, () => {
            const guard = rootGuardOf(read(name));

            assert.match(guard, /\bexit\s+[1-9]/,
                "the refusal exits with the status of its own echo, i.e. success");
        });
    }
});

describe("uninstall.sh --keep-data", () => {
    const source = read("uninstall.sh");

    /**
     * `mv $INSTALLATION_PATH/data /tmp/myspeed_data` behaves differently
     * depending on whether the destination already exists: with nothing there
     * it renames, and with a directory there it moves *into* it. A second
     * uninstall - or any leftover from an interrupted one - therefore produced
     * /tmp/myspeed_data/data, and the restore put that back as
     * /opt/myspeed/data/data. The database and settings were still on disk, one
     * level too deep for the server to find, which presents as total data loss
     * on a flag whose entire purpose is not losing data.
     */
    it("clears the staging directory before moving into it", () => {
        const keepData = source.slice(source.indexOf("--keep-data"));
        const stage = keepData.indexOf("mv");
        const clear = keepData.search(/rm\s+-[rR]f?\s+"?\/tmp\/myspeed_data/);

        assert.notEqual(clear, -1,
            "nothing removes a pre-existing /tmp/myspeed_data, so the move nests inside it");
        assert.ok(clear < stage, "the staging directory is cleared after the move, which is too late");
    });

    it("still restores the data directory afterwards", () => {
        assert.match(source, /mv\s+"?\/tmp\/myspeed_data"?\s+"?\$\{?INSTALLATION_PATH\}?\/data"?/);
    });

    /**
     * Unquoted, every one of these breaks on a path with a space in it - and
     * `rm -R $INSTALLATION_PATH` with the variable somehow empty is `rm -R`
     * against the working directory.
     */
    it("quotes the paths it moves and removes", () => {
        const dangerous = source.split("\n")
            .filter((line) => /^\s*(mv|rm|mkdir)\b/.test(line))
            .filter((line) => /\$\{?[A-Z_]+\}?/.test(line))
            .filter((line) => !/"\$\{?[A-Z_]+\}?/.test(line));

        assert.deepEqual(dangerous, [], "these lines interpolate a path without quoting it");
    });
});
