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
