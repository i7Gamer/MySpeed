import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
    DOWNLOAD_HOLD_MS, forgetDownloadHolds, heldDownload
} from "../../server/util/providers/downloadHold.js";

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

        assert.ok(DOWNLOAD_HOLD_MS >= oneMinute, "shorter than a minute holds nothing on an hourly cron");
        assert.ok(DOWNLOAD_HOLD_MS <= 15 * oneMinute, "long enough to delay recovery from a transient outage");
    });
});
