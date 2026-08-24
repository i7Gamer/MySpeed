import { describe, it } from "node:test";
import assert from "node:assert/strict";
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
/**
 * What this file asks is which shape the script has, and nothing about what it
 * decides.
 *
 * It used to hold both. The end of the uninstall turns on two rules that reading
 * cannot answer, so the rules were lifted out by string anchor and evaluated in
 * `sh` on their own - and twice an anchor drifted onto a different block and the
 * tests went on passing against code they no longer named, while the rule they
 * were written for shipped a defect. A condition evaluated alone also cannot see
 * the block that ran before it or the variable that was not set yet, which is
 * where both of those defects lived.
 *
 * Those cases now run the whole script against a sandboxed filesystem, in
 * uninstallBehaviour.test.js, and assert what an operator is left with. What is
 * left here is the handful of properties that genuinely are properties of the
 * text: an anchored grep, two removals that are not each other's `else`, and the
 * unit files walked through the list that names them.
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
