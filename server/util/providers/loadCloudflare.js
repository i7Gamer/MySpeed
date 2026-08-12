import fs from 'node:fs';
import path from 'node:path';
import { cloudflareVersion, cloudflareList } from '../../config/binaries.js';
import { downloadAndExtract } from './downloadHelper.js';

const binaryName = `cfspeedtest${process.platform === 'win32' ? '.exe' : ''}`;
const binaryRegex = /cfspeedtest(.exe)?$/;
const binaryDirectory = path.join(process.cwd(), 'bin');
const binaryPath = path.join(binaryDirectory, binaryName);
const downloadBaseURL = `https://github.com/code-inflation/cfspeedtest/releases/download/v${cloudflareVersion}/`;

export const fileExists = async () => fs.existsSync(binaryPath);

export const downloadFile = async () => {
    let binary = cloudflareList.find(b => b.os === process.platform && b.arch === process.arch);

    if (!binary && process.platform === 'darwin')
        binary = cloudflareList.find(b => b.os === 'darwin' && b.arch === 'universal');

    if (!binary)
        throw new Error(`Your platform (${process.platform}-${process.arch}) is not supported by the Cloudflare CLI`);

    await downloadAndExtract(downloadBaseURL + binary.suffix,
        {suffix: binary.suffix, outputDir: binaryDirectory, binaryRegex, outputName: binaryName});
};

export const load = async () => {
    if (!await fileExists()) await downloadFile();
};
