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

/**
 * The block the container runs only as uid 0, and everything below it.
 *
 * Bounded by the `fi` standing in the first column, which is where the gate
 * closes. Asserted apart rather than against the file as a whole, because which
 * side of that gate a line sits on is the whole question for a `--user`
 * deployment: "the entrypoint tightens the volume" is satisfied by a line only
 * root ever reaches, and a rootless container - the hardened one the gate exists
 * to let straight through - would go on carrying a legacy volume's 0755 with
 * every assertion green.
 */
const paths = () => {
    const gate = entrypoint.indexOf('[ "$(id -u)"');
    assert.notEqual(gate, -1, "nothing asks whether the container started as root");

    const end = entrypoint.search(/^fi\s*$/m);
    assert.ok(end > gate, "the root-only block is never closed, so there is no path below it to read");

    return {asRoot: entrypoint.slice(gate, end), asAnyone: entrypoint.slice(end)};
};

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

/**
 * The mode of the same volume, which is the other half of the policy install.sh
 * states for its own data directory.
 *
 * These pins were written in createFolders.test.js, beside the assertions about
 * server/util/createFolders.js - and the reason they exist is that the helper
 * never runs on this path at all. The image pre-creates /myspeed/data so that
 * the VOLUME declared over it takes that directory's mode and ownership rather
 * than the daemon's defaults, so `fs.existsSync` is true on the first boot and
 * every boot after it: the helper's 0700 is unreachable on any Docker install
 * that has ever existed, and storage.db sits 0644 in a 0755 directory, in a
 * container whose server downloads and spawns third-party binaries.
 *
 * So the image is where the mode has to be stated. This file already reads and
 * parses the entrypoint that carries the other half, which is why both are here.
 */
describe("the mode the container's data directory is created at", () => {
    // Comments stripped for the reason the entrypoint's are: the Dockerfile
    // explains its permissions in prose sitting directly above the line that
    // sets them.
    const dockerfile = withoutHashComments(readSource("Dockerfile"));

    it("makes the volume's directory itself, so the daemon does not", () => {
        for (const folder of ["data", "bin"])
            assert.match(dockerfile, new RegExp(`mkdir -p [^\\n]*/myspeed/${folder}\\b`),
                `/myspeed/${folder} is left to the daemon, which creates it root-owned at 0755 on first run`);
    });

    it("states 700 for it rather than taking the build's umask", () => {
        assert.match(dockerfile, /chmod 700 \/myspeed\/data\b/,
            "the image creates /myspeed/data under the build umask, so the VOLUME inherits 0755 and the server's own 0700 never runs");
    });

    /**
     * And only for it. bin holds the speedtest CLI - the one shipped in the
     * image and the ones downloaded on first boot - which is the same reason the
     * helper's own list leaves it modeless.
     */
    it("does not state it for the CLI directory as well", () => {
        assert.doesNotMatch(dockerfile, /chmod\s+[0-7]{3,4}\s+[^\n]*\/myspeed\/bin\b/,
            "bin is given the data directory's mode, which is a decision about secrets rather than about a downloaded executable");
    });
});

/**
 * And the same mode on every start rather than at build time.
 *
 * `docker pull` replaces the image and leaves the volume, so a data directory
 * initialised by an image older than the Dockerfile's `chmod 700` keeps its 0755
 * for ever - and the server's own helper never looks at a directory that already
 * exists, so nothing else is placed to notice.
 *
 * On both sides of the root gate, which is the part that was missing. The
 * tightening sat inside `id -u = 0`, so the deployments that go straight past
 * that gate - a `--user` container over a legacy named volume, and every bind
 * mount, which no image has ever initialised - kept 0755 through every start
 * while the comment above the line claimed this was the only moment anything was
 * placed to notice.
 */
describe("tightening a volume an older image left open", () => {
    it("takes the world bits off when it is root", () => {
        assert.match(paths().asRoot, /chmod o-rwx \/myspeed\/data\b/,
            "a volume initialised by an older image carries 0755 through every upgrade, and the server's own helper never looks at a directory that exists");
    });

    /**
     * o-rwx rather than 700, for the reason install.sh gives at the same
     * decision: what is mounted there may be a host directory whose group bits
     * are the operator's, and a container that rewrote them on every restart
     * would overrule that silently and repeatedly. The world bits are the part
     * of the mode nobody picks on purpose.
     */
    it("does not retighten it to an absolute mode, on either path", () => {
        assert.doesNotMatch(entrypoint, /chmod\s+[0-7]{3,4}\b/,
            "a bind-mounted host directory is retightened to an absolute mode on every start, overruling whoever chose it");
    });

    /**
     * And tries the same below the gate, where a `--user` deployment is the only
     * thing that ever runs. Rootless over a volume it owns succeeds; rootless
     * over a root-owned one does not, and that is the case the silence below is
     * about.
     */
    it("tries the same on the path a --user deployment takes", () => {
        assert.match(paths().asAnyone, /chmod o-rwx \/myspeed\/data\b/,
            "the tightening is inside the id -u gate, so a rootless deployment over a legacy volume keeps 0755 for ever, and so does every bind mount");
    });

    /**
     * Silently, unlike the root path's, and guarded like it.
     *
     * Root failing to tighten a volume it owns is worth a line - it could have
     * changed that mode and did not. Rootless failing is the ordinary case: the
     * volume belongs to root and this container is not root, which is exactly
     * the deployment the gate above exists to let through. A warning there is one
     * line of alarm on every start of every correctly hardened install, which is
     * how a warning stops being read.
     *
     * The `|| true` is not decoration either: `set -e` is on, so an unguarded
     * chmod that fails ends the container before the server it exists to start
     * has run at all.
     */
    it("says nothing when it cannot, rather than warning on every start", () => {
        const below = paths().asAnyone;
        const attempt = below.split("\n").find((line) => /chmod o-rwx/.test(line));

        assert.ok(attempt, "the rootless path no longer attempts it at all");
        assert.match(attempt, /2>\/dev\/null/,
            "the failure a rootless container over a root-owned volume always hits is printed to stderr on every start");
        assert.match(attempt, /\|\|\s*true/,
            "set -e turns a chmod this path is not allowed to make into a container that never starts the server");
        assert.doesNotMatch(below, /\becho\b/,
            "the rootless path prints a warning for the case it was written to expect, which is a line of alarm on every start of every hardened deployment");
    });
});
