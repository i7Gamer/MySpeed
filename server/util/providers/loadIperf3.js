import fs from 'node:fs';
import path from 'node:path';
import { iperfVersion, iperfList } from '../../config/binaries.js';
import { downloadAndExtract, downloadBinary, extractFiles } from './downloadHelper.js';
import { heldDownload } from './downloadHold.js';

/**
 * What the executable is called on a platform - the `.exe` only where Windows
 * wants one.
 *
 * A function rather than the inline ternary it was, so installFiles below can
 * answer for a platform other than the one running, and be tested without the
 * suite having to pretend it is on Windows.
 */
const executableName = (platform) => `iperf3${platform === 'win32' ? '.exe' : ''}`;

const binaryName = executableName(process.platform);
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

// The file the pattern above matches beside the executable, named on its own
// because two separate questions are asked about it - what to take out of the
// archive, and whether it is still there afterwards - and they have to mean the
// same file.
const CYGWIN_RUNTIME = 'cygwin1.dll';

/**
 * Every file this platform's iperf3 install is made of.
 *
 * The Windows build is a Cygwin one, so the install is two files - and this
 * asked about one. A bin/ holding iperf3.exe that had lost cygwin1.dll - a
 * Defender or third-party AV quarantine of that DLL is a routine event, and a
 * hand-pruned bin/ does the same - answered "installed", so load() never
 * fetched it back. The spawn then *succeeds*: Windows creates the process, the
 * image loader cannot resolve the DLL, and the child dies before main with both
 * pipes empty - a 'close', not an 'error', so missingBinaryMessage, which only
 * answers for ENOENT, never sees it. The self-healing ensureBinary exists for
 * could not fire, and every scheduled run failed for the life of the install
 * behind an exit code naming neither the missing file nor the download.
 *
 * Derived from the published build rather than from process.platform, and that
 * is the distinction that matters: the DLL belongs to the *archive*, not to
 * Windows. iperfList has exactly one win32 row, x64. On win32-arm64 or
 * win32-ia32 selectBinary throws, and the message it throws tells the operator
 * to install iperf3 into bin/ themselves. Requiring cygwin1.dll there would
 * make fileExists permanently false for precisely the operator who took that
 * advice: load() would call downloadFile(), selectBinary would throw again, and
 * ensureBinary would report a binary that is not there and could not be
 * downloaded on every single run - breaking the workaround this file itself
 * recommends. So a platform with no published build is one file: whatever sits
 * in bin/ was put there by hand, and nothing here can know what it is made of.
 *
 * selectBinary is declared below and only reached when this is called, which is
 * long after the module has finished evaluating.
 */
export const installFiles = ({platform = process.platform, arch = process.arch} = {}) => {
    const executable = executableName(platform);

    try {
        return selectBinary({platform, arch}).archive ? [executable, CYGWIN_RUNTIME] : [executable];
    } catch {
        return [executable];
    }
};

/**
 * The files of that install that are not on disk, by name.
 *
 * Names rather than paths, so the caller that refuses a partial unpack can say
 * which file it wanted. The platform, the architecture and the directory are
 * injectable for the reason selectBinary's are: the case worth pinning is the
 * Windows one, and the suite has to be able to ask about it from Linux.
 */
export const missingFiles = ({platform = process.platform, arch = process.arch,
    directory = binaryDirectory} = {}) =>
    installFiles({platform, arch}).filter((name) => !fs.existsSync(path.join(directory, name)));

// The same question as a yes or a no, which is all load() wants of it. It takes
// the injectable trio through so the answer itself is testable, and not merely
// the list it is derived from.
export const fileExists = async (where) => missingFiles(where).length === 0;

/**
 * Why an unpacked archive is not an install yet, or null when it is one.
 *
 * extractFiles throws only when *nothing* matched, so an archive whose layout
 * moves on a version bump can yield iperf3.exe alone and still be reported as a
 * successful install. fileExists then disagrees on the next run and downloads
 * the whole archive again - some sixteen megabytes per scheduled test, forever,
 * with every one of those tests failing anyway. Naming the file that did not
 * arrive gives ensureBinary something to store on the failed row instead of an
 * exit code.
 */
export const partialInstallError = (missing, asset) => missing.length === 0 ? null
    : `The iperf3 archive ${asset} unpacked without ${missing.join(' and ')} - `
        + 'the published layout may have changed';

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
    if (binary.archive) {
        await downloadAndExtract(url, {
            suffix: '.zip', outputDir: binaryDirectory, binaryRegex: WINDOWS_MEMBERS,
            // Each member keeps its own name - see extractFiles. outputName is
            // unused on this path and stated so the call reads the same as the
            // other loaders'.
            outputName: binaryName, extract: extractFiles, sha256: binary.sha256});

        // A partial unpack is refused here rather than left to look like an
        // install - see partialInstallError.
        const problem = partialInstallError(missingFiles(), binary.suffix);

        if (problem) throw new Error(problem);

        return;
    }

    // Everywhere else the asset is the executable itself, so there is nothing
    // to unpack - see downloadBinary.
    return downloadBinary(url, {outputPath: binaryPath, sha256: binary.sha256});
};

export const load = async () => {
    // Behind the existence check, so a binary an operator dropped in by
    // hand is picked up on the next tick rather than waiting a hold out.
    if (!await fileExists()) await heldDownload("iperf3", downloadFile);
};
