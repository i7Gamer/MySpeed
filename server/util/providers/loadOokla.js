import fs from 'node:fs';
import path from 'node:path';
import { ooklaVersion, ooklaList } from '../../config/binaries.js';
import { downloadAndExtract } from './downloadHelper.js';

const binaryName = `speedtest${process.platform === 'win32' ? '.exe' : ''}`;
const binaryRegex = /speedtest(.exe)?$/;
const binaryDirectory = path.join(process.cwd(), 'bin');
const binaryPath = path.join(binaryDirectory, binaryName);

const downloadPath = `https://install.speedtest.net/app/cli/ookla-speedtest-${ooklaVersion}-`;

export const fileExists = async () => fs.existsSync(binaryPath);

export const downloadFile = async () => {
    const binary = ooklaList.find(b => b.os === process.platform && b.arch === process.arch);
    if (!binary)
        throw new Error(`Your platform (${process.platform}-${process.arch}) is not supported by the Speedtest CLI`);

    await downloadAndExtract(downloadPath + binary.suffix,
        {suffix: binary.suffix, outputDir: binaryDirectory, binaryRegex, outputName: binaryName});
};

export const load = async () => {
    if (!await fileExists()) await downloadFile();
};
