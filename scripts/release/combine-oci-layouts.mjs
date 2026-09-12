import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';

const DIGEST = /^sha256:([a-f0-9]{64})$/;
const SINGLE_MATCH = 1;
const INDEX_MEDIA_TYPE = 'application/vnd.oci.image.index.v1+json';
const OCI_LAYOUT = '{"imageLayoutVersion":"1.0.0"}';
const INDEX_REFERENCE = 'myspeed';
const digest = (bytes) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;

const descriptorFor = async ({root, platform}) => {
    const [os, architecture] = platform.split('/');
    const index = JSON.parse(await fs.promises.readFile(path.join(root, 'index.json')));
    const matches = index.manifests?.filter((descriptor) => descriptor.platform?.os === os
        && descriptor.platform?.architecture === architecture) ?? [];
    if (matches.length !== SINGLE_MATCH) throw new Error(`Expected one OCI descriptor for ${platform}`);
    const descriptor = matches[0];
    const match = DIGEST.exec(descriptor.digest);
    if (!match) throw new Error(`Invalid OCI manifest digest for ${platform}`);
    const bytes = await fs.promises.readFile(path.join(root, 'blobs', 'sha256', match[1]));
    if (digest(bytes) !== descriptor.digest || bytes.length !== descriptor.size)
        throw new Error(`OCI manifest descriptor mismatch for ${platform}`);
    return descriptor;
};

export const combineOciLayouts = async ({sources, output}) => {
    if (!Array.isArray(sources) || sources.length < 2) throw new Error('Multiple OCI platforms are required');
    await fs.promises.mkdir(path.join(output, 'blobs', 'sha256'), {recursive: true});
    const manifests = [];
    for (const source of sources) {
        manifests.push(await descriptorFor(source));
        const sourceBlobs = path.join(source.root, 'blobs', 'sha256');
        for (const name of await fs.promises.readdir(sourceBlobs)) {
            if (!/^[a-f0-9]{64}$/.test(name)) throw new Error(`Unsafe OCI blob name: ${name}`);
            const sourcePath = path.join(sourceBlobs, name);
            const stats = await fs.promises.lstat(sourcePath);
            if (!stats.isFile() || stats.isSymbolicLink() || stats.nlink !== SINGLE_MATCH || stats.size === 0)
                throw new Error(`Unsafe OCI blob: ${name}`);
            const bytes = await fs.promises.readFile(sourcePath);
            if (digest(bytes) !== `sha256:${name}`) throw new Error(`OCI blob digest mismatch: ${name}`);
            const target = path.join(output, 'blobs', 'sha256', name);
            try {
                const existing = await fs.promises.readFile(target);
                if (!existing.equals(bytes)) throw new Error(`Conflicting OCI blob: ${name}`);
            } catch (error) {
                if (error.code !== 'ENOENT') throw error;
                await fs.promises.writeFile(target, bytes, {flag: 'wx'});
            }
        }
    }
    manifests.sort((left, right) => left.platform.architecture.localeCompare(right.platform.architecture));
    const imageIndexBytes = Buffer.from(JSON.stringify({schemaVersion: 2,
        mediaType: INDEX_MEDIA_TYPE, manifests}));
    const indexDigest = digest(imageIndexBytes);
    await fs.promises.writeFile(path.join(output, 'blobs', 'sha256', indexDigest.slice('sha256:'.length)),
        imageIndexBytes, {flag: 'wx'});
    const layoutIndex = {schemaVersion: 2, manifests: [{mediaType: INDEX_MEDIA_TYPE,
        digest: indexDigest, size: imageIndexBytes.length,
        annotations: {'org.opencontainers.image.ref.name': INDEX_REFERENCE}}]};
    await fs.promises.writeFile(path.join(output, 'index.json'), JSON.stringify(layoutIndex), {flag: 'wx'});
    await fs.promises.writeFile(path.join(output, 'oci-layout'), OCI_LAYOUT, {flag: 'wx'});
    return {indexDigest, reference: INDEX_REFERENCE, platforms: manifests.map(({platform}) =>
        `${platform.os}/${platform.architecture}`)};
};

const parse = (tokens) => {
    const values = {};
    for (let index = 0; index < tokens.length; index += 2) {
        if (!tokens[index]?.startsWith('--') || tokens[index + 1] === undefined)
            throw new Error(`Invalid argument: ${tokens[index] ?? ''}`);
        values[tokens[index].slice(2)] = tokens[index + 1];
    }
    return values;
};

const runCli = async () => {
    const args = parse(process.argv.slice(2));
    const result = await combineOciLayouts({output: args.output, sources: [
        {root: args.amd64, platform: 'linux/amd64'}, {root: args.arm64, platform: 'linux/arm64'}
    ]});
    if (!/^[a-f0-9]{40}$/.test(process.env.SOURCE_SHA) || !/^\d+\.\d+\.\d+$/.test(process.env.VERSION))
        throw new Error('Invalid combined OCI source identity');
    const provenance = {...result, sourceSha: process.env.SOURCE_SHA, version: process.env.VERSION};
    await fs.promises.writeFile(args.provenance, `${JSON.stringify(provenance, null, 2)}\n`, {flag: 'wx'});
};

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
    runCli().catch((error) => {
        console.error(error.message);
        process.exitCode = 1;
    });
