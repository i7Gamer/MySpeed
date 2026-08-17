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

/**
 * Bun's default linux-x64 executable uses AVX2, so it dies with SIGILL on the
 * pre-Haswell Atoms and Celerons a great many home servers still are. The
 * release carries a baseline build beside it now, which only helps anyone if
 * the installer picks it - and the systemd unit written a few lines later has
 * Restart=always, so choosing wrong is a permanent crash loop rather than one
 * visible failure.
 */
describe("install.sh picks a Linux binary the CPU can run", () => {
    const source = read("install.sh");

    // The x86_64 case arm, up to the next one.
    const x86Branch = () => {
        const start = source.indexOf("x86_64)");
        const end = source.indexOf("aarch64|arm64)");

        assert.ok(start !== -1 && end !== -1 && start < end,
            "install.sh no longer chooses its binary per architecture");

        return source.slice(start, end);
    };

    it("chooses on the CPU's own AVX2 flag", () => {
        const branch = x86Branch();

        assert.match(branch, /avx2/, "every x86_64 CPU is handed the same binary again");
        assert.match(branch, /\/proc\/cpuinfo/, "the AVX2 decision is not made from what the CPU reports");
    });

    /**
     * A /proc it cannot read has to land on the baseline build as well: that one
     * runs on both, and the cost of guessing wrong in the other direction is an
     * install that never starts.
     */
    it("gives a CPU it cannot vouch for the baseline build", () => {
        const branch = x86Branch();
        const withoutAvx2 = branch.slice(branch.indexOf("else"));

        assert.match(branch, /2>\/dev\/null/,
            "an unreadable /proc/cpuinfo is an error rather than a decision");
        assert.match(withoutAvx2, /BINARY_NAME="MySpeed-linux-x64-baseline"/,
            "a CPU without AVX2 is handed the build that SIGILLs on it");
    });

    /**
     * The lookup was `grep "browser_download_url.*$BINARY_NAME"`, which is a
     * substring match. With a MySpeed-linux-x64-baseline asset in the release,
     * MySpeed-linux-x64 matches both lines, RELEASE_URL becomes two
     * newline-separated URLs, and `wget -O myspeed "$RELEASE_URL"` is handed
     * both - so shipping the baseline build broke the installer for every AVX2
     * machine the moment it existed.
     */
    /**
     * A rate limit, an outage, or no network at all answers with JSON that
     * carries no assets - which reads exactly like a release that happens not
     * to hold the file being looked for. The refusal below names the missing
     * asset as a fact and stops the install on it, so every failed API call
     * would be explained as a gap in the release. Nothing downstream can tell
     * the two apart, which makes this the only place it can be settled.
     */
    it("does not blame the release for an answer that was not one", () => {
        const fetched = source.indexOf("RELEASE_JSON=$(curl");
        const refusal = source.indexOf("BINARY_FALLBACK\" = \"MySpeed-linux-x64\"");

        assert.ok(fetched !== -1 && refusal !== -1 && fetched < refusal,
            "install.sh no longer fetches the release before it chooses a binary");

        assert.match(source.slice(fetched, refusal), /RELEASE_JSON[\s\S]*?exit\s+[1-9]/,
            "a response that is not a release reaches the refusal, which reports it as a missing asset");
    });

    /**
     * The fallback exists for the window where a release has one x64 build and
     * not the other, and it runs in both directions - but only one of them is
     * safe. Baseline runs on every x86_64 CPU, so an AVX2 machine falling back
     * to it loses nothing. The other way round installs a binary that SIGILLs on
     * every start, under a unit this script writes with Restart=always, and then
     * prints the completion banner over it: a permanent crash loop reported as a
     * finished install, which is the one outcome worse than stopping.
     */
    it("refuses to install the AVX2 build on a CPU without AVX2", () => {
        const start = source.indexOf("BINARY_FALLBACK\" = \"MySpeed-linux-x64\"");
        assert.notEqual(start, -1, "the fallback no longer distinguishes which direction it is going");

        const branch = source.slice(start, source.indexOf("\n    fi", start));

        assert.match(branch, /exit\s+[1-9]/,
            "the installer carries on to its success banner over a binary that cannot start here");
        assert.doesNotMatch(branch, /BINARY_NAME="?\$BINARY_FALLBACK/,
            "the AVX2 build is still selected for a CPU the script just found has no AVX2");
    });

    it("matches the release asset name exactly", () => {
        const start = source.indexOf("release_asset_url()");
        assert.notEqual(start, -1, "the release lookup is no longer a function this can read");

        const body = source.slice(start, source.indexOf("\n}", start));

        assert.match(body, /\$\{name\}\\"/,
            "the asset name is unanchored, so a longer name beginning with it matches as well");
        assert.match(body, /head -1/,
            "nothing bounds the lookup to one URL, so two assets become one unusable wget argument");
    });
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

/**
 * A failed download must not leave the box worse than it found it.
 *
 * `wget -O myspeed` opens and truncates the output file before the transfer
 * starts, so on an upgrade the working binary was destroyed the moment wget ran
 * - and there was no `set -e`, no exit check on the download, and no check on
 * the `cd` before it. Execution fell straight through to writing a
 * `Restart=always` unit, running `systemctl restart`, and printing
 * "✓ Installation completed" over a zero-byte executable in a permanent crash
 * loop, exiting 0 so a pipeline read it as a successful upgrade.
 *
 * The script already reasons about exactly this for the AVX2 fallback - "a
 * permanent crash loop, announced by the completion banner as a finished
 * installation. Stopping is the more useful answer" - and for the release
 * lookup. The download was the sibling left out.
 */
describe("install.sh survives a download that fails", () => {
    const source = read("install.sh");

    // The window from the download to the point the service is written, which is
    // where a failure has to stop.
    const downloadBlock = () => {
        const start = source.indexOf("INSTALLATION_PATH\"");
        const end = source.indexOf("Registering MySpeed as a background service");
        assert.ok(start !== -1 && end > start, "the download step is no longer recognisable");
        return source.slice(start, end);
    };

    it("does not write over the installed binary until the download succeeded", () => {
        assert.doesNotMatch(downloadBlock(), /wget\s+(-\S+\s+)*-O\s+myspeed\b/,
            "wget truncates its output file before the transfer, so this destroys a working install");
    });

    it("stops when the download fails", () => {
        const block = downloadBlock();

        const guarded = /set -e/.test(source)
            || /wget[^\n]*\|\|\s*\{/.test(block)
            || /if\s+!\s+wget/.test(block)
            || /\$\?/.test(block);

        assert.ok(guarded, "a failed download carries on to the service and the success banner");
    });

    it("refuses to continue if it could not reach the installation directory", () => {
        assert.match(source, /cd\s+"\$INSTALLATION_PATH"\s*\|\||set -e|if\s+!\s+cd\s/,
            "an unwritable or missing path leaves the binary in whatever directory the caller was in");
    });

    it("checks that what it downloaded is actually there", () => {
        assert.match(downloadBlock(), /-s\s+"?\$?\w*|\bstat\b|\bwc -c\b/,
            "a zero-byte file is chmod +x'd and started as though it were a binary");
    });
});
