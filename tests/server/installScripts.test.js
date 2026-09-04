import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import { execFileSync, spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPTS = path.resolve(fileURLToPath(import.meta.url), "..", "..", "..", "scripts");

// Long enough for a shell to start on a loaded runner, short enough that a walk
// which never terminates is reported rather than waited on.
const WALK_TIMEOUT = 10_000;

/**
 * Whether this machine has a POSIX shell to run a shell function in.
 *
 * One block below runs a function lifted out of install.sh, which needs `sh`.
 * That is always there on the Linux runner the suite gates releases on, and it
 * is not guaranteed on a contributor's Windows box: Git ships one, but only the
 * installer option that puts Git's Unix tools on PATH makes `sh` resolvable, so
 * without it node answers `spawnSync sh ENOENT` and four assertions fail for a
 * reason that has nothing to do with the script.
 *
 * Skipped there rather than failed, and skipped rather than pointed at a guessed
 * install path: install.sh is a Linux installer, CI is Linux, and a hard-coded
 * `C:\Program Files\Git\...` would be one more thing to be wrong about. The
 * runner prints the reason, so a skip cannot be mistaken for a pass.
 */
const noPosixShell = (() => {
    try {
        execFileSync("sh", ["-c", "exit 0"], {timeout: WALK_TIMEOUT, stdio: "ignore"});
        return false;
    } catch {
        return "no POSIX shell on PATH - install.sh is a Linux installer and this block runs a function from it";
    }
})();

/**
 * The directories the blocks below are run against, removed afterwards.
 *
 * Collected in one list rather than cleaned up per case, because a case that
 * fails half way through still has to give its temporary tree back.
 */
const temporary = [];

after(() => {
    for (const dir of temporary) fs.rmSync(dir, {recursive: true, force: true});
});

/**
 * Whether this machine lets an unprivileged process create a symlink.
 *
 * One block below builds a data directory of each shape install.sh distinguishes
 * between, and two of those shapes are links. Windows refuses symlink creation
 * unless the account holds SeCreateSymbolicLinkPrivilege or the machine is in
 * developer mode, so on a contributor's box node answers EPERM and the block
 * fails for a reason that has nothing to do with the script.
 *
 * Skipped there rather than failed, on the same terms as the shell check above:
 * install.sh is a Linux installer and CI is Linux, so the block runs where it
 * decides anything. The runner prints the reason, so a skip cannot be mistaken
 * for a pass.
 */
const noSymlinks = (() => {
    const probe = fs.mkdtempSync(path.join(os.tmpdir(), "myspeed-symlink-probe-"));

    try {
        fs.symlinkSync(path.join(probe, "target"), path.join(probe, "link"), "dir");
        return false;
    } catch {
        return "this machine does not allow creating symlinks - install.sh is a Linux installer and this block builds two";
    } finally {
        fs.rmSync(probe, {recursive: true, force: true});
    }
})();

/**
 * How a mode is read back: through the same `sh` the lifted block is run in,
 * because the mode being asserted is the one that block set through it.
 *
 * Two spellings, so the reader is not the reason a case fails: GNU stat takes
 * -c and BSD stat takes -f, and CI is the first but a contributor's box need
 * not be.
 */
const MODE_READER = 'mode() { stat -c "%a" "$1" 2>/dev/null || stat -f "%Lp" "$1"; }';

/**
 * Whether this machine reports real file modes.
 *
 * The block below states 700 for a data directory it creates and takes the
 * world bits off one it finds, and both of those are assertions about a number
 * that only exists on a POSIX filesystem. Windows answers 755 for everything -
 * `chmod 705` reads back as 755 there - so these cases would not fail, they
 * would pass or fail on whatever that host invents, which is worse than not
 * running them.
 *
 * Probed rather than assumed from `process.platform`, on the same terms as the
 * symlink check above: what matters is whether the mode set here comes back,
 * not which operating system is setting it. The probe carries a bit in each
 * triad, so a host answering with a fixed 755 is told apart from an honest one.
 */
const PROBE_MODE = 0o705;

const noModes = (() => {
    const probe = fs.mkdtempSync(path.join(os.tmpdir(), "myspeed-mode-probe-"));

    try {
        fs.chmodSync(probe, PROBE_MODE);

        const read = execFileSync("sh", ["-c", `${MODE_READER}\nmode "$TARGET"`], {
            encoding: "utf8",
            timeout: WALK_TIMEOUT,
            env: {...process.env, TARGET: probe}
        }).trim();

        return read === PROBE_MODE.toString(8)
            ? false
            : `this machine does not report real file modes - ${PROBE_MODE.toString(8)} reads back as ${read}`;
    } catch {
        return "no POSIX shell to read a file mode with - install.sh is a Linux installer and these cases assert the mode it leaves";
    } finally {
        fs.rmSync(probe, {recursive: true, force: true});
    }
})();

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
    /**
     * The directory it puts back is the one the next install.sh will judge.
     *
     * mkdir applies the umask, and root on a hardened host runs with 027 or 077,
     * so the recreated directory comes out 0750 or 0700. install.sh then walks
     * it with reachable_by_service, finds it cannot be entered by an
     * unprivileged account, and falls back to SERVICE_ACCOUNT="root" - so
     * reinstalling over kept data silently gives up the privilege separation the
     * previous install had, and runs the downloaded speedtest CLIs as root.
     *
     * The flag exists to make the reinstall the easy path, which is exactly why
     * this one has to come back the way it went.
     */
    it("puts the directory back in a mode the service account can enter", () => {
        const keepData = source.slice(source.indexOf('"--keep-data"'));
        const made = keepData.indexOf('mkdir "$INSTALLATION_PATH"');
        const stated = keepData.indexOf('chmod 755 "$INSTALLATION_PATH"');

        assert.notEqual(made, -1, "the installation directory is no longer recreated");
        assert.notEqual(stated, -1,
            "the recreated directory's mode is left to the umask, so the next install falls back to root");
        assert.ok(made < stated, "the directory is recreated after its mode is stated, which undoes it");
    });

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
    // read it from. The deletion walks SERVICE_FILES with a guarded rm now -
    // it used to spell both paths out, and removed the one install.sh never
    // creates unguarded - so the ordering is measured against that loop.
    it("reads it before deleting the unit file", () => {
        const recovered = source.indexOf("WorkingDirectory");
        const deleted = source.search(/rm -f "\$unit"/);

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

    /*
     * What that removal does when it fails is asserted by running it, in
     * uninstallBehaviour.test.js.
     *
     * It was asserted here by slicing the source from its last bare `else` to
     * the success banner and looking for a check inside the slice. The window
     * was the --keep-data branch when it was written; a later block added an
     * `else` nearer the banner, the window moved onto a message being printed,
     * and all three assertions went on passing against code that has nothing to
     * do with removing anything.
     */
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
        const start = source.indexOf("DOWNLOAD_TMP=");
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

/**
 * The service the installer registers, which ran as uid 0.
 *
 * MySpeed listens on 5216, writes its database and logs under its own
 * installation directory, and downloads a third-party speedtest CLI at first
 * boot which it then spawns - none of which needs any privilege at all. Running
 * the whole of that as root meant a replaced upstream asset, or any remote-code
 * flaw in the server, executed with full access to the host filesystem. The
 * Docker path for the same code already drops to an unprivileged user.
 *
 * The account is created before the unit names it, and the installation is
 * handed over before the service is started - otherwise the first thing the new
 * user does is fail to open a root-owned database, which is what an upgrade of
 * an existing install would hit.
 */
describe("install.sh registers a service that is not root", () => {
    const source = read("install.sh");
    const unitStart = source.indexOf("[Unit]");
    const unit = source.slice(unitStart, source.indexOf("EOF", unitStart));

    /**
     * Where a top-level block opens, which is the start of a line.
     *
     * The same condition can be asked again inside another block: the refusal
     * at the top of the script tests `[ -L ]` on this path a second time,
     * indented within itself, to choose between the wording for a link and the
     * wording for a plain file. A bare substring search for the arms' opening
     * finds that nested test first and every arm below is sliced out of the
     * refusal instead - so what is searched for is the opening in the column an
     * opening is in.
     */
    const opensAt = (opening) => {
        const at = source.indexOf(`\n${opening}`);

        return at === -1 ? -1 : at + "\n".length;
    };

    it("does not run the service as root", () => {
        assert.doesNotMatch(unit, /User=root\b/,
            "the service still runs as uid 0, with the downloaded CLI under it");
    });

    it("runs it as an account chosen before the unit is written", () => {
        assert.match(unit, /User=\$SERVICE_ACCOUNT\b/,
            "the unit names no account of its own");

        const chosen = source.indexOf("SERVICE_ACCOUNT=");

        assert.notEqual(chosen, -1, "nothing ever decides which account the service runs as");
        assert.ok(chosen < unitStart,
            "the account is chosen after the unit that names it has already been written");
    });

    it("creates the account before it hands anything to it", () => {
        // The invocation, not the word. `command -v useradd` guards the call and
        // carries the same name, so a script that only ever asks whether useradd
        // exists satisfies any test written against /useradd/ - and then falls
        // back to root on every host, having created nothing.
        const created = source.replace(/\\\r?\n\s*/g, " ")
            .split("\n").find((line) => /^\s*useradd\s/.test(line));

        assert.ok(created, "nothing runs useradd - the only mention of it is the check for whether the host has it");
        assert.match(created, /--system\b/, "the account is created as a login account rather than a system one");
        assert.match(created, /"\$SERVICE_USER"/, "useradd is given some other name than the one the unit holds");
        assert.ok(source.indexOf("useradd") < source.indexOf("chown"),
            "the installation is handed to an account that does not exist yet");
    });

    /**
     * An upgrade is the case this exists for: the files are there already, and
     * they are owned by root because that is what installed them.
     */
    it("hands the installation to the account that will run it", () => {
        assert.match(source, /chown -Rh "\$SERVICE_USER" "\$INSTALLATION_PATH\/data" "\$INSTALLATION_PATH\/bin"/,
            "the new account cannot write the database it inherits");
        assert.ok(source.indexOf("chown") < unitStart,
            "the service is registered before it can read its own directory");
    });

    /**
     * And keeps the database out of every other account's reach.
     *
     * storage.db carries the admin password hash and the integration secrets,
     * and the server creates it inside data/ under systemd's default 022 umask -
     * 0644 in a 0755 directory, which any local account can read. chown decides
     * who owns the directory; the mode is what decides who else may walk into it,
     * and mkdir leaves that to the umask. The installation root stays 755 for the
     * reachability the service needs above it; the data directory needs the
     * opposite, so it is stated rather than inherited, the way the root's is.
     *
     * And on both branches, which is the part the position assertions are for.
     * The mode first sat inside `if [ "$SERVICE_ACCOUNT" = "$SERVICE_USER" ]`,
     * beside the chown that genuinely belongs there - so the root fallback, taken
     * when the host has no useradd or the path cannot be reached by an
     * unprivileged account, created no data directory at all and left the
     * server's own helper to make one at the umask's 0755. The installs the
     * script prints a warning about were the installs that got no mode.
     *
     * Hoisting it above that branch left a bare `mkdir -p` and an unconditional
     * `chmod 700`, which is a different thing from stating the mode of a
     * directory this script makes. It also retightened one it did not - silently
     * overruling an operator who had opened the directory to a backup group, the
     * very thing this script says it will not do ten lines above - and it did
     * that as root, through whatever the path turned out to be. So the arms
     * below, which are the three the server's own folder helper describes too.
     */
    describe("the mode of the data directory", () => {
        /**
         * The block that decides it, bounded by the `fi` that closes it.
         *
         * Every arm is read out of this rather than out of the script at large:
         * "install.sh contains a chmod 700 somewhere" is satisfied by the
         * installation root's own mode two hundred lines above, which is a
         * different decision about a different directory.
         */
        const block = () => {
            // The `; then` is what tells this block from the precondition at
            // the top of the file, which asks `[ -L ]` about the same path.
            // Kept on the anchor rather than trimmed to the shortest spelling
            // that happens to be unique today: the precondition's condition is
            // the half of the pair that gets rewritten, and every arm below is
            // read out of whichever of the two this lands on.
            const at = opensAt('if [ -L "$INSTALLATION_PATH/data" ]; then');

            assert.notEqual(at, -1,
                "nothing asks whether data is a symlink, so a chmod runs as root through a link and lands on the far end of it");

            const end = source.indexOf("\nfi\n", at);
            assert.notEqual(end, -1, "the block deciding the data directory's mode is never closed");

            return source.slice(at, end);
        };

        // Its three cases: a symlink, a directory that is not there yet, and one
        // that is.
        //
        // The elif is located by its whole condition rather than by the keyword,
        // which is what the `[ -L ]` line above already does for the arm it
        // opens. Anchored on `elif ` alone, the three arms are still sliced
        // apart when the condition itself is wrong: inverting it to `[ -d ]`
        // leaves every case below green while the script creates nothing at all
        // on a fresh install and retightens a directory it merely found to 700 -
        // which is the one thing the arm beneath it exists to refuse.
        const arms = () => {
            const decision = block();
            const created = decision.search(/^elif \[ ! -d "\$INSTALLATION_PATH\/data" \]/m);
            const existing = decision.search(/^else$/m);

            assert.notEqual(created, -1,
                "the arm that creates the data directory no longer asks whether it is missing, so it runs against one that is already there");
            assert.ok(existing > created,
                "the block no longer separates a data directory this script makes from one it finds already there");

            return {
                symlinked: decision.slice(0, created),
                created: decision.slice(created, existing),
                existing: decision.slice(existing)
            };
        };

        it("states 700 for the one it creates itself", () => {
            assert.match(arms().created, /chmod 700 "\$INSTALLATION_PATH\/data"/,
                "a data directory this script creates keeps the umask's mode, so a world-readable storage.db is reachable by any local account");

            const stated = source.indexOf('chmod 700 "$INSTALLATION_PATH/data"');

            assert.notEqual(stated, -1, "nothing states the mode of the data directory");
            assert.ok(stated < unitStart,
                "the mode is stated after the service has already been registered");
        });

        /**
         * And does not reach that chmod when the mkdir failed, which is the check
         * the installation root's own creation already carries: `[ ! -d ]` is
         * true for a path taken by a regular file, there is no `set -e`, and an
         * unchecked chmod then runs as root against whatever is at that path.
         */
        it("refuses rather than stating a mode for something it did not create", () => {
            const created = arms().created;

            assert.match(created, /if\s+!\s+mkdir -p "\$INSTALLATION_PATH\/data"/,
                "the mkdir is unchecked, so the chmod below it runs against whatever is already at that path");
            assert.match(created, /exit\s+[1-9]/,
                "a failed mkdir falls through to the rest of the install, which has nowhere to write");
            assert.match(created, /Could not create \$INSTALLATION_PATH\/data/,
                "the failure is silent, and the run aborts later for a reason that names something else");
        });

        /**
         * A directory that was already there is the operator's and its mode is
         * theirs, which is the policy this script states beside the installation
         * root's own chmod and the one server/util/createFolders.js cites.
         *
         * Which leaves the exposure that policy was covering. An older installer
         * created data at the umask's 0755, so every installation made before the
         * mode was stated carries a world-readable storage.db, and an upgrade is
         * the only moment anything is in a position to notice. The world bits are
         * the part no operator chooses on purpose, so those come off and nothing
         * else does: a data directory deliberately shared with a backup group at
         * 0750 root:backup is still 0750 root:backup afterwards.
         */
        it("takes only the world bits off one it did not create", () => {
            const existing = arms().existing;

            assert.match(existing, /chmod o-rwx "\$INSTALLATION_PATH\/data"/,
                "a data directory an older installer left at 0755 keeps it, so storage.db stays readable by every local account after an upgrade");
            assert.doesNotMatch(existing, /chmod\s+[0-7]{3,4}\b/,
                "an existing installation is retightened to an absolute mode, overruling an operator who shared it with a group on purpose");
        });

        /**
         * And a data directory the operator moved elsewhere is not touched at
         * all. chmod follows a symlink, so a mode stated here lands on the far
         * end of it - a relocated data directory on another volume, whose mode
         * was decided somewhere this script cannot see, or a link planted under
         * a compromise of the unprivileged account that writes this path.
         *
         * docker-entrypoint.sh's `chown -h` is not the precedent this used to
         * cite. That -h is about the links the server can plant *inside* a
         * volume the container does own; whether the root of the volume may
         * itself be a link is a different question, and the container never
         * asks it.
         */
        it("leaves a relocated one entirely alone", () => {
            const symlinked = arms().symlinked;

            assert.doesNotMatch(symlinked, /\bchmod\b/,
                "a chmod runs as root through the symlink and lands on whatever the operator pointed data at");
            assert.doesNotMatch(symlinked, /\bmkdir\b/,
                "the link's own target is created underneath it, or the mkdir fails and takes the install down with it");
            assert.doesNotMatch(symlinked, /\bexit\b/,
                "the arm refuses down here, past the point where the service has been stopped and the binary replaced");
        });

        /*
         * A link the server could never open - one pointing at nothing, or at a
         * regular file - is refused rather than warned about, and the refusal is
         * no longer in this arm at all: it is a precondition, and it is asserted
         * where the preconditions are, in "a data link the server could never
         * open" below. What is left here acts on nothing, which is what the two
         * assertions above and the one on `exit` say.
         */

        /**
         * And for a link that does point somewhere, the warning has to say the
         * whole of what is left as it was found.
         *
         * It said "permissions", which reads as the mode alone - and the mode is
         * the half that matters least here. `chown -Rh` never follows a symlink
         * - the -h states what GNU's -P default already did - so the handover a
         * few lines below changes the link itself and never the directory at
         * the far end: the service account is left unable to open storage.db,
         * and the only thing that said so was a sentence about permissions.
         */
        it("names the ownership it leaves alone, and the account that needs it", () => {
            const symlinked = arms().symlinked;

            assert.match(symlinked, /ownership/,
                "the warning names only the mode, while the chown below it silently misses the target as well");
            assert.match(symlinked, /\$SERVICE_ACCOUNT\b/,
                "the operator is not told which account has to be able to read and write the directory they pointed data at");
        });

        it("decides all of it whichever account the service ends up running as", () => {
            const branch = source.indexOf('if [ "$SERVICE_ACCOUNT" = "$SERVICE_USER" ]');
            assert.notEqual(branch, -1, "nothing chooses between the service account and the root fallback any more");

            const decided = opensAt('if [ -L "$INSTALLATION_PATH/data" ]; then');
            assert.notEqual(decided, -1, "nothing decides the data directory's mode at all");
            assert.ok(decided < branch,
                "the root fallback creates no data directory, so the server's own helper makes one on first boot instead");

            const stated = source.indexOf('chmod 700 "$INSTALLATION_PATH/data"');
            assert.notEqual(stated, -1, "nothing states the mode of the data directory");
            assert.ok(stated < branch,
                "the mode is stated inside the service-account branch only, so the fallback install leaves storage.db world-readable");
        });
    });

    /**
     * The one question about that directory that is a precondition rather than a
     * decision, asked where the preconditions are.
     *
     * It used to be the first thing inside the symlink arm, which is a hundred
     * and fifty lines past the point of no return: `systemctl stop myspeed` has
     * run and `mv -f "$DOWNLOAD_TMP" myspeed` has already replaced the binary.
     * So an upgrade whose data target simply was not mounted yet - a NAS that
     * comes up after the box does - was refused into a deliberately stopped
     * service with nothing to restart it, which is worse than the installer that
     * had no refusal at all and at least came back on the next boot.
     *
     * Root and the CPU's AVX2 are both settled before that stop, and the two
     * download failures say "any existing installation has been left untouched"
     * because they run before the move. This one can say it too now.
     */
    describe("a data link the server could never open", () => {
        // The refusal, bounded by the `fi` that closes it. Located by its whole
        // condition rather than by the `[ -L ]` inside it: the arm two hundred
        // lines below tests the same thing on the same path, and a bound taken
        // from the shorter spelling reads whichever of the two comes first.
        const CONDITION = 'if { [ -L "$INSTALLATION_PATH/data" ] || [ -e "$INSTALLATION_PATH/data" ]; } && [ ! -d "$INSTALLATION_PATH/data" ]';

        const refusal = () => {
            const at = source.indexOf(CONDITION);

            assert.notEqual(at, -1,
                "nothing asks, before anything on the box has been touched, whether the data link points at something a database can live in");

            const end = source.indexOf("\nfi\n", at);
            assert.notEqual(end, -1, "the refusal is never closed");

            return source.slice(at, end);
        };

        /**
         * Position is the whole of it. A precondition evaluated after the
         * destructive midpoint is not a precondition; it is a way of ending an
         * upgrade half done.
         */
        it("asks before the service is stopped and the binary replaced", () => {
            const asked = source.indexOf(CONDITION);
            const stopped = source.indexOf("systemctl stop myspeed");
            const replaced = source.indexOf('mv -f "$DOWNLOAD_TMP" myspeed');

            assert.notEqual(asked, -1, "nothing refuses a data link the server could never open");
            assert.ok(stopped !== -1 && replaced !== -1,
                "the installer no longer stops the service or moves the download into place");

            assert.ok(asked < stopped,
                "the refusal runs after `systemctl stop`, so an upgrade whose data target is not mounted yet is left deliberately stopped with nothing to restart it");
            assert.ok(asked < replaced,
                "the refusal runs after the downloaded binary has already replaced the installed one");
        });

        // And says so, which is the sentence the download failures already get
        // to print and this one could not.
        it("tells the operator nothing has been touched", () => {
            assert.match(refusal(), /[Nn]othing has been touched/,
                "the refusal leaves the operator to work out for themselves whether the service was stopped or the binary replaced");
        });

        /**
         * And it is the shape of the target that decides, not whether one is
         * there.
         *
         * `[ ! -e ]` follows the link, so a target that is a regular file - a
         * NAS export not yet mounted with a stale file left at the name, a path
         * that was never a directory - answered "the target exists" and took the
         * mild warning. The install then completed over a server whose first
         * storage.db open fails ENOTDIR, under a unit with Restart=always: the
         * identical boot-fatal outcome, dispatched to the identical wrong arm.
         * `[ ! -d ]` is true of both and false only for the shape that works.
         */
        it("refuses a link to a file as well as one to nothing", () => {
            const block = refusal();

            assert.match(block, /\[ ! -d "\$INSTALLATION_PATH\/data" \]/,
                "the refusal asks whether the target exists, which a regular file does - and the first storage.db open then fails ENOTDIR");
            assert.match(block, /is not a directory/,
                "a link to a file is refused with the message written for one pointing at nothing");
            assert.match(block, /does not exist/,
                "a link pointing at nothing is refused with the message written for one pointing at a file");
        });

        /**
         * And a plain regular file at that path, which is not a link and so was
         * never asked about at all.
         *
         * `[ -L ]` is false for it, so the whole precondition was skipped and
         * the shape was left to the mkdir two hundred lines below - past
         * `systemctl stop myspeed` and past the move that replaces the binary.
         * The same boot-fatal path, refused from the same wrong side of the
         * midpoint the hoist exists to get in front of.
         *
         * A bare `[ ! -d ]` cannot be the fix: a fresh install has nothing at
         * that path and `! -d` is true of nothing too, so every first install
         * would be refused. The `[ -L ]` cannot go either, because `-e` follows
         * a link and answers false for the dangling one this block was written
         * for. It takes all three.
         */
        it("asks about a plain file at that path, not only about a link", () => {
            const opening = refusal().split("\n")[0];

            assert.match(opening, /\[ -e "\$INSTALLATION_PATH\/data" \]/,
                "a regular file at the data path is not a link, so the refusal never sees it and the mkdir past the point of no return does");
            assert.match(opening, /\[ -L "\$INSTALLATION_PATH\/data" \]/,
                "-e follows a link, so a link pointing at nothing answers false to it and the dangling case stops being refused");
            assert.match(opening, /\[ ! -d "\$INSTALLATION_PATH\/data" \]/,
                "the refusal no longer asks what shape the path is, so a fresh install with nothing there is refused along with the file");
        });

        it("names the target, and where a relative one is resolved", () => {
            const block = refusal();

            assert.match(block, /readlink/,
                "the refusal never names the target, which is the one thing the operator has to go on");
            assert.match(block, /resolved against/,
                "a relative target is resolved against the link's own directory, and the operator is left to guess which directory that is");
        });

        // Pinned the way the root guard's is: a bare `exit` carries the status
        // of the echo that just printed the refusal, which is success.
        it("exits non-zero, so a pipeline does not read it as an install", () => {
            assert.match(refusal(), /\bexit\s+[1-9]/,
                "the refusal exits with the status of its own echo, i.e. success");
        });
    });

    /**
     * And which arm it actually takes, run rather than read.
     *
     * Reading says a refusal is written down somewhere in the symlink arm. It
     * does not say a dangling link reaches it: the conditions dispatching
     * between "a link to somewhere", "a link to nothing" and "no directory yet"
     * are three `[` tests, and every assertion above is satisfied whichever way
     * round they are - which is precisely how the missing `[ ! -d ]` pin went
     * unnoticed until a mutation found it.
     */
    /**
     * A whole `if` block including the `fi` that closes it, so what runs here is
     * what the installer runs.
     */
    const closedBlock = (opening, missing) => {
        const at = opensAt(opening);
        assert.notEqual(at, -1, missing);

        const end = source.indexOf("\nfi\n", at);
        assert.notEqual(end, -1, `${missing} - the block is never closed`);

        return source.slice(at, end + "\nfi".length);
    };

    /**
     * Both blocks that look at the data directory, in the order the installer
     * reaches them: the precondition at the top of the file, then the three arms
     * that decide the mode two hundred lines below.
     *
     * Both, because either alone answers a different question from the one being
     * asked. The refusal without the arms says nothing about which shape reaches
     * which arm; the arms without the refusal put a link the installer would
     * have stopped for straight into the warning, which is exactly the dispatch
     * that was wrong before the refusal was hoisted.
     *
     * The arms are located by the `; then` on the end of their condition. The
     * refusal asks `[ -L ]` about the same path, so a shorter spelling risks
     * matching that one first, and the rig would then run the precondition twice
     * and the arms not at all.
     */
    const decision = () => [
        closedBlock('if { [ -L "$INSTALLATION_PATH/data" ] || [ -e "$INSTALLATION_PATH/data" ]; } && [ ! -d "$INSTALLATION_PATH/data" ]',
            "nothing refuses a data path the server could never open"),
        closedBlock('if [ -L "$INSTALLATION_PATH/data" ]; then',
            "nothing asks whether data is a symlink")
    ].join("\n");

    /**
     * Against a real installation directory this builds, with the colours
     * emptied and the delay stubbed out - the arms pause two seconds so an
     * operator reads the warning, which is two seconds a case here and
     * nothing to do with what is being asserted.
     *
     * SERVICE_ACCOUNT is bound because the block reads it, and the script
     * settles it well above this point.
     */
    const decide = (build) => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "myspeed-datalink-"));
        temporary.push(dir);
        build(dir);

        const script = [
            "sleep() { :; }",
            'RED=""; NORMAL=""; YELLOW=""',
            'SERVICE_ACCOUNT="myspeed"',
            'INSTALLATION_PATH="$TARGET"',
            decision()
        ].join("\n");

        const run = spawnSync("sh", ["-c", script], {
            encoding: "utf8",
            timeout: WALK_TIMEOUT,
            env: {...process.env, TARGET: dir}
        });

        return {status: run.status, output: `${run.stdout ?? ""}${run.stderr ?? ""}`, dir};
    };

    // The type is what Windows needs to be told and POSIX ignores, so the case
    // that points the link at a file says so rather than building a directory
    // link over one.
    const link = (dir, target, type = "dir") => {
        fs.symlinkSync(path.join(dir, target), path.join(dir, "data"), type);
    };

    // A directory of the given mode where the block expects to find one. Stated
    // with chmod rather than through mkdir's argument, because mkdir's is masked
    // by the umask and the whole question here is which bits survive.
    const seedData = (target, mode) => {
        const data = path.join(target, "data");

        fs.mkdirSync(data);
        fs.chmodSync(data, mode);
    };

    // Read back through the sandbox's own sh, so what is asserted is the mode
    // the block set rather than node's idea of it.
    const modeOf = (dir, name) => execFileSync("sh", ["-c", `${MODE_READER}\nmode "$TARGET"`], {
        encoding: "utf8",
        timeout: WALK_TIMEOUT,
        env: {...process.env, TARGET: `${dir}/${name}`}
    }).trim();

    /**
     * Gated per case rather than as a block, because only three of these
     * shapes are links.
     *
     * The block asked for a shell and for symlinks together, so a contributor
     * whose account does not hold SeCreateSymbolicLinkPrivilege lost all six -
     * including the plain file at the data path, the fresh install and the
     * ordinary upgrade, none of which creates a link at all. Those three are
     * the arms an install actually takes, and they were the ones left unrun on
     * the machine the change was being written on.
     */
    describe("which arm a data directory of each shape reaches",
        {skip: noPosixShell}, () => {

        it("stops the install when the link points at nothing", {skip: noSymlinks}, () => {
            const {status, output} = decide((dir) => link(dir, "elsewhere"));

            assert.notEqual(status, 0,
                "a dangling data link runs on to the completion banner, and the server then throws on its first boot under Restart=always");
            assert.match(output, /elsewhere/,
                "the refusal does not name the target that is missing");
        });

        /**
         * And when it points at a regular file, which is the same shape.
         *
         * `[ -e ]` follows the link, so a target that happens to be a file -
         * a NAS export that is not mounted yet and leaves a stale file at that
         * name, a path that was never a directory - answered "the target is
         * there", collected the mild warning, and the install ran on to its
         * completion banner. The server's first storage.db open then fails
         * ENOTDIR, under the unit this script writes with Restart=always: the
         * identical boot-fatal outcome the dangling case is refused for.
         */
        it("stops the install when the link points at a file", {skip: noSymlinks}, () => {
            const {status, output} = decide((dir) => {
                fs.writeFileSync(path.join(dir, "elsewhere"), "");
                link(dir, "elsewhere", "file");
            });

            assert.notEqual(status, 0,
                "a data link pointing at a file takes the mild warning, and the server's first database open then fails ENOTDIR under Restart=always");
            assert.match(output, /elsewhere/,
                "the refusal does not name the target that cannot hold a database");
        });

        /**
         * And when the data path is a plain regular file rather than a link.
         *
         * It is the shape the two cases above are refused for, minus the `-L`
         * that dispatched them: a NAS export that was never mounted and left a
         * stale file at the name, a path that was never a directory. The
         * precondition skipped it, so the run went on to stop the service and
         * replace the binary, and died two hundred lines lower at the mkdir
         * this file's own path had already taken - deliberately stopped, with
         * nothing left to restart it.
         */
        it("stops the install when a plain file sits at the data path", () => {
            const {status, output} = decide((dir) => fs.writeFileSync(path.join(dir, "data"), ""));

            assert.notEqual(status, 0,
                "a regular file at the data path is installed over, and the server's first database open then fails ENOTDIR under Restart=always");
            assert.match(output, /Nothing has been touched/,
                "the run is stopped past the point of no return, with the service down and nothing left to restart it");
            assert.match(output, /is not a directory/,
                "the operator is not told what is wrong with the path they have a file at");
            assert.doesNotMatch(output, /is a link to/,
                "a plain file is announced as a link, and readlink prints nothing where the target it names should be");
        });

        it("leaves a link that points somewhere exactly as it found it", {skip: noSymlinks}, () => {
            const {status, output, dir} = decide((target) => {
                fs.mkdirSync(path.join(target, "elsewhere"));
                link(target, "elsewhere");
            });

            assert.equal(status, 0, "a relocated data directory stops an install that has nothing wrong with it");
            assert.match(output, /Warning/, "nothing tells the operator what was left as it was found");
            assert.ok(fs.lstatSync(path.join(dir, "data")).isSymbolicLink(),
                "the link itself was replaced by something else");
            assert.deepEqual(fs.readdirSync(path.join(dir, "elsewhere")), [],
                "something was created inside the directory the operator pointed data at");
        });

        // And the ordinary path is still the ordinary path: neither refusal
        // reaches an installation that simply has no data directory yet.
        it("creates one that is not there at all", () => {
            const {status, dir} = decide(() => {});

            assert.equal(status, 0, "a fresh install is refused");
            assert.ok(fs.statSync(path.join(dir, "data")).isDirectory(),
                "the data directory is never created, so the server has nowhere to write its database");
        });

        /**
         * And the arm none of the cases above reaches, which is the upgrade -
         * the case the whole series is about.
         *
         * It was not run at all. With `chmod o-rwx` replaced by `exit 9` in a
         * copy of this block, every case above stayed green: the two link
         * shapes take the first arm and a fresh install takes the second, so
         * nothing here had ever executed the third.
         */
        it("runs the arm for a data directory that is already there", () => {
            const {status, output} = decide((target) => fs.mkdirSync(path.join(target, "data")));

            assert.equal(status, 0, "an ordinary upgrade stops an install that has nothing wrong with it");
            assert.doesNotMatch(output, /ABORTED|Warning/,
                "an upgrade over a plain data directory is dispatched to a refusal or to the link warning");
        });
    });

    /**
     * And what each arm leaves behind, which is a number rather than an exit
     * status and so needs a filesystem that reports one.
     *
     * No case asserted a mode at all, on any arm. The `chmod o-rwx` above could
     * be swapped for `chmod 700` in a copy of the block - which is the one thing
     * the arm exists not to do, silently overruling an operator who had opened
     * the directory to a backup group - and the rig stayed green throughout,
     * because a mode nothing reads is a mode nothing can be wrong about.
     */
    describe("the mode each arm leaves on the data directory",
        {skip: noPosixShell || noModes}, () => {

        // What an installer older than the stated 700 left behind, what an
        // operator sharing the directory with a backup group chose, and what
        // each of the two arms is supposed to answer with.
        const OLDER_INSTALLER = 0o755;
        const SHARED_WITH_A_GROUP = 0o750;
        const STATED_FOR_A_NEW_ONE = "700";
        const LEFT_ON_AN_EXISTING_ONE = "750";

        // And the same directory with the group given write access, which is
        // the only fixture that tells `o-rwx` from the absolute modes that
        // satisfy the two above. 0755 and 0750 both read back 750 after
        // `chmod o-rwx`, after `chmod 750`, and after `chmod o-rwx,g-w`; 0770
        // reads back 770 after the first and 750 after either of the others.
        const GROUP_MAY_WRITE = 0o770;
        const LEFT_ON_A_GROUP_WRITABLE_ONE = "770";

        it("states 700 for one it creates itself", () => {
            const {status, dir} = decide(() => {});

            assert.equal(status, 0, "a fresh install is refused");
            assert.equal(modeOf(dir, "data"), STATED_FOR_A_NEW_ONE,
                "the data directory is created at whatever the umask allows, so storage.db is readable by every local account");
        });

        it("takes the world bits off one an older installer left at 0755", () => {
            const {status, dir} = decide((target) => seedData(target, OLDER_INSTALLER));

            assert.equal(status, 0, "an ordinary upgrade stops an install that has nothing wrong with it");
            assert.equal(modeOf(dir, "data"), LEFT_ON_AN_EXISTING_ONE,
                "a data directory an older installer left at 0755 keeps it, so storage.db stays readable by every local account after an upgrade");
        });

        // The other direction, and the one an absolute mode gets wrong: 0750
        // root:backup is a decision, and it is still 0750 root:backup after.
        it("leaves the group an operator opened it to alone", () => {
            const {status, dir} = decide((target) => seedData(target, SHARED_WITH_A_GROUP));

            assert.equal(status, 0, "an ordinary upgrade stops an install that has nothing wrong with it");
            assert.equal(modeOf(dir, "data"), LEFT_ON_AN_EXISTING_ONE,
                "an existing installation is retightened to an absolute mode, overruling an operator who shared it with a group on purpose");
        });

        /**
         * And the bit an absolute mode takes away without anything noticing.
         *
         * The two cases above cannot see it: both fixtures already answer 750,
         * so `chmod 750` in place of `o-rwx` leaves them green, and so does the
         * symbolic `chmod o-rwx,g-w` that walks straight past the numeric guard
         * read out of the source. 0770 is what separates them - a group an
         * operator gave write access to, on purpose, keeps it.
         */
        it("leaves the write bit an operator gave that group alone", () => {
            const {status, dir} = decide((target) => seedData(target, GROUP_MAY_WRITE));

            assert.equal(status, 0, "an ordinary upgrade stops an install that has nothing wrong with it");
            assert.equal(modeOf(dir, "data"), LEFT_ON_A_GROUP_WRITABLE_ONE,
                "an existing installation is retightened to an absolute mode, taking a group's write access off a directory the operator opened to it");
        });
    });

    /**
     * The reachability check, run rather than read.
     *
     * systemd chdirs to WorkingDirectory and execs ExecStart after dropping to
     * User=, so every directory above the installation has to be enterable by
     * that account. "-d /root/myspeed" is the case it exists for: /root is 0700
     * root:root, handing over the installation never touches /root itself, and
     * the service then fails chdir with EACCES under Restart=always - a
     * permanent loop behind a banner saying the install completed.
     *
     * Reading the script cannot tell whether the walk is right, and every
     * assertion written against its text passed with the permission test
     * replaced by `:` - which is the whole function saying yes to everything.
     */
    describe("whether an unprivileged account can reach the installation", {skip: noPosixShell}, () => {
        const walk = (() => {
            const at = source.indexOf("reachable_by_service() {");
            assert.notEqual(at, -1, "nothing asks whether the account can reach the installation");

            return source.slice(at, source.indexOf("\n}", at) + 2);
        })();

        /**
         * `find` answers from a list rather than from the filesystem. The mode
         * bits this reads do not exist on the machine the suite runs on, and
         * what is being tested is the walk up the tree, not the syscall.
         */
        const reaches = (target, enterable) => {
            const script = [
                walk,
                'find() { case " $ENTERABLE " in *" $1 "*) echo "$1";; esac; }',
                'if reachable_by_service "$TARGET"; then echo yes; else echo no; fi'
            ].join("\n");

            // Bounded, because the thing being run is a `while :` loop: a walk
            // that stops climbing never terminates, and without this the suite
            // does not fail, it hangs - which is the one failure nobody reads.
            return execFileSync("sh", ["-c", script], {
                encoding: "utf8",
                timeout: WALK_TIMEOUT,
                env: {...process.env, ENTERABLE: enterable.join(" "), TARGET: target}
            }).trim() === "yes";
        };

        it("accepts a path every directory above it can be entered through", () => {
            assert.equal(reaches("/opt/myspeed", ["/", "/opt", "/opt/myspeed"]), true,
                "the usual install falls back to root, so nothing this branch does takes effect at all");
        });

        it("refuses one behind a directory that cannot", () => {
            assert.equal(reaches("/root/myspeed", ["/", "/root/myspeed"]), false,
                "-d /root/myspeed writes a unit whose service cannot chdir into its own directory");
        });

        // Its own bits count too: a root umask of 077 makes the directory this
        // script creates 0700, and then nothing under it is reachable either.
        it("refuses one that cannot be entered itself", () => {
            assert.equal(reaches("/opt/myspeed", ["/", "/opt"]), false,
                "the installation directory's own permissions are never looked at");
        });

        it("stops at the root rather than walking above it", () => {
            assert.equal(reaches("/", ["/"]), true, "the walk never terminates, or terminates the wrong way");
        });
    });

    /**
     * And a system with no useradd still gets a working install. Refusing to
     * install at all, or writing a unit naming an account that was never
     * created, are both worse than the privilege this is trying to drop.
     */
    it("falls back to root rather than leaving a service that cannot start", () => {
        assert.match(source, /SERVICE_ACCOUNT="root"/,
            "a system that cannot create the account gets a unit naming one that does not exist");
    });

    // The baseline set: none of it restricts a userspace HTTP server that
    // spawns a CLI and writes inside its own directory.
    it("sandboxes what the service can reach", () => {
        for (const directive of ["NoNewPrivileges=true", "PrivateTmp=true", "ProtectSystem=full"])
            assert.ok(unit.includes(directive), `the unit does not set ${directive}`);
    });

    /**
     * And the sandbox is written against the path the operator chose.
     *
     * -d puts the installation anywhere, and everything the service writes -
     * the database, the logs, the downloaded CLI - is under it. A read-only
     * hierarchy with no exception for that path gives a service that starts,
     * fails to create its own folders and restarts for ever, behind a banner
     * saying the install completed.
     */
    it("leaves the installation writable inside the sandbox", () => {
        assert.ok(unit.includes("ReadWritePaths=$INSTALLATION_PATH"),
            "ProtectSystem is applied with no exception for the directory the service writes");
    });

    // ProtectHome would make /home and /root inaccessible, and "-d /root/myspeed"
    // is a path a root user typing this command reaches for.
    it("does not cut off a home directory the installation may live in", () => {
        assert.ok(!unit.includes("ProtectHome"),
            "an installation under /home or /root cannot be reached by its own service");
    });

    /**
     * And ownership is only ever taken of directories this script creates.
     *
     * "-d /opt" is one slip from "-d /opt/myspeed". Guarding that by asking
     * whether the installation path holds a `myspeed` file cannot work: the
     * script writes that file itself a few lines earlier, so the test passes for
     * every path on a host that has none - including "/opt" and "/". It fired
     * only when `myspeed` was a *directory*, which is a genuine prior install
     * one level down: exactly backwards.
     *
     * So there is nothing to guard any more. The server writes `data` and `bin`
     * and nothing else at the installation root, so those two are created here
     * and given away, and the root and the binary stay with root - which also
     * means the service account cannot rewrite the binary it runs.
     */
    it("takes ownership of nothing but the directories the server writes", () => {
        const targets = [...source.matchAll(/^[ \t]*chown.*$/gm)].map((m) => m[0]);

        assert.notEqual(targets.length, 0, "the installation is never handed to the service account");

        targets.forEach((line) => {
            assert.doesNotMatch(line, /"\$INSTALLATION_PATH"\s*$/,
                `chown runs over the whole of whatever -d was given: ${line.trim()}`);
            assert.match(line, /\$INSTALLATION_PATH\/(data|bin)/,
                `chown names something other than the directories the server writes: ${line.trim()}`);
            // -h stated, not left to a default. GNU's -R already lchowns the
            // links it meets (proven against coreutils 9.1: an operand link
            // and a link planted inside the tree both kept their targets'
            // owners) - but POSIX leaves -R-without-H/L/P unspecified, and
            // the tree this walks is written by the unprivileged service
            // account, so "a planted link's target is never re-owned by
            // root's upgrade" must be a flag a test can read, not a
            // coreutils default it has to trust. docker-entrypoint.sh made
            // the same choice on the same two directories.
            assert.match(line, /^\s*chown\s+-[A-Za-z]*h\b/,
                `chown trusts the platform default not to follow links: ${line.trim()}`);
        });
    });

    /**
     * And the binary is left in a mode the account can actually run.
     *
     * `chmod +x` is masked by the umask - POSIX says so, and root on a hardened
     * host runs with 077 - so it can leave a downloaded file at 700. That was
     * invisible while the installation was handed over whole, because the
     * account then owned the binary; now that root keeps it, 700 means the
     * service cannot read or execute the thing it is pointed at, and
     * Restart=always makes a loop of it. Reachable on an upgrade, where the
     * directory already exists and is traversable so nothing falls back to root.
     */
    it("leaves the binary readable by the account that runs it", () => {
        assert.doesNotMatch(source, /chmod \+x/,
            "the binary's mode is left to the umask, so a hardened host installs one the service cannot execute");
        assert.match(source, /chmod 755 "\$DOWNLOAD_TMP"/,
            "nothing states the mode of a binary root owns and another account has to run");
    });

    // Each by name rather than the single line that used to carry both: `data`
    // is now made above the service-account branch, because the root fallback
    // needs its 700 too, and only `bin` is left beside the chown.
    it("creates those directories itself, so the service never writes the root", () => {
        const made = source.slice(0, source.lastIndexOf("chown"));

        for (const folder of ["data", "bin"])
            assert.match(made, new RegExp(`mkdir -p "\\$INSTALLATION_PATH/${folder}"`),
                `the service is expected to create its own ${folder} folder in a directory it does not own`);
    });

    /**
     * And the directory itself is left in a mode the account can enter.
     *
     * The same umask that leaves a downloaded binary at 700 leaves a created
     * directory at 700, and this is the directory reachable_by_service is about
     * to judge: on a host where root runs with 027 or 077 - which is what the
     * CIS profiles set - a fresh install creates its own installation directory
     * unreachable, fails its own check, and silently registers the service as
     * root. The whole point of the account is then gone, along with the
     * privilege separation around the third-party CLIs the server downloads and
     * spawns, and the only sign of it is one line of fallback text scrolling
     * past mid-install.
     *
     * Stated before the check rather than after it, because the check is what
     * consumes it. uninstall.sh recreates the same directory under the same mask
     * and states the same mode, for the same reason - see the assertion there.
     */
    /**
     * Where the installation directory itself is created, as opposed to the
     * `data` and `bin` it makes underneath. Matched by pattern rather than by a
     * fixed spelling, so guarding the call - which is the subject of the
     * assertion below - does not also move the anchor it is measured from.
     */
    const createsInstallationPath = () => {
        const at = source.search(/mkdir -p "\$INSTALLATION_PATH"(?!\/)/);

        assert.notEqual(at, -1, "nothing creates the installation directory any more");
        return at;
    };

    /**
     * And it does not widen something that is not a directory.
     *
     * `[ ! -d "$INSTALLATION_PATH" ]` is also true when the path is a regular
     * file - the case the `cd` check below calls "a name already taken by a
     * file". There is no `set -e`, so an unchecked `mkdir -p` fails with EEXIST
     * and execution walks straight into the chmod, which follows symlinks and
     * succeeds: a 0600 file named by a typo in -d is left world-readable and
     * executable, by root, and only then does the script abort. Before the mode
     * was stated here that invocation changed nothing at all.
     */
    it("does not reach the chmod when the directory was not created", () => {
        const made = createsInstallationPath();
        const stated = source.indexOf('chmod 755 "$INSTALLATION_PATH"');

        assert.ok(made !== -1 && stated !== -1);

        const between = source.slice(made, stated);

        assert.match(between, /\|\||exit|&&/,
            "a failed mkdir falls through to a chmod that widens whatever is already at that path");
    });

    it("says why it could not create the directory", () => {
        assert.match(source, /Could not create \$INSTALLATION_PATH/,
            "the failure is silent, and the run aborts a few lines later for a reason that names something else");
    });

    it("creates the installation directory in a mode the account can enter", () => {
        const made = createsInstallationPath();
        const stated = source.indexOf('chmod 755 "$INSTALLATION_PATH"');

        assert.notEqual(made, -1, "nothing creates the installation directory any more");
        assert.notEqual(stated, -1,
            "the directory's mode is left to the umask, so a hardened host installs a service running as root");
        assert.ok(made < stated, "the mode is stated before the directory exists");

        const judged = source.indexOf('reachable_by_service "$INSTALLATION_PATH"');

        assert.notEqual(judged, -1, "nothing asks whether the account can reach the installation");
        assert.ok(stated < judged,
            "the mode is stated after the check that reads it, which has already fallen back to root");
    });

    /**
     * And an installation the account cannot reach falls back to root.
     *
     * systemd chdirs to WorkingDirectory and execs ExecStart after dropping to
     * User=, so every directory above the installation has to be traversable by
     * that account. "-d /root/myspeed" is the case the comments reach for, and
     * /root is 0700: the chown reaches the installation, never /root itself, so
     * the service fails chdir with EACCES and Restart=always turns that into a
     * permanent loop behind a banner saying the install completed.
     */
    it("runs as root rather than producing a service that cannot start", () => {
        assert.match(source, /reachable_by_service/,
            "nothing checks the service account can reach the installation it is given");

        const decision = source.slice(source.indexOf("SERVICE_ACCOUNT"));

        assert.match(decision, /reachable_by_service "\$INSTALLATION_PATH"/,
            "the reachability of the chosen path is never actually tested");
    });
});

