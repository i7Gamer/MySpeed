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
        assert.match(source, /useradd/, "the installer never creates a service account");
        assert.ok(source.indexOf("useradd") < source.indexOf("chown"),
            "the installation is handed to an account that does not exist yet");
    });

    /**
     * An upgrade is the case this exists for: the files are there already, and
     * they are owned by root because that is what installed them.
     */
    it("hands the installation to the account that will run it", () => {
        assert.match(source, /chown -R "\$SERVICE_USER" "\$INSTALLATION_PATH\/data" "\$INSTALLATION_PATH\/bin"/,
            "the new account cannot write the database it inherits");
        assert.ok(source.indexOf("chown") < unitStart,
            "the service is registered before it can read its own directory");
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

    it("creates those directories itself, so the service never writes the root", () => {
        const made = source.slice(0, source.lastIndexOf("chown"));

        assert.match(made, /mkdir -p "\$INSTALLATION_PATH\/data" "\$INSTALLATION_PATH\/bin"/,
            "the service is expected to create its own folders in a directory it does not own");
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
        assert.match(source, /userdel/,
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
     * Slicing from the last KEEP_DATA and then asserting KEEP_DATA is in the
     * slice says nothing - the slice begins with it. What has to hold is that
     * the flag is part of the condition guarding userdel.
     */
    it("keeps the account whenever it keeps the data it owns", () => {
        const line = source.split("\n").find((text) => text.includes("userdel"));
        const condition = source.slice(0, source.indexOf("userdel"));
        const guard = condition.slice(condition.lastIndexOf("if "));

        assert.match(guard, /KEEP_DATA/,
            "the account is removed even under --keep-data, orphaning the files it owns");
        assert.match(guard, /!=\s*"--keep-data"/,
            "the --keep-data check does not read as \"only when data is not kept\"");
        assert.ok(line, "userdel is no longer called");
    });
});
