import fs from 'node:fs';
import path from 'node:path';
import { libreVersion, libreList } from '../../config/binaries.js';
import { downloadAndExtract } from './downloadHelper.js';
import { heldDownload } from './downloadHold.js';

const binaryName = `librespeed-cli${process.platform === 'win32' ? '.exe' : ''}`;
const binaryRegex = /librespeed-cli(.exe)?$/;
const binaryDirectory = path.join(process.cwd(), 'bin');
const binaryPath = path.join(binaryDirectory, binaryName);

const downloadPath = `https://github.com/librespeed/speedtest-cli/releases/download/v${libreVersion}/librespeed-cli_${libreVersion}_`;

export const fileExists = async () => fs.existsSync(binaryPath);

export const downloadFile = async () => {
    const binary = libreList.find(b => b.os === process.platform && b.arch === process.arch);
    if (!binary)
        throw new Error(`Your platform (${process.platform}-${process.arch}) is not supported by the LibreSpeed CLI`);

    await downloadAndExtract(downloadPath + binary.suffix,
        {suffix: binary.suffix, outputDir: binaryDirectory, binaryRegex, outputName: binaryName,
            // The digest config/binaries.js pins for this exact archive.
            // downloadHelper refuses the download without one, so a new
            // platform entry cannot arrive unverified by being forgotten here.
            sha256: binary.sha256});
};

export const load = async () => {
    // Behind the existence check, so a binary an operator dropped in by
    // hand is picked up on the next tick rather than waiting a hold out.
    if (!await fileExists()) await heldDownload("libre", downloadFile);
};