/**
 * And the account install.sh creates is taken back out again.
 *
 * The installer now adds a `myspeed` system account whose home directory is the
 * installation path. An uninstall that removes the binary, the unit and the
 * directory and then reports "MySpeed has been uninstalled" while leaving that
 * account in /etc/passwd - pointing at a directory it has just deleted - is
 * reporting something it did not do.
 *
 * Not under --keep-data, though, and that is the whole of why this is a
 * condition rather than a line. That flag exists to leave the database on disk
 * for a later reinstall, and those files are owned by this account: delete the
 * account and they belong to a free uid, which the next account created on that
 * host may be given. Data that is being kept keeps its owner.
 */
describe("uninstall.sh removes the account install.sh creates", () => {
    const source = read("uninstall.sh");
    const installer = read("install.sh");

    it("knows the account by the same name the installer uses", () => {
        const named = installer.match(/SERVICE_USER="(\w+)"/)?.[1];

        assert.equal(named, "myspeed", "the installer's account name has moved");

        // The declaration, not the name anywhere: "myspeed" is the service, the
        // directory and the unit too, so asking whether the word appears is
        // answered by every line of this script.
        assert.match(source, new RegExp(`SERVICE_USER="${named}"`),
            "the uninstaller removes an account by some other name than the one the installer creates");
    });

    it("deletes it", () => {
        // A line that runs userdel, not the `command -v userdel` guarding it -
        // which carries the same word and satisfies any test written against it
        // while the account outlives every uninstall.
        const removes = source.split("\n").some((line) => /^\s*userdel\s+"\$SERVICE_USER"/.test(line));

        assert.ok(removes,
            "the account outlives every uninstall, pointing at a directory that was just removed");
    });

    // Guarded on both sides: a system with no userdel must not fail the
    // uninstall over it, and an account that was never created is not an error.
    it("does not fail the uninstall when it cannot", () => {
        const removal = source.slice(source.indexOf("userdel") - 400, source.indexOf("userdel") + 200);

        assert.match(removal, /command -v userdel/,
            "userdel is called without checking the system has it");
        assert.match(removal, /id -u/,
            "the account is deleted without checking it exists");
    });

    /*
     * Whether the account survives an uninstall that kept its files is asserted
     * by running one, in uninstallBehaviour.test.js.
     *
     * It was asserted here by finding KEEP_DATA in the condition above userdel,
     * which is a mechanism rather than a property - and the mechanism moved. The
     * question is not whether --keep-data was asked for but whether data was
     * actually kept: the flag also arrives on installations that have no data
     * directory, where an account left behind owns nothing at all.
     */
});

