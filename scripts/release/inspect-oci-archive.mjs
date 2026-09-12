import fs from 'node:fs';
import {createHash} from 'node:crypto';
import {pipeline} from 'node:stream/promises';
import tarStream from 'tar-stream';

const SHA256_DIGEST = /^sha256:([a-f0-9]{64})$/;
const BLOB_PATH = /^blobs\/sha256\/([a-f0-9]{64})$/;
const MEBIBYTE = 1024 * 1024;
const JSON_LIMIT_BYTES = 10 * MEBIBYTE;
const REQUIRED_PLATFORM_COUNT = 2;
const INDEX_REFERENCE = 'myspeed';

const digest = (bytes) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;

const normalizedName = (name) => name.startsWith('./') ? name.slice(2) : name;

const assertEntryName = (name) => {
    if (!name || name.startsWith('/') || name.includes('\\') || name.includes('\0')
        || name.split('/').some((part) => part === '..' || part === '.' || part === ''))
        throw new Error(`Unsafe OCI archive entry: ${name}`);
};

const readArchive = async (archive) => {
    const entries = new Map();
    const extraction = tarStream.extract();
    extraction.on('entry', (header, stream, next) => {
        const name = normalizedName(header.name);
        const fail = (error) => extraction.destroy(error);
        try {
            assertEntryName(header.type === 'directory' ? name.replace(/\/$/, '') : name);
            if (header.type === 'directory') {
                stream.resume();
                stream.once('end', next);
                return;
            }
            if (header.type !== 'file') throw new Error(`Unsafe OCI archive entry type: ${name}`);
            if (name !== 'index.json' && name !== 'oci-layout' && !BLOB_PATH.test(name))
                throw new Error(`Unexpected OCI archive entry: ${name}`);
            if (entries.has(name)) throw new Error(`Duplicate OCI archive entry: ${name}`);

            const hash = createHash('sha256');
            const chunks = [];
            let size = 0;
            let retain = true;
            stream.on('data', (chunk) => {
                size += chunk.length;
                hash.update(chunk);
                if (retain && size <= JSON_LIMIT_BYTES) chunks.push(chunk);
                else retain = false;
            });
            stream.once('error', fail);
            stream.once('end', () => {
                try {
                    if (size === 0 || size !== header.size)
                        throw new Error(`Invalid OCI archive entry size: ${name}`);
                    const actual = `sha256:${hash.digest('hex')}`;
                    const blob = BLOB_PATH.exec(name);
                    if (blob && actual !== `sha256:${blob[1]}`)
                        throw new Error(`OCI blob digest mismatch: ${name}`);
                    entries.set(name, {bytes: retain ? Buffer.concat(chunks) : null,
                        digest: actual, size});
                    next();
                } catch (error) {
                    fail(error);
                }
            });
        } catch (error) {
            stream.resume();
            fail(error);
        }
    });
    await pipeline(fs.createReadStream(archive), extraction);
    return entries;
};

const parseJson = (entry, label) => {
    if (!entry?.bytes) throw new Error(`${label} is missing or exceeds the JSON size limit`);
    try {
        return JSON.parse(entry.bytes.toString('utf8'));
    } catch {
        throw new Error(`Invalid ${label} JSON`);
    }
};

const blobEntry = (entries, expected, label) => {
    const match = SHA256_DIGEST.exec(expected);
    if (!match) throw new Error(`Invalid ${label} digest: ${expected}`);
    const entry = entries.get(`blobs/sha256/${match[1]}`);
    if (!entry) throw new Error(`Missing ${label} blob: ${expected}`);
    return entry;
};

export const inspectOciArchive = async ({archive, platform, sourceSha, version}) => {
    const [os, architecture] = platform.split('/');
    if (!os || !architecture || platform !== `${os}/${architecture}`)
        throw new Error(`Invalid OCI platform: ${platform}`);
    const entries = await readArchive(archive);
    const layout = parseJson(entries.get('oci-layout'), 'OCI layout metadata');
    if (layout.imageLayoutVersion !== '1.0.0') throw new Error('Unsupported OCI layout version');
    const indexEntry = entries.get('index.json');
    const index = parseJson(indexEntry, 'OCI layout index');
    const matches = index.manifests?.filter((item) => item.platform?.os === os
        && item.platform?.architecture === architecture) ?? [];
    if (matches.length !== 1) throw new Error(`OCI index must contain exactly one ${platform} descriptor`);
    const descriptor = matches[0];
    const manifestEntry = blobEntry(entries, descriptor.digest, 'OCI manifest');
    if (descriptor.size !== manifestEntry.size) throw new Error('OCI manifest descriptor size mismatch');
    const manifest = parseJson(manifestEntry, 'OCI manifest');
    const configEntry = blobEntry(entries, manifest.config?.digest, 'OCI config');
    if (manifest.config?.size !== undefined && manifest.config.size !== configEntry.size)
        throw new Error('OCI config descriptor size mismatch');
    if (!Array.isArray(manifest.layers) || manifest.layers.length === 0)
        throw new Error('OCI manifest has no layers');
    for (const layer of manifest.layers) {
        const entry = blobEntry(entries, layer.digest, 'OCI layer');
        if (layer.size !== undefined && layer.size !== entry.size)
            throw new Error('OCI layer descriptor size mismatch');
    }
    return {sourceSha, version, platform, verification: 'success',
        indexDigest: indexEntry.digest, descriptor,
        manifestDigest: descriptor.digest, configDigest: manifest.config.digest,
        layerDigests: manifest.layers.map(({digest: value}) => value)};
};

export const inspectCombinedOciArchive = async ({archive, platforms}) => {
    if (!Array.isArray(platforms) || platforms.length !== REQUIRED_PLATFORM_COUNT)
        throw new Error(`Combined OCI verification requires ${REQUIRED_PLATFORM_COUNT} platforms`);
    const entries = await readArchive(archive);
    const layout = parseJson(entries.get('oci-layout'), 'OCI layout metadata');
    if (layout.imageLayoutVersion !== '1.0.0') throw new Error('Unsupported OCI layout version');
    const root = parseJson(entries.get('index.json'), 'combined OCI layout index');
    if (!Array.isArray(root.manifests) || root.manifests.length !== 1)
        throw new Error('Combined OCI layout must contain one named image index');
    const rootDescriptor = root.manifests[0];
    if (rootDescriptor.annotations?.['org.opencontainers.image.ref.name'] !== INDEX_REFERENCE)
        throw new Error('Combined OCI image reference mismatch');
    const indexEntry = blobEntry(entries, rootDescriptor.digest, 'combined OCI image index');
    if (rootDescriptor.size !== indexEntry.size) throw new Error('Combined OCI index descriptor size mismatch');
    const index = parseJson(indexEntry, 'combined OCI image index');
    const actual = [...(index.manifests ?? [])]
        .sort((left, right) => left.platform.architecture.localeCompare(right.platform.architecture));
    const expected = platforms.map(({descriptor}) => descriptor)
        .sort((left, right) => left.platform.architecture.localeCompare(right.platform.architecture));
    if (actual.length !== REQUIRED_PLATFORM_COUNT || JSON.stringify(actual) !== JSON.stringify(expected))
        throw new Error('Combined OCI descriptors do not match qualified platform archives');
    return {indexDigest: rootDescriptor.digest, reference: INDEX_REFERENCE,
        platforms: actual.map(({platform}) => `${platform.os}/${platform.architecture}`)};
};
