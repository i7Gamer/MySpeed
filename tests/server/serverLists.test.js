import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getLibreServers, getOoklaServers } from "../../server/controller/servers.js";

const OOKLA = "data/servers/ookla.json";
const LIBRE = "data/servers/librespeed.json";

let workingDirectory;
let originalCwd;

/**
 * The lists are resolved against the working directory, as the database is, so
 * the test moves there rather than reaching into the module.
 */
before(() => {
    originalCwd = process.cwd();
    workingDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "myspeed-servers-"));
    process.chdir(workingDirectory);
    fs.mkdirSync("data/servers", {recursive: true});
});

after(() => {
    process.chdir(originalCwd);
    fs.rmSync(workingDirectory, {recursive: true, force: true});
});

const write = (file, contents) => fs.writeFileSync(file, contents);

/**
 * A server list file that is there but unreadable.
 *
 * These files are downloaded in the background at boot and written with a plain
 * writeFileSync, which is not atomic - a container stopped mid-write, or a full
 * disk, leaves a truncated file behind. JSON.parse then threw out of a getter
 * that three request paths call: the metrics scrape, the provider dialog's
 * server list, and librespeed's server selection.
 *
 * Worse than the throw was what it left behind. The module assigned the raw
 * Buffer to its cache and then parsed it in place, so a parse that threw left
 * the Buffer sitting in the cache - and every later call took the early return
 * and handed that Buffer back as though it were the list. The first caller got
 * a 500; every caller after it got a Buffer where an object belonged, silently,
 * until the process was restarted.
 */
describe("a server list that cannot be read", () => {
    it("answers with no servers rather than throwing", () => {
        write(OOKLA, '{"1": {"sponsor": "Half a file"');

        assert.deepEqual(getOoklaServers(), [], "a truncated list is thrown out of the getter");
    });

    // The point of the fix: the second call is where the Buffer used to appear.
    it("does not hand back a buffer on the next call", () => {
        write(OOKLA, '{"1": {"sponsor": "Half a file"');

        getOoklaServers();
        const second = getOoklaServers();

        assert.equal(Buffer.isBuffer(second), false, "the cache is holding the unparsed file");
        assert.deepEqual(second, []);
    });

    /**
     * And the failure is not cached, so the next download heals it.
     *
     * The lists arrive asynchronously at boot; an empty answer means the file is
     * missing, half-written or still on its way, and every one of those resolves
     * on its own. Caching it would outlive all of them.
     */
    it("picks up the file once it is written properly", () => {
        write(LIBRE, "not json at all");
        assert.deepEqual(getLibreServers(), []);

        write(LIBRE, JSON.stringify({"3": {name: "Frankfurt"}}));

        assert.deepEqual(getLibreServers(), {"3": {name: "Frankfurt"}},
            "the empty answer was cached, so a list that arrived later is never read");
    });

    it("caches a list that did parse", () => {
        write(LIBRE, JSON.stringify({"3": {name: "Frankfurt"}}));
        getLibreServers();

        // Removed underneath it: a second read would answer with nothing.
        fs.rmSync(LIBRE);

        assert.deepEqual(getLibreServers(), {"3": {name: "Frankfurt"}},
            "the list is re-read from disk on every call");
    });

    it("answers with no servers when the file is not there at all", () => {
        fs.rmSync(OOKLA, {force: true});

        // A fresh module state is not available here, so this asserts the shape
        // rather than the identity - ookla was left unparseable above, so
        // nothing is cached for it.
        assert.deepEqual(getOoklaServers(), []);
    });
});
