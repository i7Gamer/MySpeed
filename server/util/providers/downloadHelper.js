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
            res.pipe(writeStream);
            writeStream.on('finish', () => resolve());
            writeStream.on('error', reject);
            res.on('error', reject);
        }).on('error', reject);
    });

export const extractBinary = (archivePath, outputDir, binaryRegex, outputName) =>
    decompress(archivePath, outputDir, {
        plugins: [decompressTarGz(), decompressUnzip()],
        filter: file => binaryRegex.test(file.path),
        map: file => {
            file.path = outputName;
            return file;
        }
    });
