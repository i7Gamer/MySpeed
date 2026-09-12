import fs from 'node:fs';
import {createHash} from 'node:crypto';
import {pipeline} from 'node:stream/promises';
import tarStream from 'tar-stream';
import {assertOciDescriptor, inspectPlatformImage, OCI_JSON_LIMIT_BYTES}
    from './oci-platform-inspection.mjs';

const SHA256_DIGEST = /^sha256:([a-f0-9]{64})$/;
const BLOB_PATH = /^blobs\/sha256\/([a-f0-9]{64})$/;
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
                if (retain && size <= OCI_JSON_LIMIT_BYTES) chunks.push(chunk);
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

const descriptorEntry = (entries, descriptor, label, retain) => {
    assertOciDescriptor(descriptor, label);
    const entry = blobEntry(entries, descriptor.digest, label);
    if (descriptor.size !== entry.size) throw new Error(`${label} descriptor size mismatch`);
    if (retain && !entry.bytes) throw new Error(`${label} exceeds the JSON size limit`);
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
    const inspected = await inspectPlatformImage({indexEntry, platform,
        loadDescriptor: (descriptor, label, retain) =>
            descriptorEntry(entries, descriptor, label, retain)});
    return {sourceSha, version, platform, verification: 'success',
        indexDigest: indexEntry.digest, descriptor: inspected.descriptor,
        attestationDescriptors: inspected.attestationDescriptors,
        manifestDigest: inspected.manifestDigest, configDigest: inspected.configDigest,
        layerDigests: inspected.layerDigests};
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
    if (root.schemaVersion !== 2
        || (root.mediaType !== undefined && root.mediaType !== 'application/vnd.oci.image.index.v1+json')
        || rootDescriptor.mediaType !== 'application/vnd.oci.image.index.v1+json')
        throw new Error('Invalid combined OCI layout index');
    const indexEntry = descriptorEntry(entries, rootDescriptor, 'combined OCI image index', true);
    const index = parseJson(indexEntry, 'combined OCI image index');
    if (index.schemaVersion !== 2 || index.mediaType !== 'application/vnd.oci.image.index.v1+json')
        throw new Error('Invalid combined OCI image index');
    const groups = platforms.map(({descriptor, attestationDescriptors = []}) =>
        ({descriptor, attestationDescriptors})).sort((left, right) =>
        left.descriptor.platform.architecture.localeCompare(right.descriptor.platform.architecture));
    const expected = groups.flatMap(({descriptor, attestationDescriptors}) =>
        [descriptor, ...attestationDescriptors]);
    const actual = index.manifests ?? [];
    if (JSON.stringify(actual) !== JSON.stringify(expected))
        throw new Error('Combined OCI descriptors do not match qualified platform archives');
    for (const {descriptor, attestationDescriptors} of groups) {
        const bytes = Buffer.from(JSON.stringify({schemaVersion: 2,
            manifests: [descriptor, ...attestationDescriptors]}));
        await inspectPlatformImage({indexEntry: {bytes, digest: digest(bytes), size: bytes.length},
            platform: `${descriptor.platform.os}/${descriptor.platform.architecture}`,
            loadDescriptor: (item, label, retain) =>
                descriptorEntry(entries, item, label, retain)});
    }
    return {indexDigest: rootDescriptor.digest, reference: INDEX_REFERENCE,
        platforms: groups.map(({descriptor}) =>
            `${descriptor.platform.os}/${descriptor.platform.architecture}`)};
};
