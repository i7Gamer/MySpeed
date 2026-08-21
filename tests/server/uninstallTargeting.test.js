import { describe, it } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { readSource, withoutHashComments } from "../helpers/source.js";

/**
 * The uninstaller decides between two entirely different removals, and it used
 * to decide on a substring.
 *
 * `docker ps -a --format '{{.Names}}' | grep -q "MySpeed"` matches any
 * container whose name merely contains MySpeed, and the two branches are
 * exclusive: a native systemd host that also runs an unrelated MySpeedBackup
 * container took the docker branch, so the service was never stopped, the unit
 * was never removed and the data was never deleted - under a banner announcing
 * that MySpeed had been uninstalled. The docker commands inside the branch then
 * failed too, since no container is named exactly MySpeed, and with no `set -e`
 * every one of those failures was swallowed.
 */
const uninstall = withoutHashComments(readSource("scripts/uninstall.sh"));

describe("choosing between the docker and the systemd removal", () => {
    it("matches the container name exactly", () => {
        assert.match(uninstall, /grep -qx ["']MySpeed["']/,
            "the branch is chosen by a substring, so an unrelated container skips the whole systemd removal");
    });

    it("does not decide on a substring", () => {
        assert.doesNotMatch(uninstall, /grep -q ["']MySpeed["']/,
            "an unanchored match still selects the branch");
    });

    /**
     * And it does not choose at all, because the two are not alternatives.
     *
     * A host can hold both: the README recommends Docker, so migrating a native
     * install means running the container beside a systemd unit that is still
     * enabled - and that is exactly the moment somebody reaches for the
     * uninstaller. Written as an if/else, finding the container was the end of
     * it. The service kept running, the unit stayed enabled through every
     * reboot, and the installation stayed on disk with its database and password
     * hash, under a banner announcing that MySpeed had been uninstalled.
     *
     * Both removals are guarded on finding their own half, so running both costs
     * nothing on a host that only has one.
     */
    it("removes a container and a service on a host that has both", () => {
        const container = uninstall.search(/grep -qx ["']MySpeed["']/);
        const service = uninstall.search(/systemctl --all --type service/);

        assert.notEqual(container, -1, "nothing looks for the container");
        assert.notEqual(service, -1, "nothing looks for the service");

        const between = uninstall.slice(container, service);

        assert.doesNotMatch(between, /^\s*else\s*$/m,
            "finding the container is still the end of it, and the service is left running");
        assert.match(between, /^\s*fi\s*$/m,
            "the docker removal never closes, so the service check is inside it");
    });

    /**
     * But the native half still has to skip a host that never had one. `rm -R`
     * against a path that was never there is checked and fatal - deliberately,
     * because that check is what stops a failed removal printing the success
     * banner - so running it unconditionally would fail the very uninstall it
     * had just completed.
     */
    it("does not fail a docker-only host over an installation directory it never had", () => {
        assert.match(uninstall, /-d "\$INSTALLATION_PATH"/,
            "the native removal runs whether or not there is anything native to remove");
    });

    // And a native host still gets the loud failure when the path is wrong,
    // which is the one thing that sends anyone to look for it.
    it("still names the path it could not remove", () => {
        assert.match(uninstall, /Could not remove \$INSTALLATION_PATH/,
            "a removal that failed is silent again, under a banner saying it worked");
    });

    // -n prints the matched line with its number, which lands in the middle of
    // the uninstall output. -q is what the condition actually wants.
    it("asks the service list quietly", () => {
        assert.doesNotMatch(uninstall, /systemctl --all --type service \| grep -n/,
            "the systemd check dumps its match into the uninstall output");
    });
});

/**
 * And the unit files are removed the way they are read: through the list that
 * names them, guarded.
 *
 * Both paths were removed with a bare `rm`, though install.sh only ever writes
 * the first - so every ordinary uninstall printed "cannot remove
 * /usr/lib/systemd/system/myspeed.service: No such file or directory" to
 * stderr, swallowed for want of `set -e`, directly beneath a success banner.
 * The file already declares SERVICE_FILES and already guards it with [ -f ]
 * where it reads the recorded path; the removal simply did not use it.
 */
describe("removing the unit file", () => {
    it("removes only what is there", () => {
        assert.doesNotMatch(uninstall, /^\s*rm \/etc\/systemd\/system\/myspeed\.service\s*$/m,
            "a unit path is removed unguarded, so a normal uninstall prints an error under a success banner");
        assert.doesNotMatch(uninstall, /^\s*rm \/usr\/lib\/systemd\/system\/myspeed\.service\s*$/m,
            "the path install.sh never creates is still removed unguarded");
    });

    it("uses the list that already names both paths", () => {
        assert.match(uninstall, /for unit in "\$\{SERVICE_FILES\[@\]\}"[^]*?rm -f "\$unit"/,
            "the removal spells the paths out again instead of walking SERVICE_FILES");
    });

    it("still removes the unit at all", () => {
        assert.match(uninstall, /systemctl daemon-reload/, "the unit is removed without telling systemd");
    });
});

/**
 * Whether a POSIX shell is here to run a condition in.
 *
 * The block below lifts one `if` out of the uninstaller and evaluates it, which
 * needs `sh`. That is always there on the Linux runner the suite gates releases
 * on, and not guaranteed on a contributor's Windows box - Git ships one, but
 * only the installer option that puts its Unix tools on PATH makes it
 * resolvable. Skipped there rather than failed, exactly as installScripts.test.js
 * skips its own; the runner prints the reason, so a skip cannot read as a pass.
 */
const CONDITION_TIMEOUT = 10_000;

const noPosixShell = (() => {
    try {
        execFileSync("sh", ["-c", "exit 0"], {timeout: CONDITION_TIMEOUT, stdio: "ignore"});
        return false;
    } catch {
        return "no POSIX shell on PATH - uninstall.sh is a Linux uninstaller and this block runs a condition from it";
    }
})();

/**
 * The two rules the end of the uninstall turns on, run rather than read.
 *
 * Reading them cannot say what they answer, and between them they have to
 * separate three situations that look identical from the outside:
 *
 *   - a host that only ever ran the container, where there is no installation
 *     directory and never was one;
 *   - a host whose native installation is genuinely already gone, leaving a
 *     unit behind;
 *   - a host whose native installation is still on disk somewhere this run was
 *     not told to look.
 *
 * The first two are finished uninstalls and must not be reported as failures.
 * The third must not be reported as a success: the directory left behind holds
 * the database and the admin password hash.
 *
 * What separates the last two is where the path came from. With no -d the script
 * reads WorkingDirectory out of the unit before deleting it, so the path is the
 * system's own answer and an empty one means the installation is gone. With -d
 * the path is the operator's, and a typo in it is indistinguishable from an
 * absence - so that is the case that gets told.
 */
describe("the end of the uninstall", {skip: noPosixShell}, () => {
    const fragment = (opening) => {
        const at = uninstall.indexOf(opening);
        assert.notEqual(at, -1, `${opening} is no longer how this is decided`);

        return uninstall.slice(at, uninstall.indexOf("; then", at));
    };

    const PRESENT = os.tmpdir();
    const ABSENT = path.join(os.tmpdir(), "myspeed-no-such-installation-directory");

    const answer = (condition, {container, service, directory, fromUnit = 1}) => execFileSync("sh", ["-c",
        `REMOVED_CONTAINER=${container}\nFOUND_SERVICE=${service}\nPATH_FROM_UNIT=${fromUnit}\n`
        + `INSTALLATION_FOUND=${directory ? 1 : 0}\n`
        + `INSTALLATION_PATH="${directory ? PRESENT : ABSENT}"\n`
        + `${condition}; then echo yes; else echo no; fi`],
    {encoding: "utf8", timeout: CONDITION_TIMEOUT}).trim() === "yes";

    describe("whether the installation directory is removed", () => {
        const removes = (state) => answer(fragment('if [ -d "$INSTALLATION_PATH" ]'), state);

        it("removes it wherever there is one", () => {
            for (const container of [0, 1])
                for (const service of [0, 1])
                    assert.equal(removes({container, service, directory: true}), true,
                        `an installation directory was left on disk (container=${container} service=${service})`);
        });

        it("leaves a host that only ever had a container alone", () => {
            assert.equal(removes({container: 1, service: 0, directory: false}), false,
                "a finished docker uninstall fails on an installation directory it never had");
        });

        /**
         * Nothing is there to remove, so nothing is attempted - `rm -R` on a
         * path that was never there is checked and fatal, and would report a
         * finished uninstall as a failure. Whether that absence is worth saying
         * anything about is the second rule's question, not this one's.
         */
        it("does not chase a directory that is not there just because a unit was", () => {
            assert.equal(removes({container: 1, service: 1, directory: false}), false,
                "an uninstall that removed everything it found reports failure");
            assert.equal(removes({container: 0, service: 1, directory: false}), false,
                "a native installation already removed by hand reports failure");
        });

        /**
         * And a host where nothing at all was found still reaches the removal, so
         * the operator is told which path was looked at rather than being handed
         * a success banner over an untouched installation.
         */
        it("still reaches the removal when nothing else was found either", () => {
            assert.equal(removes({container: 0, service: 0, directory: false}), true,
                "an uninstall that found nothing anywhere reports success");
        });
    });

    describe("whether an unaccounted installation is reported", () => {
        // Both this and the account rule below open on FOUND_SERVICE, so the
        // anchor carries enough of the condition to tell them apart.
        const warns = (state) =>
            answer(fragment('if [ "$FOUND_SERVICE" -eq 1 ] && [ "$INSTALLATION_FOUND" -eq 0 ]'), state);

        /**
         * The case that has to be caught. A container beside a native install,
         * and `-d` naming a path that is not the installation - a typo, or the
         * wrong one of two. Everything found is removed, the unit file goes with
         * it, and the real installation is left on disk with its database and its
         * password hash under a banner saying MySpeed has been uninstalled.
         */
        it("reports an installation it was told about but never found", () => {
            assert.equal(warns({container: 1, service: 1, directory: false, fromUnit: 0}), true,
                "a wrong -d reports a complete uninstall over an installation still on disk");
            assert.equal(warns({container: 0, service: 1, directory: false, fromUnit: 0}), true,
                "the same without a container");
        });

        /**
         * But not when the path is the system's own answer. The unit named that
         * directory and it is not there, so the installation is gone - which is
         * an uninstall that is over, not one to warn about.
         */
        it("says nothing when the path came from the unit itself", () => {
            assert.equal(warns({container: 1, service: 1, directory: false, fromUnit: 1}), false,
                "a native install already removed by hand is reported as a problem");
        });

        it("says nothing when there was no service to have an installation", () => {
            for (const fromUnit of [0, 1])
                assert.equal(warns({container: 1, service: 0, directory: false, fromUnit}), false,
                    "a docker-only host is warned about a native installation it never had");
        });

        it("says nothing when the installation was found and removed", () => {
            for (const fromUnit of [0, 1])
                assert.equal(warns({container: 1, service: 1, directory: true, fromUnit}), false,
                    "an installation that was removed is reported as unaccounted for");
        });
    });
});

/**
 * And the account install.sh creates belongs to the service, not to the
 * directory.
 *
 * It used to be removed in the `else` of the container branch, so a host running
 * both kept its `myspeed` entry in /etc/passwd - and the installer only runs
 * useradd when the account is missing, so it survived every later uninstall too,
 * with a home directory that no longer exists. Restructuring the script moved it
 * inside the block that removes the installation directory, which fixed that
 * cell and broke another: a native install whose directory was already gone left
 * the account behind for the same reason.
 *
 * What it turns on is whether there was ever a native installation here, which
 * is the unit or the directory - never the container, which creates no account
 * on the host at all.
 */
describe("whether the service account is removed", {skip: noPosixShell}, () => {
    const removes = ({service, directory}) => execFileSync("sh", ["-c",
        `FOUND_SERVICE=${service}\nINSTALLATION_FOUND=${directory}\n`
        + `${(() => {
            const at = uninstall.indexOf('if [ "$FOUND_SERVICE" -eq 1 ] || [ "$INSTALLATION_FOUND" -eq 1 ]');
            assert.notEqual(at, -1, "nothing decides whether the account is removed");
            return uninstall.slice(at, uninstall.indexOf("; then", at));
        })()}; then echo yes; else echo no; fi`],
    {encoding: "utf8", timeout: CONDITION_TIMEOUT}).trim() === "yes";

    it("removes it when a service was found", () => {
        assert.equal(removes({service: 1, directory: 0}), true,
            "a native install whose directory was already gone leaves its account in /etc/passwd");
    });

    it("removes it when an installation was found", () => {
        assert.equal(removes({service: 0, directory: 1}), true,
            "an installation whose unit was already removed by hand leaves its account behind");
    });

    it("leaves a docker-only host's accounts alone", () => {
        assert.equal(removes({service: 0, directory: 0}), false,
            "a host that never had a native install has an account deleted out from under it");
    });
});
