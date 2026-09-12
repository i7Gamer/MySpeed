import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {inspectDockerRuntimeEvidence} from './docker-runtime-evidence.mjs';

const DIGEST = /^sha256:([a-f0-9]{64})$/;
const SOURCE_SHA = /^[a-f0-9]{40}$/;
const VERSION = /^\d+\.\d+\.\d+$/;
const SINGLE_LINK = 1;

const digest = (bytes) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;

const readBlob = async (root, expected) => {
    const match = DIGEST.exec(expected);
    if (!match) throw new Error(`Invalid OCI digest: ${expected}`);
    const blobPath = path.join(root, 'blobs', 'sha256', match[1]);
    const stats = await fs.promises.lstat(blobPath);
    if (!stats.isFile() || stats.isSymbolicLink() || stats.nlink !== SINGLE_LINK || stats.size === 0)
        throw new Error(`OCI digest is not an ordinary non-empty blob: ${expected}`);
    const bytes = await fs.promises.readFile(blobPath);
    if (digest(bytes) !== expected) throw new Error(`OCI blob digest mismatch: ${expected}`);
    return bytes;
};

export const inspectOciLayout = async ({root, platform, sourceSha, version}) => {
    if (!SOURCE_SHA.test(sourceSha)) throw new Error(`Invalid OCI source SHA: ${sourceSha}`);
    if (!VERSION.test(version)) throw new Error(`Invalid OCI source version: ${version}`);
    const [os, architecture] = platform.split('/');
    if (!os || !architecture || platform !== `${os}/${architecture}`)
        throw new Error(`Invalid OCI platform: ${platform}`);

    const indexBytes = await fs.promises.readFile(path.join(root, 'index.json'));
    const index = JSON.parse(indexBytes);
    const candidates = index.manifests?.filter((item) => item.platform?.os === os
        && item.platform?.architecture === architecture) ?? [];
    if (candidates.length !== SINGLE_LINK)
        throw new Error(`OCI index must contain exactly one ${platform} platform manifest`);
    const manifestDigest = candidates[0].digest;
    const manifest = JSON.parse(await readBlob(root, manifestDigest));
    const configDigest = manifest.config?.digest;
    await readBlob(root, configDigest);
    if (!Array.isArray(manifest.layers) || manifest.layers.length === 0)
        throw new Error('OCI manifest has no layers');
    const layerDigests = manifest.layers.map((layer) => layer.digest);
    for (const layerDigest of layerDigests) await readBlob(root, layerDigest);

    return {sourceSha, version, platform, verification: 'success', indexDigest: digest(indexBytes),
        manifestDigest, configDigest, layerDigests};
};

const argumentsMap = (tokens) => {
    const result = {};
    for (let index = 0; index < tokens.length; index += 2) {
        if (!tokens[index]?.startsWith('--') || tokens[index + 1] === undefined)
            throw new Error(`Invalid argument: ${tokens[index] ?? ''}`);
        result[tokens[index].slice(2)] = tokens[index + 1];
    }
    return result;
};

const runCli = async () => {
    const args = argumentsMap(process.argv.slice(2));
    const result = await inspectOciLayout({root: args.root, platform: args.platform,
        sourceSha: process.env.SOURCE_SHA, version: process.env.VERSION});
    const runtimeDocker = await inspectDockerRuntimeEvidence({file: args['container-inspect'],
        expectedConfigDigest: result.configDigest, sidecar: 'create'});
    await fs.promises.writeFile(args.output, `${JSON.stringify({...result, runtimeDocker}, null, 2)}\n`, {flag: 'wx'});
};

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
    runCli().catch((error) => {
        console.error(error.message);
        process.exitCode = 1;
    });
