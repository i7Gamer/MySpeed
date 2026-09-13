import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {inspectDockerRuntimeEvidence} from './docker-runtime-evidence.mjs';
import {assertOciDescriptor, inspectPlatformImage, OCI_JSON_LIMIT_BYTES}
    from './oci-platform-inspection.mjs';

const DIGEST = /^sha256:([a-f0-9]{64})$/;
const SOURCE_SHA = /^[a-f0-9]{40}$/;
const VERSION = /^\d+\.\d+\.\d+$/;
const SINGLE_LINK = 1;

const digest = (bytes) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;

const hashFile = (file) => new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = fs.createReadStream(file);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.once('error', reject);
    stream.once('end', () => resolve(`sha256:${hash.digest('hex')}`));
});

const readBlob = async (root, descriptor, label, retain) => {
    assertOciDescriptor(descriptor, label);
    const match = DIGEST.exec(descriptor.digest);
    const blobPath = path.join(root, 'blobs', 'sha256', match[1]);
    const stats = await fs.promises.lstat(blobPath);
    if (!stats.isFile() || stats.isSymbolicLink() || stats.nlink !== SINGLE_LINK || stats.size === 0)
        throw new Error(`${label} digest is not an ordinary non-empty blob: ${descriptor.digest}`);
    if (stats.size !== descriptor.size) throw new Error(`${label} descriptor size mismatch`);
    if (retain && stats.size > OCI_JSON_LIMIT_BYTES)
        throw new Error(`${label} exceeds the JSON size limit`);
    const bytes = retain ? await fs.promises.readFile(blobPath) : null;
    const actual = bytes ? digest(bytes) : await hashFile(blobPath);
    if (actual !== descriptor.digest) throw new Error(`OCI blob digest mismatch: ${descriptor.digest}`);
    return {bytes, digest: actual, size: stats.size};
};

const readIndex = async (root) => {
    const indexPath = path.join(root, 'index.json');
    const stats = await fs.promises.lstat(indexPath);
    if (!stats.isFile() || stats.isSymbolicLink() || stats.nlink !== SINGLE_LINK || stats.size === 0
        || stats.size > OCI_JSON_LIMIT_BYTES)
        throw new Error('OCI layout index is not an ordinary bounded non-empty file');
    const bytes = await fs.promises.readFile(indexPath);
    return {bytes, digest: digest(bytes), size: stats.size};
};

export const inspectOciLayoutPlatform = async ({root, platform}) => {
    const [os, architecture] = platform.split('/');
    if (!os || !architecture || platform !== `${os}/${architecture}`)
        throw new Error(`Invalid OCI platform: ${platform}`);

    const indexEntry = await readIndex(root);
    const inspected = await inspectPlatformImage({indexEntry, platform,
        loadDescriptor: (descriptor, label, retain) => readBlob(root, descriptor, label, retain)});

    return {...inspected, indexDigest: indexEntry.digest};
};

export const inspectOciLayout = async ({root, platform, sourceSha, version}) => {
    if (!SOURCE_SHA.test(sourceSha)) throw new Error(`Invalid OCI source SHA: ${sourceSha}`);
    if (!VERSION.test(version)) throw new Error(`Invalid OCI source version: ${version}`);
    const inspected = await inspectOciLayoutPlatform({root, platform});
    return {sourceSha, version, platform, verification: 'success', indexDigest: inspected.indexDigest,
        manifestDigest: inspected.manifestDigest, configDigest: inspected.configDigest,
        layerDigests: inspected.layerDigests};
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
