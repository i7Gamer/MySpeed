import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { get } from 'node:https';
import { randomBytes } from 'node:crypto';
import decompress from 'decompress';
import decompressTarGz from 'decompress-targz';
import decompressUnzip from 'decompress-unzip';

export const tmpFile = (suffix = '') =>
    path.join(os.tmpdir(), randomBytes(16).toString('hex') + suffix);

/**
 * How many redirects a release download may chase. The real chains are one or
 * two hops to a CDN; without a bound, a URL that loops - or a chain long
 * enough - recursed until memory ran out instead of failing with a reason.
 */
export const MAX_DOWNLOAD_REDIRECTS = 10;

/**
 * How long the transfer may go quiet before it is abandoned.
 *
 * `get` arms no timer of its own, so a server that accepted the connection and
 * then said nothing left the promise unsettled - and with it the boot that
 * awaits the CLI install, with no error and nothing in the log naming what it
 * was waiting for. This is an *idle* timeout rather than a deadline for the
 * whole download: a large archive on a slow line keeps resetting it, and only a
 * transfer that has genuinely stopped runs it out.
 */
export const DOWNLOAD_IDLE_TIMEOUT = 60000;

// `client` is injectable so the redirect handling is testable without the
// network; callers pass nothing and get node:https.
export const downloadToFile = (url, destPath, {redirectsLeft = MAX_DOWNLOAD_REDIRECTS, client = get} = {}) =>
    new Promise((resolve, reject) => {
        const request = client(url, (res) => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                res.resume();
                if (redirectsLeft <= 0)
                    return reject(new Error(`Download failed: ${url} redirected more than ${MAX_DOWNLOAD_REDIRECTS} times`));

                // Resolved against the URL that sent it. A Location header need
                // not be absolute - RFC 9110 allows a relative reference, and a
                // CDN answering `Location: /bin/cli.tgz` reached https.get as a
                // path and died on ERR_INVALID_URL, naming neither the download
                // nor the redirect.
                let next;
                try {
                    next = new URL(res.headers.location, url);
                } catch {
                    return reject(new Error(
                        `Download failed: ${url} redirected to "${res.headers.location}", which is not a URL`));
                }

                // This fetches an executable the server then runs, so a
                // redirect onto plain HTTP is a downgrade that hands anyone on
                // the path its contents. Refused with a reason: an http:// URL
                // handed to https.get failed on ERR_INVALID_PROTOCOL instead,
                // which says nothing about a redirect having happened.
                if (next.protocol !== "https:")
                    return reject(new Error(
                        `Download failed: ${url} redirected to ${next.protocol}//, and only https is followed`));

                return resolve(downloadToFile(next.href, destPath,
                    {redirectsLeft: redirectsLeft - 1, client}));
            }
            if (res.statusCode !== 200) {
                res.resume();
                return reject(new Error(`Download failed: ${url} returned ${res.statusCode}`));
            }
            const writeStream = fs.createWriteStream(destPath);

            // A stream that errors mid-transfer used to be left open, with
            // however much of the archive had arrived still on disk - so the
            // descriptor leaked and the next attempt could find a truncated
            // file sitting where its archive goes.
            // The partial file is gone before the caller hears about the
            // failure, so a retry cannot find one where its archive goes.
            //
            // The response is destroyed too, not just the write side. When the
            // failure starts on the write side, pipe() only unpipes - the
            // response stops being read but stays checked out of the agent with
            // its socket open and its body buffered, until the peer eventually
            // times out. Settling once is enough: destroy() on an already
            // destroyed stream is a no-op, and reject after the first call is
            // ignored.
            const fail = (error) => {
                res.destroy();
                writeStream.destroy();
                fs.promises.unlink(destPath).catch(() => undefined).then(() => reject(error));
            };

            res.pipe(writeStream);
            writeStream.on('finish', () => resolve());
            writeStream.on('error', fail);
            res.on('error', fail);
        });

        request.on('error', reject);

        // Optional so the scripted clients the tests inject stay two-line
        // stubs; a real ClientRequest always has it.
        request.setTimeout?.(DOWNLOAD_IDLE_TIMEOUT, () => {
            request.destroy(new Error(
                `Download failed: ${url} sent nothing for ${DOWNLOAD_IDLE_TIMEOUT}ms`));
        });
    });

/**
 * Fetches a release archive, takes the binary out of it, and removes the
 * archive however that went.
 *
 * All three loaders did the first two steps and stopped, so every download left
 * a .tgz or .zip of some tens of megabytes in os.tmpdir() for good - under a
 * random name, so nothing would ever overwrite it either. Once per install
 * sounds harmless until ./bin is not persisted, at which point it is once per
 * container start.
 *
 * `extract` and `tmp` are injectable for the same reason `client` is: so the
 * cleanup can be tested without a real archive or the network.
 */
export const downloadAndExtract = async (url, {outputDir, binaryRegex, outputName,
    client = get, extract = extractBinary, tmp = tmpFile, suffix = ''} = {}) => {

    const archivePath = tmp(suffix);

    try {
        await downloadToFile(url, archivePath, {client});
        await extract(archivePath, outputDir, binaryRegex, outputName);
    } finally {
        await fs.promises.unlink(archivePath).catch(() => undefined);
    }
};

/**
 * Takes the binary out of a release archive, and says so when it could not.
 *
 * decompress resolves with an empty array rather than rejecting when no plugin
 * recognises the archive - both registered plugins return [] for an
 * unrecognised magic, and Promise.all([]) resolves - so an unhandled format (a
 * FreeBSD .pkg is tar+xz, and only targz and unzip are registered here), a
 * binaryRegex matching no member, and a 200 HTML error page saved as an archive
 * all looked exactly like a successful extraction. No caller checked:
 * downloadAndExtract only unlinks the archive, and both downloadFile() and
 * loadCli.load() went on to report success while ./bin/<cli> did not exist, so
 * the first run failed with a missing-file message instead of the download that
 * never worked.
 */
export const extractBinary = async (archivePath, outputDir, binaryRegex, outputName) => {
    const extracted = await decompress(archivePath, outputDir, {
        plugins: [decompressTarGz(), decompressUnzip()],
        filter: file => binaryRegex.test(file.path),
        map: file => {
            file.path = outputName;
            return file;
        }
    });

    if (extracted.length === 0)
        throw new Error(`Extraction failed: nothing matching ${binaryRegex} was found in ${archivePath}`
            + " - the archive may be in a format this build cannot unpack, or the download may not be an archive at all");

    return extracted;
};
