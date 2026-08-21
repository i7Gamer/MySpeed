import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readSource, withoutHashComments } from "../helpers/source.js";

/**
 * The one moment the container is root.
 *
 * The image deliberately starts as uid 0 and drops to `bun` itself, rather than
 * declaring USER, so that a data volume left behind by an older root-owned image
 * can be taken over on upgrade - the alternative was every existing install
 * being unable to write its own database after a `docker pull`. That handover is
 * a recursive chown run as root over a directory whose contents the unprivileged
 * server writes, which is a narrow but real thing to get right.
 *
 * chown resolves a symlink it is handed unless told not to. So a symlink planted
 * anywhere under /myspeed/data - which the server process can write, and which
 * is the first thing to look at after any compromise of it - is followed on the
 * next restart, and the file at the far end is handed to the very account the
 * server runs as. `data/x -> /etc/shadow` is the shape of it. -h changes the
 * link itself instead, which is the only thing in the volume that needs
 * changing.
 */
const entrypoint = withoutHashComments(readSource("docker-entrypoint.sh"));

const chown = entrypoint.split("\n").find((line) => /^\s*chown\b/.test(line));

describe("taking ownership of an upgraded volume", () => {
    it("still happens at all", () => {
        assert.ok(chown, "nothing hands the volume over, so an upgraded install cannot write its own database");
    });

    it("does not follow a symlink out of the volume", () => {
        assert.match(chown, /chown\s+(?:-\w*h\w*|--no-dereference)/,
            "a symlink under the data volume is followed, so its target is handed to the account the server runs as");
    });

    it("still reaches everything under the volume", () => {
        assert.match(chown, /chown\s+(?:-\w*R\w*|--recursive)/,
            "only the two directories themselves are handed over, so nothing inside them is writable");
    });

    it("still hands over both of the directories the server writes", () => {
        assert.match(chown, /\/myspeed\/data\b/, "the data volume is no longer handed over");
        assert.match(chown, /\/myspeed\/bin\b/, "the directory the CLIs are downloaded into is no longer handed over");
    });

    /**
     * And the privileges are dropped after it, not before. Reversed, the chown
     * runs as `bun` and silently changes nothing on the volume it exists to
     * repair - while the whole server goes on running as root.
     */
    it("drops to the unprivileged account afterwards", () => {
        const handover = entrypoint.indexOf("chown");
        const drop = entrypoint.search(/su-exec\s+bun\b/);

        assert.notEqual(drop, -1, "the container no longer drops out of root at all");
        assert.ok(handover < drop, "privileges are dropped before the handover, which then changes nothing");
    });
});
