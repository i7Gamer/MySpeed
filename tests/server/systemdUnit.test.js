import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readSource } from "../helpers/source.js";

/**
 * The systemd unit scripts/install.sh writes, read out of its heredoc.
 *
 * With `Restart=always` and no `RestartSec`, systemd restarts after 100ms and
 * gives up for good after five starts in ten seconds. A boot on which the
 * server exits at once - a data directory on a mount that is not up yet, a
 * port another process took first - burned through that in half a second and
 * left the service failed until someone noticed the web interface was gone.
 * And `network.target` only means the network stack exists, not that an
 * address or a route does.
 */
const install = readSource("scripts/install.sh");
const start = install.indexOf('cat << EOF > "$SERVICE_FILE"');
const unit = install.slice(start, install.indexOf("\nEOF", start));

const section = (name) => {
    const from = unit.indexOf(`[${name}]`);
    assert.notEqual(from, -1, `the unit has no [${name}] section`);
    const next = unit.indexOf("\n[", from + 1);
    return unit.slice(from, next === -1 ? undefined : next);
};

const MIN_RESTART_SEC = 1;

describe("the systemd unit install.sh writes", () => {
    it("is found where the script writes it", () => {
        assert.notEqual(start, -1, "install.sh no longer writes the unit through this heredoc");
        assert.match(unit, /\[Service\]/);
    });

    it("waits between restarts long enough not to exhaust the start limit", () => {
        const match = /^RestartSec=(\d+)$/m.exec(section("Service"));

        assert.ok(match, "no RestartSec: systemd restarts after 100ms and stops after five tries");
        assert.ok(Number(match[1]) >= MIN_RESTART_SEC);
    });

    it("still restarts on every exit", () => {
        assert.match(section("Service"), /^Restart=always$/m);
    });

    it("starts once the network is up, not merely configured", () => {
        const unitSection = section("Unit");

        assert.match(unitSection, /^After=network-online\.target$/m);
        assert.match(unitSection, /^Wants=network-online\.target$/m,
            "After= alone orders against the target but does not pull it into the boot");
    });
});
