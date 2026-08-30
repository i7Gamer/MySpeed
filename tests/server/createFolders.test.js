import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readSource, withoutJsComments } from "../helpers/source.js";

const HELPER = "server/util/createFolders.js";

// Comments stripped before anything is asserted, for the reason the shared
// helper states: this file explains the mode it picks in prose right beside the
// code that picks it, and a scan asking whether a mode is passed to mkdir is
// otherwise satisfied by the sentence describing one.
const source = withoutJsComments(readSource(HELPER));

// The permission bits out of st_mode. The type bits sit above them, so a raw
// mode never equals 0o700 and an assertion written without the mask passes
// nothing and fails everything.
const MODE_MASK = 0o777;

// What the data directory has to be created at: the owner, and nobody else.
const PRIVATE_MODE = 0o700;

// data itself and everything the server puts inside it. storage.db is written
// into the first one and the TLS key pair into certs.
const PRIVATE_FOLDERS = ["data", "data/logs", "data/servers", "data/certs"];

/**
 * Whether this machine has POSIX mode bits to assert against.
 *
 * node ignores mkdir's mode argument on Windows, where permissions come from the
 * ACL the parent directory hands down instead - so the filesystem half of this
 * cannot say anything there. Skipped rather than failed, and the source scan
 * below runs everywhere precisely so the mode is still pinned on a contributor's
 * Windows box.
 */
const noPosixModes = process.platform === "win32"
    ? "Windows has no POSIX mode bits - node ignores mkdir's mode argument there and the ACL decides"
    : false;

const temporary = [];

const tempDir = () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "myspeed-folders-"));
    temporary.push(dir);
    return dir;
};

after(() => {
    for (const dir of temporary) fs.rmSync(dir, {recursive: true, force: true});
});

/**
 * The helper does its work while it is being imported and reads process.cwd()
 * as it does, so each case needs an evaluation of its own. The query suffix is
 * what gets one: node keys the module cache on the whole specifier, so a second
 * import with a different suffix runs the file again rather than handing back
 * the folders the first case made.
 */
const runIn = async (dir, run) => {
    const previous = process.cwd();
    process.chdir(dir);

    try {
        await import(`../../${HELPER}?run=${run}`);
    } finally {
        process.chdir(previous);
    }
};

const modeOf = (target) => fs.statSync(target).mode & MODE_MASK;

/**
 * The server creates its own data directory whenever the installer did not.
 *
 * install.sh states 700 for it, but only on the branch where it has a service
 * account to hand the installation to. The root fallback - no useradd on the
 * host, or a path an unprivileged account cannot reach - creates no data
 * directory at all, and neither does the container image or a plain `npm start`.
 * In every one of those cases this helper is what makes it, and it made it at
 * the umask's mode: 0755, so storage.db lands 0644 inside it and any local
 * account can read the admin password hash and every integration secret out of
 * it. certs/ holds the TLS private key on the same terms.
 *
 * So the installs the script itself flags as the less safe ones were the installs
 * that got no mode at all.
 */
describe("the folders the server creates for itself", {skip: noPosixModes}, () => {
    it("keeps the data directory and its contents to the account that owns them", async () => {
        const dir = tempDir();
        await runIn(dir, "fresh");

        for (const folder of PRIVATE_FOLDERS)
            assert.equal(modeOf(path.join(dir, folder)), PRIVATE_MODE,
                `${folder} is created at the umask's mode, so what the server writes inside it is readable by any local account`);
    });

    /**
     * Creation only, which is the same policy install.sh states beside its own
     * chmod: the mode of a directory that is already there belongs to whoever
     * installed it. A server that retightened it on every boot would overrule an
     * operator who had deliberately opened it up - to a backup account, say -
     * and would do it silently, every restart.
     */
    it("leaves a directory that already exists at the mode it was given", async () => {
        const dir = tempDir();
        const data = path.join(dir, "data");

        fs.mkdirSync(data);
        fs.chmodSync(data, 0o755);

        await runIn(dir, "existing");

        assert.equal(modeOf(data), 0o755,
            "the server rewrites the mode of a data directory it did not create");
        assert.equal(modeOf(path.join(data, "logs")), PRIVATE_MODE,
            "a subdirectory made inside an existing data directory still gets the umask's mode");
    });
});

/**
 * And the same thing read out of the source, so that it is pinned on a machine
 * where the block above cannot run at all.
 */
describe("the mode the folder helper names", () => {
    it("hands mkdir a mode rather than leaving it to the umask", () => {
        assert.match(source, /fs\.mkdirSync\([^)]*\bmode\b/,
            "mkdir is called without a mode, so data/ is created at whatever the umask allows and storage.db with it");
    });

    /**
     * Read out of the declaration rather than restated, so that widening it to
     * 0o750 or 0o755 fails here instead of quietly passing a test that only
     * asked whether some mode was named.
     */
    it("names it as 0o700 and nothing wider", () => {
        // Either spelling: the octal written into the call, or the name of a
        // constant declared beside it.
        const declared = /\bmode:\s*([\w$]+)/.exec(source);
        assert.notEqual(declared, null, "no mode is named in the call that creates the folders");

        const literal = /^0o[0-7]+$/.test(declared[1])
            ? declared[1]
            : (new RegExp(`\\b${declared[1]}\\s*=\\s*(0o[0-7]+)\\b`).exec(source) || [])[1];

        assert.ok(literal, `${declared[1]} is passed to mkdir but declared nowhere in this file`);
        assert.equal(parseInt(literal.slice(2), 8), PRIVATE_MODE,
            `the data directory is created at ${literal}, which lets accounts other than its owner in`);
    });

    /**
     * And bin, which is the one entry in the list that carries no mode at all.
     *
     * That was never asserted, and it is the entry whose shape changed: it holds
     * the speedtest CLI MySpeed downloads - an executable it fetches rather than
     * a secret it writes - so being left at the umask's mode is a decision, and
     * an entry that simply lost its mode looks exactly the same from outside.
     *
     * Its presence is worth as much as its mode. Nothing above reads the list as
     * a list: the case before this one takes the *first* `mode:` in the file, so
     * dropping an entry moves the match onto the next one and every assertion
     * goes on passing over a folder the server no longer makes - which, for bin,
     * is a downloaded CLI with nowhere to land on first boot.
     */
    it("makes bin as well, and leaves its mode to the umask on purpose", () => {
        const start = source.indexOf("const neededFolder");
        assert.notEqual(start, -1, "the folders the server creates are no longer a declaration this can read");

        const end = source.indexOf("];", start);
        assert.notEqual(end, -1, "the list of folders is never closed");

        const entry = /\{\s*name:\s*"bin"([^}]*)\}/.exec(source.slice(start, end));

        assert.notEqual(entry, null,
            "bin is not among the folders the server creates, so the speedtest CLI it downloads on first boot has nowhere to land");
        assert.doesNotMatch(entry[1], /\bmode\b/,
            "bin is created with a stated mode now, which is a decision about a downloaded executable and belongs beside the ones data/ makes rather than beneath them");
    });
});

/*
 * The container's own copy of this decision is pinned in
 * containerEntrypoint.test.js, not here.
 *
 * It was written in this file, which reads as though the helper covered the
 * container - and the reason those pins exist is that it does not: the image
 * pre-creates /myspeed/data, so `fs.existsSync` is true on the first boot and
 * every boot after it and the 0700 above never runs on a Docker install at all.
 * The Dockerfile states the mode instead, and the entrypoint takes the world
 * bits back off a volume an older image left open. That file already reads and
 * parses the same entrypoint, so both halves live there and this suite is left
 * to the helper it names.
 */
