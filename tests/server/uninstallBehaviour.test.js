import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readSource } from "../helpers/source.js";

/**
 * The uninstaller, run rather than read.
 *
 * Three rounds of change to this script each shipped a defect that the round
 * after caught, and every one of them was a condition someone had reasoned about
 * correctly in isolation and wrongly in place. The tests that existed lifted
 * those conditions out by string anchor and evaluated them alone, which is why
 * they kept passing: they could not see the block that ran before, the variable
 * that had not been set yet, or the message that named something untrue. Twice
 * an anchor also drifted onto a different block and went on passing.
 *
 * So this runs the whole thing. A copy of the script with its three absolute
 * constants rewritten into a temporary directory, `docker` and `systemctl`
 * stubbed on PATH, the root check and the waiting removed - and then the real
 * control flow, from argument parsing to the banner, against a filesystem that
 * can be inspected afterwards.
 *
 * What each case asserts is what an operator would be left with: the exit code,
 * what the script said, and what is still on disk.
 */
const bash = (() => {
    for (const candidate of ["bash", "/usr/bin/bash", "C:/Program Files/Git/bin/bash.exe"]) {
        try {
            if (execFileSync(candidate, ["-c", "echo ok"],
                {encoding: "utf8", timeout: 10_000, stdio: ["pipe", "pipe", "ignore"]}).trim() === "ok")
                return candidate;
        } catch {
            // Not there, or not usable.
        }
    }

    return null;
})();

const RUN_TIMEOUT = 20_000;

/**
 * The same directory, spelled the way the shell spells it.
 *
 * The script is a Linux uninstaller and refuses a -d that is not absolute, which
 * `C:/Users/...` is not - that is how Windows spells it and how Node has to be
 * handed it, while the shell underneath wants `/c/Users/...`. So paths cross the
 * boundary in whichever spelling the side receiving them uses: this one
 * everywhere inside the script, the native one for every fs call. On Linux the
 * two are the same string.
 */
const posix = (target) => target.replace(/^([A-Za-z]):/, (_, drive) => `/${drive.toLowerCase()}`);

let root;

/**
 * The script with everything that reaches outside the sandbox rewritten.
 *
 * Only the three path constants, the privilege check and the waiting. The
 * decisions, the messages and the order they happen in are the subject of every
 * assertion below and are left exactly as shipped.
 */
const sandboxedScript = (sandbox) => {
    let source = readSource("scripts/uninstall.sh");

    const rewrites = [
        ['INSTALLATION_PATH="/opt/myspeed"', `INSTALLATION_PATH="${posix(sandbox)}/opt/myspeed"`],
        ['DOCKER_INSTALLATION_PATH="/opt/myspeed-dockerized"',
            `DOCKER_INSTALLATION_PATH="${posix(sandbox)}/opt/myspeed-dockerized"`],
        ['SERVICE_FILES=("/etc/systemd/system/myspeed.service" "/usr/lib/systemd/system/myspeed.service")',
            `SERVICE_FILES=("${posix(sandbox)}/units/a.service" "${posix(sandbox)}/units/b.service")`],
        ["if [ $EUID -ne 0 ]; then", "if false; then"]
    ];

    for (const [from, to] of rewrites) {
        assert.ok(source.includes(from), `the script no longer contains ${JSON.stringify(from)}`);
        source = source.split(from).join(to);
    }

    // The waiting and the screen-clearing, which would make the suite slow and
    // would throw the captured output away.
    return source.replace(/^(\s*)sleep \d+$/gm, "$1sleep 0").replace(/^(\s*)clear$/gm, "$1:");
};

const stub = (file, body) => {
    fs.writeFileSync(file, `#!/bin/sh\n${body}\n`, {mode: 0o755});
};

/**
 * A host, described by what is on it.
 *
 * `container` and `service` decide what the two stubs answer. `recorded` writes
 * a unit file carrying a WorkingDirectory, which is what makes a path
 * authoritative. `installed` puts a data directory where an installation would
 * be. `account` decides whether `id -u myspeed` succeeds, so the account removal
 * can be observed without one existing.
 */
