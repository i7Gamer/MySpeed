import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { load } from "../../server/util/loadCli.js";
import { ooklaList, libreList, cloudflareList } from "../../server/config/binaries.js";

const provider = (name, behaviour) => ({name, provider: {load: behaviour}});

const succeeding = (calls, name) => provider(name, async () => { calls.push(name); });
const failing = (name, message) => provider(name, async () => { throw new Error(message); });

/** Runs `body` with console.error captured rather than printed. */
const withCapturedErrors = async (body) => {
    const original = console.error;
    const lines = [];
    console.error = (...args) => lines.push(args.join(" "));

    try {
        await body();
    } finally {
        console.error = original;
    }

    return lines;
};

/**
 * Preparing the speedtest CLIs must never be able to stop the server booting.
 *
 * index.js awaits this before it listens, and wraps the whole start-up in a
 * catch that exits 112 - so one rejection here took the instance down instead
 * of the dashboard coming up. Both triggers were ordinary: a container upgrade
 * while github.com or install.speedtest.net was briefly unreachable (the bin
 * directory sits outside the data volume, so every upgrade re-downloads), and
 * any platform with no entry in the binary list at all.
 *
 * Nothing is gained by being fatal. A missing binary is already handled where
 * it matters: the run path retries and then records a failed test, which is a
 * visible, recoverable state - unlike a crash-looping container whose entire
 * mounted history is unreachable.
 */
describe("preparing the provider CLIs", () => {
    it("resolves even when a provider cannot be downloaded", async () => {
        await withCapturedErrors(() => load([failing("Ookla", "Download failed: returned 403")]));
    });

    it("still prepares the other providers when one fails", async () => {
        const calls = [];

        await withCapturedErrors(() => load([
            succeeding(calls, "librespeed"),
            failing("Ookla", "Download failed: returned 403"),
            succeeding(calls, "Cloudflare")
        ]));

        assert.deepEqual(calls.sort(), ["Cloudflare", "librespeed"]);
    });

    // A silent failure would leave the operator with a provider that never runs
    // and nothing anywhere saying why.
    it("reports each failure by name and reason", async () => {
        const lines = await withCapturedErrors(() => load([
            failing("Ookla", "not supported on darwin-arm64"),
            failing("Cloudflare", "returned 500")
        ]));

        assert.equal(lines.length, 2);
        assert.match(lines[0], /Ookla/);
        assert.match(lines[0], /not supported on darwin-arm64/);
        assert.match(lines[1], /Cloudflare/);
    });

    it("says nothing when every provider is ready", async () => {
        const lines = await withCapturedErrors(() => load([succeeding([], "librespeed")]));

        assert.deepEqual(lines, []);
    });
});

const archesFor = (list, os) => list.filter((entry) => entry.os === os).map((entry) => entry.arch).sort();

/**
 * The Ookla list named two macOS archives that install.speedtest.net does not
 * serve. `macosx-x86_64.tgz` answers 403 - the same as any name that was never
 * published - and there was no arm64 entry at all, so both Apple platforms
 * threw out of the download and took start-up with them. Ookla ships one
 * universal build for macOS; that is the file that exists.
 */
describe("the provider binary lists", () => {
    it("covers both macOS architectures for every provider", () => {
        for (const [name, list] of [["ookla", ooklaList], ["libre", libreList], ["cloudflare", cloudflareList]])
            assert.deepEqual(archesFor(list, "darwin").filter((arch) => arch !== "universal"),
                ["arm64", "x64"], `${name} does not cover both macOS architectures`);
    });

    it("points both macOS entries at Ookla's universal archive", () => {
        for (const entry of ooklaList.filter((candidate) => candidate.os === "darwin"))
            assert.equal(entry.suffix, "macosx-universal.tgz",
                `darwin/${entry.arch} names an archive install.speedtest.net does not serve`);
    });

    it("names each platform once per provider", () => {
        for (const [name, list] of [["ookla", ooklaList], ["libre", libreList], ["cloudflare", cloudflareList]]) {
            const keys = list.map((entry) => `${entry.os}/${entry.arch}`);
            assert.equal(new Set(keys).size, keys.length, `${name} lists a platform twice`);
        }
    });
});
