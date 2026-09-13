import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const COMMIT_SHA = /^[a-f0-9]{40}$/;
const RELEASE_VERSION = /^(\d+)\.(\d+)\.(\d+)$/;
const WINDOWS_STAMP = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/;
const MSI_VERSION_LIMITS = [255, 255, 65_535];
const WINDOWS_BUILD_LIMIT = 65_535;

const assertVersion = (version) => {
    const match = RELEASE_VERSION.exec(version);
    if (!match) throw new Error(`Invalid qualification version: ${version}`);
    match.slice(1).map(Number).forEach((part, index) => {
        if (part > MSI_VERSION_LIMITS[index])
            throw new Error(`Qualification version exceeds MSI bounds: ${version}`);
    });
};

export const validateQualificationInputs = async ({root, expectedSha, actualSha, version,
    windowsStamp}) => {
    if (!COMMIT_SHA.test(expectedSha) || actualSha !== expectedSha)
        throw new Error(`Checked-out commit does not match qualification SHA: ${actualSha}`);
    assertVersion(version);
    const stampMatch = WINDOWS_STAMP.exec(windowsStamp);
    if (!stampMatch || stampMatch.slice(1, 4).join('.') !== version
        || Number(stampMatch[4]) > WINDOWS_BUILD_LIMIT)
        throw new Error(`Invalid Windows stamp for qualification version ${version}: ${windowsStamp}`);

    for (const relative of ['package.json', path.join('client', 'package.json')]) {
        const packagePath = path.join(root, relative);
        const packageVersion = JSON.parse(await fs.promises.readFile(packagePath, 'utf8')).version;
        if (packageVersion !== version)
            throw new Error(`${relative} version ${packageVersion} does not match qualification version ${version}`);
    }
};

const runCli = async () => {
    const root = process.cwd();
    const actualSha = execFileSync('git', ['rev-parse', 'HEAD'], {cwd: root, encoding: 'utf8'}).trim();
    await validateQualificationInputs({
        root,
        expectedSha: process.env.SOURCE_SHA,
        actualSha,
        version: process.env.VERSION,
        windowsStamp: process.env.WINDOWS_STAMP
    });
};

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
    runCli().catch((error) => {
        console.error(error.message);
        process.exitCode = 1;
    });
