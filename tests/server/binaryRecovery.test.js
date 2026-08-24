import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ensureBinary } from "../../server/util/speedtest.js";
import { readSource, bodyOf } from "../helpers/source.js";

/**
 * A CLI the boot could not fetch used to stay unfetched for the life of the
 * process.
 *
 * loadCli reports a download it could not finish and carries on, deliberately -
 * one unreachable release must not stop the dashboard coming up, and the
 * comments there say so. But nothing ever tried again. The run path spawned
 * ./bin/<cli> directly, so a container started during a brief github.com or
 * install.speedtest.net outage - or on a connection that came up a moment after
 * the server did, which is every router reboot - recorded a failed test every
 * scheduled run, for ever, until somebody restarted it. The stored reason said
 * the binary was not there and pointed at a boot log that had scrolled away
 * hours earlier.
 *
 * The provider loaders already answer exactly the right question: `load()`
 * checks whether the file is there and downloads it only if it is not. Asking
 * it on the way into a run costs one existsSync when the CLI is present, and
 * turns a permanent failure into one that fixes itself the moment the network
 * comes back.
 */
const loader = (behaviour) => ({load: behaviour});

const ready = (calls, name) => loader(async () => { calls.push(name); });
const broken = (message) => loader(async () => { throw new Error(message); });

describe("the CLI a run is about to spawn", () => {
    it("asks the provider loader for the mode being run", async () => {
        const calls = [];

        await ensureBinary("ookla", "./bin/speedtest", {
            ookla: ready(calls, "ookla"),
            libre: ready(calls, "libre"),
            cloudflare: ready(calls, "cloudflare")
        });

        assert.deepEqual(calls, ["ookla"], "the run prepares some other provider's CLI, or none at all");
    });

    it("says nothing when the loader is happy, whether it downloaded or not", async () => {
        await ensureBinary("libre", "./bin/librespeed-cli", {libre: ready([], "libre")});
    });

    /**
     * The reason, rather than the ENOENT that followed it.
     *
     * Spawning after a download that failed produces `ENOENT: posix_spawn
     * './bin/cfspeedtest'`, and the message built from that can only say the
     * file is missing and point at the log. The loader knows *why* - a 403, a
     * DNS failure, a platform with no published build, the musl refusal
     * cfspeedtest carries - and that is what belongs on the failed test.
     */
    it("explains a download that failed rather than letting the spawn fail", async () => {
        await assert.rejects(
            () => ensureBinary("cloudflare", "./bin/cfspeedtest",
                {cloudflare: broken("cfspeedtest publishes no musl build")}),
            (error) => {
                assert.match(error.message, /\.\/bin\/cfspeedtest/, "the message does not name the CLI");
                assert.match(error.message, /cfspeedtest publishes no musl build/,
                    "the reason the loader gave is thrown away");
                return true;
            });
    });

    /**
     * And a mode with no loader is left to the spawn. There is no provider to
     * ask, so refusing here would replace a failure that names the binary with
     * one that names an internal lookup.
     */
    it("leaves a mode it has no loader for alone", async () => {
        await ensureBinary("somethingelse", "./bin/whatever", {});
    });
});

/**
 * And the run actually asks. A helper nothing calls is the same permanent
 * failure with a test suite over it.
 */
describe("the run path", () => {
    const run = bodyOf(readSource("server/util/speedtest.js"), "export default async (mode");

    it("prepares the CLI before it spawns one", () => {
        const prepared = run.indexOf("ensureBinary(");
        const spawned = run.indexOf("spawn(");

        assert.notEqual(prepared, -1, "a run spawns whatever is on disk and never asks for what is not");
        assert.notEqual(spawned, -1, "the run no longer spawns anything");
        assert.ok(prepared < spawned, "the CLI is fetched after the spawn that needed it has already failed");
    });

    it("waits for it rather than racing the spawn", () => {
        assert.match(run, /await ensureBinary\(/,
            "the download is not awaited, so the spawn runs against a file that is still arriving");
    });

    // The path that is spawned, not a second spelling of it: a message naming
    // one file while another was spawned is worse than no message.
    it("prepares the same path it spawns", () => {
        assert.match(run, /ensureBinary\(mode,\s*binaryPath\)/,
            "the CLI prepared is named differently from the one spawned");
    });
});
