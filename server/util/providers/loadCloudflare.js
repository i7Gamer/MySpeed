import fs from 'node:fs';
import path from 'node:path';
import { cloudflareVersion, cloudflareList } from '../../config/binaries.js';
import { downloadAndExtract } from './downloadHelper.js';
import { isMuslLinux, MUSL_CLOUDFLARE_REASON } from './libc.js';

const binaryName = `cfspeedtest${process.platform === 'win32' ? '.exe' : ''}`;
const binaryRegex = /cfspeedtest(.exe)?$/;
const binaryDirectory = path.join(process.cwd(), 'bin');
const binaryPath = path.join(binaryDirectory, binaryName);
const downloadBaseURL = `https://github.com/code-inflation/cfspeedtest/releases/download/v${cloudflareVersion}/`;

export const fileExists = async () => fs.existsSync(binaryPath);

/**
 * The published build for this platform, or an error saying why there is none.
 *
 * Only glibc Linux builds are released, and a musl system reports itself as
 * plain linux/x64 - so fetching by platform alone lands an executable whose
 * interpreter is absent, which the kernel refuses with ENOENT. The Docker image
 * compiles the CLI against musl during its build, so a container that reaches
 * here has lost that binary rather than never having had one.
 */
export const selectBinary = ({platform = process.platform, arch = process.arch, musl = isMuslLinux()} = {}) => {
    if (platform === 'linux' && musl)
        throw new Error(`${MUSL_CLOUDFLARE_REASON}. ` +
            'The MySpeed image ships a musl build in bin/; restore it, or install cfspeedtest ' +
            `${cloudflareVersion} into bin/ yourself, to use the Cloudflare provider here`);

    const binary = cloudflareList.find(b => b.os === platform && b.arch === arch)
        ?? (platform === 'darwin' ? cloudflareList.find(b => b.os === 'darwin' && b.arch === 'universal') : undefined);

    if (!binary)
        throw new Error(`Your platform (${platform}-${arch}) is not supported by the Cloudflare CLI`);

    return binary;
};

export const downloadFile = async () => {
    const binary = selectBinary();

    await downloadAndExtract(downloadBaseURL + binary.suffix,
        {suffix: binary.suffix, outputDir: binaryDirectory, binaryRegex, outputName: binaryName,
            // The digest config/binaries.js pins for this exact archive.
            // downloadHelper refuses the download without one, so a new
            // platform entry cannot arrive unverified by being forgotten here.
            sha256: binary.sha256});
};

export const load = async () => {
    if (!await fileExists()) await downloadFile();
};