const host = ({container = false, service = false, recorded = null, installed = null, account = false,
    unremovable = false, otherService = false}) => {
    const sandbox = path.join(root, randomBytes(8).toString("hex"));

    fs.mkdirSync(path.join(sandbox, "bin"), {recursive: true});
    fs.mkdirSync(path.join(sandbox, "units"), {recursive: true});
    fs.mkdirSync(path.join(sandbox, "opt"), {recursive: true});

    const calls = path.join(sandbox, "calls.log");

    // Stateful, because a second run must see the host the first one left. A
    // container that has been removed is no longer listed, and a service that
    // has been disabled is no longer enabled.
    const state = `${sandbox}/state`;
    fs.mkdirSync(state, {recursive: true});

    stub(path.join(sandbox, "bin", "docker"),
        `echo "docker $*" >> "${calls}"\n`
        + `if [ "$1" = "rm" ]; then rm -f "${state}/container"; fi\n`
        + `if [ "$1" = "ps" ] && [ -f "${state}/container" ]; then echo MySpeed; fi\n`
        + "exit 0");

    stub(path.join(sandbox, "bin", "systemctl"),
        `echo "systemctl $*" >> "${calls}"\n`
        + `if [ "$1" = "disable" ]; then rm -f "${state}/unit"; fi\n`
        + `if [ "$1" = "--all" ] && [ -f "${state}/unit" ]; then echo "  myspeed.service loaded active"; fi\n`
        + `if [ "$1" = "--all" ] && [ -f "${state}/other" ]; then echo "  notmyspeed.service loaded active"; fi\n`
        + "exit 0");

    if (container) fs.writeFileSync(`${state}/container`, "");
    if (service) fs.writeFileSync(`${state}/unit`, "");
    if (otherService) fs.writeFileSync(`${state}/other`, "");

    // A removal that fails, without needing a permission the suite cannot rely
    // on having - root ignores the mode bits, and Git Bash on Windows does not
    // honour them at all. Every other path is passed straight through, including
    // the unit files and the markers the stubs above clear.
    if (unremovable) {
        const refused = unremovable === true ? `${posix(sandbox)}/opt/myspeed` : unremovable;

        stub(path.join(sandbox, "bin", "rm"),
            `for arg in "$@"; do\n`
            + `  if [ "$arg" = "${refused}" ]; then\n`
            + `    echo "rm: cannot remove '$arg': Operation not permitted" >&2\n`
            + "    exit 1\n"
            + "  fi\n"
            + "done\n"
            + '[ -x /bin/rm ] && exec /bin/rm "$@"\n'
            + 'exec /usr/bin/rm "$@"');
    }

    stub(path.join(sandbox, "bin", "userdel"), `echo "userdel $*" >> "${calls}"\nexit 0`);
    stub(path.join(sandbox, "bin", "id"),
        `echo "id $*" >> "${calls}"\n` + (account ? "echo 999\nexit 0" : "exit 1"));

    if (recorded) {
        const at = recorded === true ? `${posix(sandbox)}/opt/myspeed` : recorded;
        fs.writeFileSync(path.join(sandbox, "units", "a.service"), `[Service]\nWorkingDirectory=${at}\n`);
    }

    if (installed) {
        const at = installed === true ? path.join(sandbox, "opt", "myspeed") : installed;
        fs.mkdirSync(path.join(at, "data"), {recursive: true});
        fs.writeFileSync(path.join(at, "data", "storage.db"), "the database");
        fs.writeFileSync(path.join(at, "myspeed"), "the binary");
    }

    fs.writeFileSync(path.join(sandbox, "uninstall.sh"), sandboxedScript(sandbox));

    return {
        at: (...parts) => [sandbox, ...parts].join("/"),
        given: (...parts) => [posix(sandbox), ...parts].join("/"),
        run(...args) {
            let output;
            let status = 0;

            try {
                output = execFileSync(bash, [path.join(sandbox, "uninstall.sh"), ...args], {
                    encoding: "utf8",
                    timeout: RUN_TIMEOUT,
                    env: {...process.env, PATH: `${path.join(sandbox, "bin")}${path.delimiter}${process.env.PATH}`},
                    stdio: ["pipe", "pipe", "pipe"]
                });
            } catch (error) {
                status = error.status ?? 1;
                output = `${error.stdout ?? ""}${error.stderr ?? ""}`;
            }

            return {
                status,
                output,
                calls: fs.existsSync(calls) ? fs.readFileSync(calls, "utf8") : "",
                survives: (...parts) => fs.existsSync(path.join(sandbox, ...parts)),
                completed: /Completed/.test(output)
            };
        }
    };
};

before(() => {
    // Forward slashes throughout. The script is POSIX and compares the path it
    // was given against the one the unit recorded; a native separator on Windows
    // makes those two spellings of the same directory unequal, which is a
    // property of the test rather than of the script.
    root = fs.mkdtempSync(path.join(os.tmpdir(), "myspeed-uninstall-")).split(path.sep).join("/");
});

