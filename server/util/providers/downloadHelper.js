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

// `client` is injectable so the redirect handling is testable without the
// network; callers pass nothing and get node:https.
export const downloadToFile = (url, destPath, {redirectsLeft = MAX_DOWNLOAD_REDIRECTS, client = get} = {}) =>
    new Promise((resolve, reject) => {
        client(url, (res) => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                res.resume();
                if (redirectsLeft <= 0)
                    return reject(new Error(`Download failed: ${url} redirected more than ${MAX_DOWNLOAD_REDIRECTS} times`));

                return resolve(downloadToFile(res.headers.location, destPath,
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
        }).on('error', reject);
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

export const extractBinary = (archivePath, outputDir, binaryRegex, outputName) =>
    decompress(archivePath, outputDir, {
        plugins: [decompressTarGz(), decompressUnzip()],
        filter: file => binaryRegex.test(file.path),
        map: file => {
            file.path = outputName;
            return file;
        }
    });