/**
 * Bashisms the scripts must not rely on, and the checks they must share.
 *
 * Every script opens with a bash shebang and the README runs them under bash,
 * so `==` inside `[` worked - but the same line run under dash is "unexpected
 * operator", and in uninstall.sh the test it broke was the one that decides
 * whether --keep-data stages the data directory before the installation is
 * removed. A condition that errors is a condition that is false, and false
 * there is the branch that deletes. `=` says the same thing in every shell.
 */
describe("the scripts speak POSIX where it costs nothing", () => {
    for (const name of ROOT_GUARDED) {
        it(`${name} compares with = inside [ ]`, () => {
            assert.doesNotMatch(read(name), /\[ [^\]]*[^=!]==[^=]/,
                "a [ ] test uses ==, which dash reports as an unexpected operator");
        });
    }
});

describe("install.sh finds the service the way uninstall.sh does", () => {
    // Anchored on both sides: a bare "myspeed.service" also matches a unit
    // named notmyspeed.service, and the dot matched any character.
    it("matches the unit name whole", () => {
        const pattern = /grep -qE '\(\^\|\[\[:space:\]\]\)myspeed\\.service\(\[\[:space:\]\]\|\$\)'/;
        assert.match(read("uninstall.sh"), pattern, "uninstall.sh lost the anchored pattern this mirrors");
        assert.match(read("install.sh"), pattern, "install.sh still greps for a bare myspeed.service");
    });
});

describe("docker-install.sh checks for the compose plugin", () => {
    // `docker compose` is a plugin, and an engine installed some other way
    // may not carry it: without this, `docker compose pull` failed into the
    // "starting what is already here" fallback and `up -d` failed after it,
    // with nothing said about what was missing.
    it("refuses before pulling when docker compose is not there", () => {
        const source = read("docker-install.sh");
        const check = source.indexOf("docker compose version");
        assert.notEqual(check, -1, "the script never asks whether the compose plugin exists");
        assert.ok(check < source.indexOf("docker compose pull"), "the check comes after the pull it guards");
        assert.match(source.slice(check, check + 400), /exit 1/, "a missing plugin is reported but not refused");
    });
});
