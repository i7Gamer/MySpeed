import fs from 'node:fs';
import path from 'node:path';
import { iperfVersion, iperfList } from '../../config/binaries.js';
import { downloadAndExtract, downloadBinary, extractFiles } from './downloadHelper.js';

const binaryName = `iperf3${process.platform === 'win32' ? '.exe' : ''}`;
const binaryDirectory = path.join(process.cwd(), 'bin');
const binaryPath = path.join(binaryDirectory, binaryName);
const downloadBaseURL = `https://github.com/userdocs/iperf3-static/releases/download/${iperfVersion}/`;

/**
 * The Windows build is a Cygwin one: iperf3.exe will not start without the
 * cygwin1.dll published beside it, so both come out of the archive under their
 * own names. Anchored so a member merely mentioning either name in a directory
 * component is not taken for the file itself.
 */
const WINDOWS_MEMBERS = /(^|[\\/])(iperf3\.exe|cygwin1\.dll)$/;

export const fileExists = async () => fs.existsSync(binaryPath);

/**
 * The published build for this platform, or an error saying why there is none.
 *
 * No musl branch, unlike cfspeedtest: these are static builds that carry their
 * own libc, so one Linux download serves both.
 */
export const selectBinary = ({platform = process.platform, arch = process.arch} = {}) => {
    const binary = iperfList.find(b => b.os === platform && b.arch === arch);

    if (!binary)
        throw new Error(`Your platform (${platform}-${arch}) is not supported by the iperf3 builds `
            + 'MySpeed downloads. Install iperf3 yourself and put it in bin/ to use this provider here');

    return binary;
};

export const downloadFile = async () => {
    const binary = selectBinary();
    const url = downloadBaseURL + binary.suffix;

    // The digest config/binaries.js pins for this exact asset. Both paths
    // refuse a download without one, so a new platform entry cannot arrive
    // unverified by being forgotten here.
    if (binary.archive)
        return downloadAndExtract(url, {
            suffix: '.zip', outputDir: binaryDirectory, binaryRegex: WINDOWS_MEMBERS,
            // Each member keeps its own name - see extractFiles. outputName is
            // unused on this path and stated so the call reads the same as the
            // other loaders'.
            outputName: binaryName, extract: extractFiles, sha256: binary.sha256});

    // Everywhere else the asset is the executable itself, so there is nothing
    // to unpack - see downloadBinary.
    return downloadBinary(url, {outputPath: binaryPath, sha256: binary.sha256});
};

export const load = async () => {
    if (!await fileExists()) await downloadFile();
};
