import fs from 'node:fs';
import path from 'node:path';
import { ostList, ostVersion } from '../../config/binaries.js';
import { downloadAndExtract } from './downloadHelper.js';
import { heldDownload } from './downloadHold.js';

const binaryDirectory = path.join(process.cwd(), 'bin');
const binaryRegex = /(^|[\\/])ost-cli(?:\.exe)?$/;
const downloadPath = `https://github.com/ajthom90/ost-cli/releases/download/v${ostVersion}/`;

const binaryName = (platform) => `ost-cli${platform === 'win32' ? '.exe' : ''}`;

export const selectBinary = ({platform = process.platform, arch = process.arch} = {}) => {
    const binary = ostList.find((entry) => entry.os === platform && entry.arch === arch);
    if (!binary)
        throw new Error(`Your platform (${platform}-${arch}) is not supported by the OpenSpeedTest CLI`);

    return binary;
};

export const fileExists = async ({platform = process.platform, outputDir = binaryDirectory} = {}) =>
    fs.existsSync(path.join(outputDir, binaryName(platform)));

export const downloadFile = async ({platform = process.platform, arch = process.arch,
    outputDir = binaryDirectory, download = downloadAndExtract} = {}) => {
    const binary = selectBinary({platform, arch});

    await download(downloadPath + binary.suffix, {
        suffix: binary.suffix,
        outputDir,
        binaryRegex,
        outputName: binaryName(platform),
        sha256: binary.sha256
    });
};

export const load = async ({exists = fileExists, download = downloadFile,
    hold = heldDownload} = {}) => {
    if (!await exists()) await hold("openspeedtest", download);
};
