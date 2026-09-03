/**
 * A few minutes' memory of a CLI download that cannot succeed.
 *
 * Every loader is `if (!await fileExists()) await downloadFile()`, and
 * ensureBinary calls it before every single test. Nothing remembered a failed
 * attempt, so a failure that is *permanent* rather than transient paid for the
 * whole archive again on every tick. Two reach it in practice: Ookla
 * re-publishing a release, where the trust-on-first-use digest in
 * config/binaries.js rejects the file only after it has been fetched in full,
 * and FreeBSD x64, whose Ookla asset is a .pkg - tar+xz, where only targz and
 * unzip are registered, a case extractBinary's own docstring names. On the
 * minutely cron the install script hands out, that is a full archive a minute
 * for as long as nobody looks.
 *
 * The hold is deliberately short, and that is the whole design. ensureBinary
 * exists for the transient case - github.com blipping, a router that came up
 * after the server - so a long hold would delay recovery from exactly what it
 * was written for. A few minutes costs a transient failure one extra tick and
 * costs a permanent one everything it was spending.
 *
 * Its own state rather than rateLimitBackoff's, though the shape is that
 * module's. Its `holds` map is read by heldByBackoff, roundFullyHeld and
 * nextAttemptMinutes, so a checksum failure written into it would have the
 * round announce that the provider "refused the last test for too many
 * requests" - a sentence about a download that failed a hash - on a hold of
 * fifteen minutes to two hours where minutes are wanted.
 *
 * The existence check stays ahead of this in each loader, so an operator who
 * drops the binary into bin/ by hand is picked up on the next tick rather than
 * waiting the hold out.
 */

const MS_PER_SECOND = 1000;
const SECONDS_PER_MINUTE = 60;

/** How long a failed download is not retried for. */
export const DOWNLOAD_HOLD_MS = 5 * SECONDS_PER_MINUTE * MS_PER_SECOND;

/** provider id -> {message, until}. Process-lifetime, like the backoff's. */
const holds = new Map();

/** Drops every hold. For the suite, and for a caller that knows better. */
export const forgetDownloadHolds = () => holds.clear();

/**
 * How much longer this provider's download is held, or 0 when it is not.
 *
 * Exported for a caller that wants to say so rather than for the gate below,
 * which reads the map directly.
 */
export const downloadHoldRemaining = (provider, now = Date.now()) => {
    const held = holds.get(provider);

    return held && held.until > now ? held.until - now : 0;
};

/**
 * Runs the download unless the last one failed a moment ago.
 *
 * A held attempt is refused with the message the *first* one failed on, not
 * with one about being held: what the operator needs to read on the row is the
 * digest mismatch, or "the archive may be in a format this build cannot
 * unpack". A row saying only that the download is held would point at a log
 * line that has already scrolled away, which is the fault missingBinaryMessage
 * was written to avoid.
 *
 * The failed row per tick stays either way, and that is honest: the instance
 * genuinely cannot test. What goes is the bandwidth.
 *
 * @param provider the registry id the loader belongs to
 * @param download the loader's own downloadFile
 * @param now injected for the suite; a clock, not an instant
 */
export const heldDownload = async (provider, download, {now = Date.now} = {}) => {
    const held = holds.get(provider);
    if (held && held.until > now()) throw new Error(held.message);

    try {
        const result = await download();

        // A download that worked says the hold was wrong, whatever put it there.
        holds.delete(provider);
        return result;
    } catch (error) {
        holds.set(provider, {message: error?.message ?? String(error), until: now() + DOWNLOAD_HOLD_MS});
        throw error;
    }
};
