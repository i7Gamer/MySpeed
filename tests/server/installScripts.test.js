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
    /**
     * The first attempt at this fix removed a pre-existing /tmp/myspeed_data
     * before staging into it. That does prevent the nesting, but it deletes the
     * data an *interrupted* uninstall left there - which is the one state where
     * /tmp holds the only surviving copy of the database. The old nesting bug
     * was recoverable by hand; deleting is not. A staging directory that is new
     * every run cannot collide with anything, so there is nothing to remove.
     */
    it("stages into a directory that cannot already exist", () => {
        const keepData = source.slice(source.indexOf('"--keep-data"'));

        assert.match(keepData, /mktemp\s+-d/,
            "the staging location is a fixed path, so it collides with an interrupted run");
        assert.doesNotMatch(keepData, /rm\s+-[rR]f?\s+"?\/tmp\/myspeed_data/,
            "this deletes the only copy of the data an interrupted uninstall left staged");
    });

    /**
     * The move is what puts the data somewhere safe; the rm is what makes it
     * unrecoverable. If the first fails - a full /tmp, a cross-device copy that
     * dies part way - the second must not run.
     */
    it("does not delete the installation unless the data reached safety", () => {
        const keepData = source.slice(source.indexOf('"--keep-data"'));
        const move = keepData.search(/\bmv\b/);
        const remove = keepData.search(/\brm\s+-R\b/);

        assert.ok(move !== -1 && remove !== -1);
        assert.match(keepData.slice(move, remove), /\|\||exit|&&/,
            "the staging move is unchecked, yet the original is deleted right after it");
    });

    it("still restores the data directory afterwards", () => {
        assert.match(source, /mv\s+"[^"]*"\s+"\$\{?INSTALLATION_PATH\}?\/data"/);
    });

    /**
     * Unquoted, every one of these breaks on a path with a space in it - and
     * `rm -R $INSTALLATION_PATH` with the variable somehow empty is `rm -R`
     * against the working directory.
     */
    /**
     * Every interpolation on the line, not just one of them. Filtering on
     * "does this line contain a quoted variable anywhere" passed a line with
     * one quoted and one bare path, which is precisely the mistake worth
     * catching - `mv "$SRC" $DEST` is as broken as quoting neither.
     */
    it("quotes every path it moves and removes", () => {
        const unquoted = source.split("\n")
            .filter((line) => /^\s*(mv|rm|mkdir)\b/.test(line))
            .filter((line) => {
                // Blank out every correctly quoted "$VAR" and see if any
                // interpolation is left standing outside quotes.
                const remaining = line.replace(/"[^"]*"/g, '""');
                return /\$\{?[A-Za-z_]+\}?/.test(remaining);
            });

        assert.deepEqual(unquoted, [], "these lines interpolate a path without quoting it");
    });
});

/**
 * Where the uninstaller looks, which was always /opt/myspeed.
 *
 * install.sh takes `-d <path>` and writes the chosen path into the systemd
 * unit's WorkingDirectory, so an installation can perfectly well be somewhere
 * else. The uninstaller hardcoded the default and parsed no options at all: it
 * stopped the service and deleted the unit file - the only record of where the
 * installation was - then ran `rm -R /opt/myspeed` against a path that had never
 * existed. With no `set -e` the failure went to stderr and was discarded, and
 * the script printed "MySpeed has been uninstalled" over an installation still
 * sitting on disk, password hash and full history included.
 *
 * The unit file is read rather than the flag merely being accepted, because the
 * operator uninstalling months later is not necessarily the one who chose the
 * path, and the system already knows the answer.
 */
describe("uninstall.sh finds the installation it is removing", () => {
    const source = read("uninstall.sh");

    it("reads the path back out of the systemd unit", () => {
        assert.match(source, /WorkingDirectory/,
            "the uninstaller never consults the unit file, which is where the real path is recorded");
        assert.match(source, /INSTALLATION_PATH="?\$/,
            "the installation path is never reassigned from what was discovered");
    });

    // Read before the systemd block deletes it, or there is nothing left to
    // read it from.
    it("reads it before deleting the unit file", () => {
        const recovered = source.indexOf("WorkingDirectory");
        const deleted = source.search(/rm\s+"?\/etc\/systemd/);

        assert.ok(recovered !== -1 && deleted !== -1, "the script no longer does both");
        assert.ok(recovered < deleted,
            "the unit file is deleted before its path is read, so the default is all that is left");
    });

    it("still accepts an explicit -d, as install.sh does", () => {
        assert.match(source, /-d\)/, "the uninstaller takes no -d, so a scripted install cannot be scripted away");
    });

    /**
     * And --keep-data has to survive the option parsing that -d arrives with.
     * It was read as a bare positional, so anything that consumes arguments in
     * front of it can silently turn the flag that preserves the database into
     * one that is never seen.
     */
    it("still recognises --keep-data alongside it", () => {
        assert.match(source, /--keep-data\)/,
            "--keep-data is no longer matched where the arguments are parsed");
        assert.doesNotMatch(source, /\[\s*"\$1"\s*[=!]=\s*"--keep-data"\s*\]/,
            "--keep-data is still read as the first positional, which -d displaces");
    });

    /**
     * The removal is the step that cannot be undone, and it was the one step
     * whose failure was ignored. Reporting success over a directory that is
     * still there is worse than the failure itself: it is what stops anyone
     * going to look.
     */
    it("does not report success when the removal failed", () => {
        // The plain branch, not the --keep-data one above it: that removal is
        // already guarded, by the staging move that has to succeed before it.
        //
        // Matched as a line of its own rather than as the substring "else",
        // which also occurs inside the very message this branch prints.
        const branches = [...source.matchAll(/^[ \t]*else[ \t]*$/gm)];
        assert.notEqual(branches.length, 0, "the uninstaller no longer branches on --keep-data");

        const plain = source.slice(branches[branches.length - 1].index, source.indexOf("Completed"));

        assert.match(plain, /rm\s+-R\s+"\$\{?INSTALLATION_PATH/,
            "the uninstaller no longer removes the installation directory");
        assert.match(plain, /if\s+!\s*rm|\|\||&&/,
            "the removal is unchecked, so a path that was never there fails silently");
        assert.match(plain, /exit\s+1/,
            "the script carries on to its success banner after a removal that did not happen");
    });
});