after(() => {
    fs.rmSync(root, {recursive: true, force: true});
});

const DATABASE = ["opt", "myspeed", "data", "storage.db"];

describe("the uninstaller", {skip: bash ? false : "no bash on PATH - uninstall.sh is a Linux uninstaller"}, () => {
    /**
     * The case the restructure exists for: a container running beside the native
     * install it was meant to replace. Finding one used to be the end of the run.
     */
    it("removes the container, the service and the installation on a host with all three", () => {
        const result = host({container: true, service: true, recorded: true, installed: true}).run();

        assert.equal(result.status, 0, result.output);
        assert.match(result.calls, /docker rm MySpeed/, "the container was left running");
        assert.match(result.calls, /systemctl stop myspeed/, "the service was left running");
        assert.equal(result.survives(...DATABASE), false, "the database is still on disk");
        assert.ok(result.completed);
    });

    it("finishes cleanly on a host that only ever ran the container", () => {
        const result = host({container: true}).run();

        assert.equal(result.status, 0, result.output);
        assert.ok(result.completed, "a docker-only uninstall reports a failure");
    });

    /**
     * A native installation the run was not told where to find must never be
     * reported as removed: that directory holds the database and the admin
     * password hash.
     */
    describe("an installation it cannot find", () => {
        it("refuses to report success when -d names the wrong path", () => {
            const machine = host({container: true, service: true, recorded: true, installed: true});
            const result = machine.run("-d", machine.given("opt", "myspeeed"));

            assert.equal(result.status, 1, "a mislocated installation reports a completed uninstall");
            assert.equal(result.completed, false, "the success banner printed over an installation on disk");
            assert.equal(result.survives(...DATABASE), true, "the wrong path was removed");
            assert.match(result.output, /Found no installation/);
        });

        // install.sh writes no unit on a host without systemctl, and a unit
        // removed by hand leaves none either - so the report cannot key on
        // having found a service.
        it("refuses to report success when -d is wrong and there is no unit at all", () => {
            const machine = host({container: true, installed: true});
            const result = machine.run("-d", machine.given("opt", "elsewhere"));

            assert.equal(result.status, 1, "a wrong -d beside a container reports a completed uninstall");
            assert.equal(result.survives(...DATABASE), true);
        });

        // The unit is deleted before anything that can fail, so "re-run with -d"
        // was advice the operator had no way left to follow.
        it("names the path the service recorded", () => {
            const machine = host({service: true, recorded: true, installed: true});
            const result = machine.run("-d", machine.given("opt", "nothing-here"));

            assert.equal(result.status, 1);
            assert.match(result.output, /recorded it at/, "the recorded path is not offered");
        });
    });

    /**
     * And the other side of it: an uninstall that is genuinely over must not be
     * reported as a problem.
     */
    /**
     * Somebody else's unit is not this one.
     *
     * The service list is searched for a bare "myspeed.service", which matches
     * anywhere in a line - so a host running an unrelated notmyspeed.service is
     * taken to have a native MySpeed installation on it, and the account removal
     * at the end of the run is keyed on exactly that. This is the same defect
     * the container name had, on the other half of the same decision.
     */
    it("is not selected by an unrelated service whose name contains this one", () => {
        const result = host({container: true, otherService: true, account: true}).run();

        assert.equal(result.status, 0, result.output);
        assert.doesNotMatch(result.calls, /systemctl stop/,
            "an unrelated service was stopped");
        assert.doesNotMatch(result.calls, /userdel/,
            "a host with no native MySpeed had the myspeed account deleted");
    });

    /**
     * The unit file goes whether or not systemd ever loaded it.
     *
     * Removing it was inside the branch that `systemctl --all` selects, so a
     * host where the list does not name it - systemd never reloaded after
     * install.sh wrote it, or the unit is masked, or systemctl is not there at
     * all - finished the uninstall with the unit still on disk. The next
     * `daemon-reload` then brings back a service pointing at a directory that no
     * longer exists, and install.sh will not rewrite it because the account it
     * checks for still exists.
     *
     * A unit file on disk is also the same evidence the list is: a native
     * installation was here. That is what FOUND_SERVICE is for, so it is set
     * from either.
     */
    it("removes a unit file systemd does not list", () => {
        const machine = host({recorded: true, installed: true, account: true});
        const result = machine.run();

        assert.equal(result.status, 0, result.output);
        assert.equal(result.survives("units", "a.service"), false,
            "the unit file outlives the installation it points at");
        assert.match(result.calls, /userdel myspeed/,
            "a host that plainly had a native install keeps its service account");
    });

    describe("an installation that is genuinely gone", () => {
        it("says nothing when the path came from the unit", () => {
            const result = host({container: true, service: true, recorded: true}).run();

            assert.equal(result.status, 0, result.output);
            assert.ok(result.completed);
        });

        it("says nothing when -d names exactly what the unit recorded", () => {
            const machine = host({service: true, recorded: true});
            const result = machine.run("-d", machine.given("opt", "myspeed"));

            assert.equal(result.status, 0,
                "a correct -d on a finished uninstall is reported as an installation left on disk");
            assert.ok(result.completed);
        });
    });

    /**
     * Every way of mis-parsing this command line ends in deleting something, so
     * every one of them refuses.
     */
    describe("arguments it will not act on", () => {
        it("refuses -d with a flag where the path should be", () => {
            const machine = host({container: true, installed: true});
            const result = machine.run("-d", "--keep-data");

            assert.equal(result.status, 1);
            assert.doesNotMatch(result.calls, /docker volume rm/,
                "the volume holding the database was removed by a --keep-data run");
            assert.equal(result.survives(...DATABASE), true);
        });

        it("refuses -d with nothing after it", () => {
            const result = host({installed: true}).run("-d");

            assert.equal(result.status, 1);
            assert.equal(result.survives(...DATABASE), true, "the compiled-in default was removed instead");
        });

        /**
         * And it refuses to be pointed at the filesystem, before it touches
         * anything.
         *
         * `-d /` reaches `rm -R /`. GNU coreutils declines that one on its own -
         * which is the whole of the current protection, is not there on busybox,
         * and arrives only after the container has been stopped and removed and
         * the unit files deleted. A relative path is the same mistake from the
         * other end: it resolves against whatever directory the operator
         * happened to be in, so `-d data` removes a data directory that has
         * nothing to do with MySpeed. Neither is a path install.sh can produce,
         * so both are answered where the arguments are read.
         */
        it("refuses a path that is not an installation directory", () => {
            for (const argument of ["/", "//", "/.", "/..", "myspeed", "./myspeed"]) {
                const machine = host({container: true, service: true, recorded: true, installed: true});
                const result = machine.run("-d", argument);

                assert.equal(result.status, 1, `-d ${JSON.stringify(argument)} was accepted`);
                assert.doesNotMatch(result.output, /Removing service data/,
                    `-d ${JSON.stringify(argument)} is discovered to be unusable only after the removal started`);
                assert.equal(result.calls, "",
                    `-d ${JSON.stringify(argument)} reached the host before it was refused`);
                assert.equal(result.survives(...DATABASE), true);
            }
        });

        it("refuses a misspelled --keep-data rather than destroying the data", () => {
            for (const spelling of ["--keepdata", "-keep-data", "--keep_data"]) {
                const result = host({installed: true}).run(spelling);

                assert.equal(result.status, 1, `${spelling} ran a destructive uninstall`);
                assert.equal(result.survives(...DATABASE), true,
                    `${spelling} destroyed the data it was typed to keep`);
            }
        });

        it("answers --help instead of uninstalling", () => {
            const result = host({installed: true}).run("--help");

            assert.equal(result.status, 0);
            assert.match(result.output, /Usage/);
            assert.equal(result.survives(...DATABASE), true, "--help removed the installation");
        });
    });

    describe("--keep-data", () => {
        it("keeps the data and removes everything else", () => {
            const result = host({service: true, recorded: true, installed: true}).run("--keep-data");

            assert.equal(result.status, 0, result.output);
            assert.equal(result.survives(...DATABASE), true, "the data this flag exists for was destroyed");
            assert.equal(result.survives("opt", "myspeed", "myspeed"), false, "the binary was kept");
        });

        // Those files belong to the account, and a freed uid is handed to
        // whatever account this host creates next.
        it("keeps the account that owns what it kept", () => {
            const result = host({service: true, recorded: true, installed: true, account: true})
                .run("--keep-data");

            assert.doesNotMatch(result.calls, /userdel/, "the owner of the kept data was deleted");
        });

        it("removes the account when the data goes with it", () => {
            const result = host({service: true, recorded: true, installed: true, account: true}).run();

            assert.match(result.calls, /userdel myspeed/, "the account outlives every uninstall");
        });

        /**
         * And it belongs to the service rather than to the directory, so it goes
         * when either of them was here.
         *
         * It used to be removed in the `else` of the container branch, so a host
         * running both kept its `myspeed` entry in /etc/passwd - and install.sh
         * only runs useradd when the account is missing, so it survived every
         * later uninstall too, owning a home directory that no longer exists.
         * Moving it inside the block that removes the directory fixed that cell
         * and broke this one.
         */
        it("removes it when the service was here and the directory was already gone", () => {
            const result = host({service: true, recorded: true, account: true}).run();

            assert.equal(result.status, 0, result.output);
            assert.match(result.calls, /userdel myspeed/,
                "a native install whose directory was removed by hand leaves its account in /etc/passwd");
        });

        it("removes it when the installation was here and the unit was already gone", () => {
            const result = host({installed: true, account: true}).run();

            assert.equal(result.status, 0, result.output);
            assert.match(result.calls, /userdel myspeed/,
                "an installation whose unit was removed by hand leaves its account behind");
        });

        // The container never creates an account on the host.
        it("leaves a docker-only host's accounts alone", () => {
            const result = host({container: true, account: true}).run();

            assert.doesNotMatch(result.calls, /userdel/, "an unrelated account was deleted");
        });
    });

    /**
     * `[ -d ]` is true for a link to a directory and `rm -R` removes only the
     * link, so the installation survived in full under the success banner.
     */
    it("refuses a symlinked installation path rather than removing the link", () => {
        const machine = host({service: true, installed: true});
        const link = machine.at("opt", "linked");

        try {
            fs.symlinkSync(machine.at("opt", "myspeed"), link, "dir");
        } catch {
            return; // No symlink privilege on this host; nothing to assert.
        }

        const result = machine.run("-d", posix(link));

        assert.equal(result.status, 1, "the link was removed and the installation reported gone");
        assert.equal(result.survives(...DATABASE), true);
        assert.match(result.output, /symbolic link/);
    });

    /**
     * A container that will not go is not a container that went. Unchecked, the
     * banner printed over one still serving on its published port.
     */
    it("stops rather than reporting success when the container cannot be removed", () => {
        const machine = host({container: true});

        stub(machine.at("bin", "docker"),
            'if [ "$1" = "ps" ]; then echo MySpeed; exit 0; fi\n'
            + 'if [ "$1" = "rm" ]; then echo "Error response from daemon" >&2; exit 1; fi\nexit 0');

        const result = machine.run();

        assert.equal(result.status, 1, "a container that could not be removed reports a completed uninstall");
        assert.equal(result.completed, false);
    });

    /**
     * And neither is a directory that would not go.
     *
     * The removal is the step that cannot be undone and it was the one step
     * whose failure was discarded: no `set -e`, so `rm -R` failed to stderr and
     * the success banner printed anyway, over an installation still holding its
     * database and its admin password hash. What has to survive with it is the
     * account that owns it - the removal below this one would take the owner of
     * a directory the operator has just been told is still there.
     */
    it("stops rather than reporting success when the installation cannot be removed", () => {
        const result = host({service: true, recorded: true, installed: true, account: true, unremovable: true})
            .run();

        assert.equal(result.status, 1, "a removal that failed reports a finished uninstall");
        assert.equal(result.completed, false);
        assert.match(result.output, /Could not remove/);
        assert.match(result.output, /still on disk/);
        assert.match(result.output, /The service has been stopped and removed/,
            "the failure does not say what it had already done before it failed");
        assert.ok(result.survives(...DATABASE), "the database went after all");
        assert.doesNotMatch(result.calls, /userdel/,
            "the account owning the installation still on disk was deleted");
    });

    /**
     * The failure that finds nothing at all still has to name the path it looked
     * at - that sentence is the only thing that sends anyone to find where their
     * installation actually is.
     */
    it("names the path when it finds nothing anywhere", () => {
        const result = host({}).run();

        assert.equal(result.status, 1, "a host with no MySpeed on it reports a completed uninstall");
        assert.match(result.output, /Found nothing to uninstall/);
        assert.doesNotMatch(result.output, /still on disk/,
            "the failure claims an installation is on disk on a host that has none");
    });

    /**
     * And a second run says the same thing rather than something false. It
     * cannot know whether the first run finished the job or whether the
     * installation is somewhere it was never told to look, so it reports what it
     * found - nothing, at a named path - and does not claim success.
     */
    it("says what it found on a second run rather than claiming an installation is on disk", () => {
        const machine = host({container: true, service: true, recorded: true, installed: true});

        assert.equal(machine.run().status, 0);

        const again = machine.run();

        assert.equal(again.status, 1);
        assert.match(again.output, /Found nothing to uninstall/);
        assert.doesNotMatch(again.output, /still on disk/,
            "the second run says the installation it already removed is still there");
    });
});
