import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { bodyOf, readSource, withoutHashComments } from "../helpers/source.js";

/**
 * The installer on a machine that is not the one it was written on.
 *
 * apt-get was called unconditionally, so on anything that is not
 * Debian-shaped the script staggered through "command not found" errors and
 * succeeded only if curl and wget happened to be preinstalled - and failed
 * half-way with no explanation if they were not. And two of its network calls
 * carried no deadline: the release lookup, and the ifconfig.me call that
 * prints the access address - which on an air-gapped host stalled the final
 * message of an otherwise finished install for as long as curl cares to wait.
 *
 * Deliberately not multi-distro support: the script targets Debian and says
 * so by using apt-get at all. What it owes everyone else is an honest message
 * instead of a broken half-install.
 */
const install = withoutHashComments(readSource("scripts/install.sh"));

describe("the installer on a machine without apt-get", () => {
    it("asks whether apt-get exists before calling it", () => {
        assert.match(install, /command -v apt-get/,
            "apt-get is called blind, so any other distribution staggers through errors");
    });

    // Every call sits inside a guard, so none is at the start of a line.
    it("never calls it unguarded", () => {
        assert.doesNotMatch(install, /^apt-get /m,
            "an apt-get call sits at top level, outside any guard");
    });

    /**
     * Anchored to check()'s own body: matched against the whole script, the
     * pattern reached from the update guard to any of the six unrelated
     * exit 1 lines below it, so deleting the refusal kept the test green -
     * the exact blindness a review pass caught.
     */
    it("refuses honestly when a dependency is missing and nothing can install it", () => {
        assert.match(bodyOf(install, "function check()"), /command -v apt-get[^]*?exit 1/,
            "a machine that cannot install the missing dependency carries on into a broken install");
    });
});

describe("the installer's network calls", () => {
    it("gives every curl a deadline", () => {
        const curls = install.split("\n").filter((line) => line.includes("curl "));

        assert.ok(curls.length > 0, "the installer no longer uses curl at all");
        for (const line of curls)
            assert.match(line, /--max-time \d+/, `a curl carries no deadline: ${line.trim()}`);
    });

    it("gives the download a stall deadline", () => {
        const downloads = install.split("\n").filter((line) => line.includes("wget "));

        assert.ok(downloads.length > 0, "the installer no longer uses wget at all");
        for (const line of downloads)
            assert.match(line, /--timeout=\d+/, `a wget carries no stall deadline: ${line.trim()}`);
    });

    /**
     * The address is a convenience; a host that cannot reach ifconfig.me
     * still deserves its closing message with a placeholder. And the failure
     * has to be judged on the whole lookup, not curl's exit code alone: -s
     * without -f answers an HTTP error page as output with rc 0, and command
     * substitution keeps whatever partial bytes arrived before a timeout - so
     * a bare `|| echo fallback` printed http://:5216 for a captive portal and
     * spliced the placeholder onto half an address for a slow link.
     */
    it("discards a failed or partial address lookup whole", () => {
        assert.match(install, /curl -sf --max-time \d+ ifconfig\.me\)\s*\|\|\s*PUBLIC_ADDRESS=""/,
            "a lookup that failed part-way still leaks its output into the address");
    });

    it("still prints the closing message with a placeholder", () => {
        assert.match(install, /\[ -z "\$PUBLIC_ADDRESS" \]/,
            "an empty answer from the lookup leaves a hole in the final message");
        assert.match(install, /http:\/\/\$PUBLIC_ADDRESS:5216/,
            "the closing message no longer uses the checked address at all");
    });
});

/**
 * The walk that decides whether an unprivileged account could reach the
 * installation directory, run rather than read.
 *
 * It climbed with `directory=$(dirname "$directory")` and stopped only at "/",
 * which is a termination condition an absolute path has and a relative one does
 * not: `dirname "."` is ".", for ever. So `install.sh -d myspeed` hung the
 * installer in a loop that no message explained and only Ctrl-C ended.
 *
 * A source scan cannot catch that - the loop looked fine - so this executes the
 * function with a deadline. Reaching the deadline is the failure.
 */
// Long enough for a shell to start, short enough that a loop which never ends
// is reported rather than waited on.
const WALK_TIMEOUT = 10_000;

const bash = (() => {
    for (const candidate of ["bash", "/usr/bin/bash", "C:/Program Files/Git/bin/bash.exe"]) {
        try {
            // On a deadline like every other call here, and for a sharper
            // reason: on Windows the first candidate resolves to the WSL
            // launcher, which can sit booting a distribution. This runs at
            // module load, so without it a suite written to catch a hang hangs.
            if (execFileSync(candidate, ["-c", "echo ok"],
                {encoding: "utf8", timeout: WALK_TIMEOUT, stdio: ["pipe", "pipe", "ignore"]})
                .trim() === "ok") return candidate;
        } catch {
            // Not there, or not usable.
        }
    }

    return null;
})();

