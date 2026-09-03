import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
    DOWNLOAD_HOLD_MS, forgetDownloadHolds, heldDownload
} from "../../server/util/providers/downloadHold.js";
import { bodyOf, walkSources } from "../helpers/source.js";

/**
 * A CLI install that can never succeed, remembered for a few minutes.
 *
 * `load()` is `if (!await fileExists()) await downloadFile()`, and ensureBinary
 * calls it before every single test. Nothing remembered that the last attempt
 * failed, so a *permanent* failure - Ookla re-publishing an archive, which the
 * trust-on-first-use digest then rejects after the whole transfer, or FreeBSD
 * x64, whose .pkg is tar+xz where only targz and unzip are registered - paid
 * for the entire download again on every tick. On the minutely cron the
 * installer hands out, that is a full archive a minute, forever.
 *
 * The hold is deliberately short. ensureBinary exists for the transient case
 * (github.com blipping, a router that came up after the server), and a long
 * hold would delay recovery from exactly what it was written for.
 */
describe("the download hold", () => {
    beforeEach(() => forgetDownloadHolds());

    const failing = (message) => {
        let calls = 0;
        const download = async () => {
            calls++;
            throw new Error(message);
        };
        return {download, count: () => calls};
    };

    it("lets the first failure through as it is", async () => {
        const {download} = failing("Checksum did not match");

        await assert.rejects(() => heldDownload("ookla", download), /Checksum did not match/);
    });

    it("does not attempt the download again inside the window", async () => {
        const {download, count} = failing("Checksum did not match");
        const now = () => 1_000;

        await assert.rejects(() => heldDownload("ookla", download, {now}));
        await assert.rejects(() => heldDownload("ookla", download, {now}));

        assert.equal(count(), 1);
    });

    /**
     * The remembered message, not a new one about being held: what the operator
     * needs is the digest mismatch or the "format this build cannot unpack",
     * and a row saying only "held" would point at a log line that has scrolled
     * away.
     */
    it("answers a held attempt with the reason the first one failed", async () => {
        const {download} = failing("the archive may be in a format this build cannot unpack");
        const now = () => 1_000;

        await assert.rejects(() => heldDownload("iperf3", download, {now}));
        await assert.rejects(() => heldDownload("iperf3", download, {now}),
            /format this build cannot unpack/);
    });

    it("tries again once the window has passed", async () => {
        const {download, count} = failing("Checksum did not match");
        let clock = 1_000;
        const now = () => clock;

        await assert.rejects(() => heldDownload("ookla", download, {now}));
        clock += DOWNLOAD_HOLD_MS + 1;
        await assert.rejects(() => heldDownload("ookla", download, {now}));

        assert.equal(count(), 2);
    });

    it("forgets the hold as soon as a download succeeds", async () => {
        let attempts = 0;
        const download = async () => {
            attempts++;
            if (attempts === 1) throw new Error("Checksum did not match");
        };
        let clock = 1_000;
        const now = () => clock;

        await assert.rejects(() => heldDownload("libre", download, {now}));
        clock += DOWNLOAD_HOLD_MS + 1;
        await heldDownload("libre", download, {now});
        await heldDownload("libre", download, {now});

        assert.equal(attempts, 3);
    });

    // One provider's broken archive says nothing about another's, and the four
    // loaders share this module.
    it("holds one provider without holding the rest", async () => {
        const ookla = failing("Checksum did not match");
        const libre = failing("Checksum did not match");
        const now = () => 1_000;

        await assert.rejects(() => heldDownload("ookla", ookla.download, {now}));
        await assert.rejects(() => heldDownload("ookla", ookla.download, {now}));
        await assert.rejects(() => heldDownload("libre", libre.download, {now}));

        assert.equal(ookla.count(), 1);
        assert.equal(libre.count(), 1);
    });

    it("is short enough to be a hold rather than an outage", () => {
        const oneMinute = 60 * 1000;

        // The bounds say what the number is for; the literal says what it is.
        // A range this wide is cleared by four different numbers, so on its own
        // it would have let the hold quietly become a quarter of an hour.
        assert.equal(DOWNLOAD_HOLD_MS, 5 * oneMinute);
        assert.ok(DOWNLOAD_HOLD_MS >= oneMinute, "shorter than a minute holds nothing on an hourly cron");
        assert.ok(DOWNLOAD_HOLD_MS <= 15 * oneMinute, "long enough to delay recovery from a transient outage");
    });
});

/**
 * And every loader downloads through it.
 *
 * The module above is a hold nothing has to use: `load()` is four lines in
 * four files, and a single reverted `await heldDownload(...)` back to
 * `await downloadFile()` puts that provider back on the every-tick re-download
 * this exists to stop, with the whole suite above still green. Read out of the
 * directory rather than listed, so a fifth provider is a failure here rather
 * than an omission nobody notices.
 */
describe("the loaders that install a CLI", () => {
    const loaders = walkSources("server/util/providers")
        .filter(({path}) => /\/load[A-Z]\w*\.js$/.test(path));

    it("are the four this project ships", () => {
        assert.deepEqual(loaders.map(({path}) => path.split("/").pop()).sort(),
            ["loadCloudflare.js", "loadIperf3.js", "loadLibre.js", "loadOokla.js"],
            "a provider was added or renamed, and this suite is reading the wrong set");
    });

    it("download through the hold rather than straight", () => {
        for (const {path, source} of loaders) {
            const load = bodyOf(source, "export const load = async ()");

            assert.match(load, /await heldDownload\(/,
                `${path} fetches the archive again on every tick a permanent failure lasts`);
            assert.doesNotMatch(load, /await downloadFile\(\)/,
                `${path} still has a path that downloads without asking the hold`);
        }
    });

    // Behind the existence check, not in front of it: a binary an operator
    // dropped into bin/ by hand has to be picked up on the next tick rather
    // than waiting out a hold left by the download it made unnecessary.
    it("ask the hold only when the binary is missing", () => {
        for (const {path, source} of loaders)
            assert.match(bodyOf(source, "export const load = async ()"),
                /if \(!await fileExists\(\)\) await heldDownload\(/,
                `${path} holds a provider whose binary is already installed`);
    });

    // One name each, and its own: the hold is keyed by it, so two providers
    // sharing a name would hold each other and a typo would hold nothing.
    it("name themselves distinctly to the hold", () => {
        const names = loaders.map(({source}) => /heldDownload\("(\w+)"/.exec(source)?.[1]);

        assert.equal(new Set(names).size, loaders.length,
            `two loaders share a hold key: ${names.join(", ")}`);
    });
});
