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
 * The rule deciding whether the native installation is removed, run rather than
 * read.
 *
 * Reading it cannot say what it answers, and this one is not obvious: it has to
 * be false for a host that only ever had a container - `rm -R` on a path that
 * was never there is checked and fatal, so running it there would report a
 * finished uninstall as a failure - while staying true for a native host that
 * found nothing, which is the case that has to reach the removal to be told
 * which path it could not remove.
 */
describe("whether the native installation is removed", {skip: noPosixShell}, () => {
    const guard = (() => {
        const at = uninstall.indexOf('if [ "$REMOVED_CONTAINER"');
        assert.notEqual(at, -1, "nothing decides whether to remove the installation directory");

        return uninstall.slice(at, uninstall.indexOf("; then", at));
    })();

    // A directory that is there, and one that is not, rather than a stubbed
    // test: `-d` is the operator the condition uses and the filesystem is what
    // answers it.
    const PRESENT = os.tmpdir();
    const ABSENT = path.join(os.tmpdir(), "myspeed-no-such-installation-directory");

    const removes = ({container, service, directory}) => execFileSync("sh", ["-c",
        `REMOVED_CONTAINER=${container}\nFOUND_SERVICE=${service}\n`
        + `INSTALLATION_PATH="${directory ? PRESENT : ABSENT}"\n`
        + `${guard}; then echo yes; else echo no; fi`],
    {encoding: "utf8", timeout: CONDITION_TIMEOUT}).trim() === "yes";

    it("leaves a host that only ever had a container alone", () => {
        assert.equal(removes({container: 1, service: 0, directory: false}), false,
            "a finished docker uninstall fails on an installation directory it never had");
    });

    /** The migration case: the container running beside the unit it replaced. */
    it("removes it on a host that has both", () => {
        assert.equal(removes({container: 1, service: 1, directory: false}), true,
            "the native installation survives an uninstall because a container was found first");
    });

    it("removes a native installation left beside a container", () => {
        assert.equal(removes({container: 1, service: 0, directory: true}), true,
            "an installation directory sitting next to a container is left on disk");
    });

    /**
     * And a native host reaches the removal whatever was found, so a wrong -d
     * still earns the message naming the path. Skipping quietly there would put
     * the success banner over an installation still on disk, which is the thing
     * the checked `rm` exists to prevent.
     */
    it("still reaches the removal on a host with no container at all", () => {
        assert.equal(removes({container: 0, service: 0, directory: false}), true,
            "an uninstall that found nothing reports success without saying so");
    });

    it("removes an ordinary native installation", () => {
        assert.equal(removes({container: 0, service: 1, directory: true}), true,
            "the ordinary uninstall no longer removes anything");
    });
});