describe("the reachability walk", {skip: bash ? false : "No bash available"}, () => {
    // The function on its own, lifted out of the script it lives in: sourcing
    // the whole installer would start installing.
    const walk = () => {
        const source = readSource("scripts/install.sh");
        const start = source.indexOf("reachable_by_service() {");
        assert.notEqual(start, -1, "the installer no longer decides reachability this way");

        const end = source.indexOf("\n}", start);
        assert.notEqual(end, -1, "the function is never closed");

        return source.slice(start, end + 2);
    };

    const run = (directory, cwd) => execFileSync(bash, ["-c",
        `${walk()}\nreachable_by_service "${directory}" && echo reachable || echo unreachable`],
    {encoding: "utf8", cwd, timeout: WALK_TIMEOUT, stdio: ["pipe", "pipe", "ignore"]}).trim();

    it("answers for an absolute path", () => {
        assert.match(run("/"), /reachable|unreachable/);
    });

    /*
     * The shell runs in the temp root rather than in the directory being
     * removed: Windows holds a directory for a while after a process that had
     * it as its working directory exits, so deleting it here raced the
     * cleanup rather than the walk.
     */
    it("answers for a relative one rather than climbing for ever", () => {
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), "myspeed-walk-"));

        try {
            fs.mkdirSync(path.join(directory, "myspeed"));

            assert.match(run(`${path.basename(directory)}/myspeed`, os.tmpdir()), /reachable|unreachable/,
                "the walk never terminates on a relative path, so -d myspeed hangs the installer");
        } finally {
            fs.rmSync(directory, {recursive: true, force: true});
        }
    });

    // The shortest relative path there is, and the one dirname never shortens.
    it("answers for the working directory itself", () => {
        assert.match(run(".", os.tmpdir()), /reachable|unreachable/);
    });
});

/**
 * And the path the unit records is absolute however it was given.
 *
 * systemd refuses a relative WorkingDirectory, so `-d myspeed` wrote a unit
 * that could not start - the other half of the same relative-path gap.
 */
describe("the installation path", () => {
    it("is made absolute before anything is written with it", () => {
        assert.match(install, /INSTALLATION_PATH="\$\(pwd\)\/\$INSTALLATION_PATH"/,
            "a relative -d reaches the unit file, and systemd refuses a relative WorkingDirectory");
    });

    /*
     * Executed rather than scanned, because what the prologue answers is the
     * whole point and a scan cannot tell an empty string from a path.
     *
     * Everything from the default down to the root check, which is where the
     * script stops deciding where to install and starts installing.
     */
    const prologue = () => {
        const source = readSource("scripts/install.sh");
        const start = source.indexOf('INSTALLATION_PATH="/opt/myspeed"');
        const end = source.indexOf("if [ $EUID -ne 0 ]");

        assert.notEqual(start, -1, "the installer no longer carries a default path");
        assert.notEqual(end, -1, "the root check is gone, so the slice below is not the prologue");

        return `${source.slice(start, end)}\necho "$INSTALLATION_PATH"`;
    };

    const resolve = (args) => execFileSync(bash, ["-c", `${prologue()}\n`, "install.sh", ...args],
        {encoding: "utf8", cwd: os.tmpdir(), timeout: WALK_TIMEOUT, stdio: ["pipe", "pipe", "ignore"]}).trim();

    describe("as the prologue resolves it", {skip: bash ? false : "No bash available"}, () => {
        it("keeps an absolute path exactly as given", () => {
            assert.equal(resolve(["-d", "/opt/elsewhere"]), "/opt/elsewhere");
        });

        it("resolves a relative path against the working directory", () => {
            assert.match(resolve(["-d", "myspeed"]), /^\/.*\/myspeed$/);
        });

        it("falls back to the default when no path is given", () => {
            assert.equal(resolve([]), "/opt/myspeed");
        });

        /*
         * And an empty one is refused rather than resolved.
         *
         * `install.sh -d "$MYSPEED_DIR"` with the variable unset used to fail
         * safe: the path stayed empty and `cd ""` ended the run. Canonicalising
         * it turned that into "$(pwd)/" - a real, existing directory - so the
         * install proceeded into wherever the caller happened to be, chowned
         * its data and bin subdirectories to the service account and wrote that
         * path into the unit. From the filesystem root that re-owns the system
         * bin directory, behind a banner announcing a completed install.
         */
        it("refuses an empty one instead of installing into the working directory", () => {
            assert.throws(() => resolve(["-d", ""]),
                "an empty -d resolves to the caller's working directory and the install proceeds");
        });
    });
});
