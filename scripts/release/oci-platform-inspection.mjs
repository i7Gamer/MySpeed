const SHA256_DIGEST = /^sha256:[a-f0-9]{64}$/;
const MEBIBYTE = 1024 * 1024;
export const OCI_JSON_LIMIT_BYTES = 10 * MEBIBYTE;
const MAX_INDEX_DESCRIPTORS = 16;
const MAX_IMAGE_LAYERS = 64;
const MAX_ATTESTATION_LAYERS = 16;
const SINGLE_DESCRIPTOR = 1;
const INDEX_MEDIA_TYPE = 'application/vnd.oci.image.index.v1+json';
const MANIFEST_MEDIA_TYPE = 'application/vnd.oci.image.manifest.v1+json';
const EMPTY_CONFIG_MEDIA_TYPE = 'application/vnd.oci.empty.v1+json';
const ATTESTATION_ARTIFACT_TYPE = 'application/vnd.docker.attestation.manifest.v1+json';
const IN_TOTO_MEDIA_TYPE = 'application/vnd.in-toto+json';
const ATTESTATION_REFERENCE = 'vnd.docker.reference.digest';
const ATTESTATION_TYPE = 'vnd.docker.reference.type';
const ATTESTATION_TYPE_VALUE = 'attestation-manifest';
const EMPTY_CONFIG_DATA = 'e30=';
const EMPTY_CONFIG_BYTES = Buffer.from('{}');

const parseJson = (entry, label) => {
    if (!entry?.bytes || entry.size > OCI_JSON_LIMIT_BYTES)
        throw new Error(`${label} is missing or exceeds the JSON size limit`);
    try {
        return JSON.parse(entry.bytes.toString('utf8'));
    } catch {
        throw new Error(`Invalid ${label} JSON`);
    }
};

const assertDescriptor = (descriptor, label) => {
    if (!descriptor || !SHA256_DIGEST.test(descriptor.digest))
        throw new Error(`Invalid ${label} digest: ${descriptor?.digest}`);
    if (!Number.isSafeInteger(descriptor.size) || descriptor.size <= 0)
        throw new Error(`Invalid ${label} descriptor size`);
};

const descriptors = (index, label) => {
    if (index?.schemaVersion !== 2
        || (index.mediaType !== undefined && index.mediaType !== INDEX_MEDIA_TYPE)
        || !Array.isArray(index.manifests)
        || index.manifests.length === 0 || index.manifests.length > MAX_INDEX_DESCRIPTORS)
        throw new Error(`Invalid or excessive ${label} descriptors`);
    if (new Set(index.manifests.map(({digest}) => digest)).size !== index.manifests.length)
        throw new Error(`Duplicate ${label} descriptor digest`);
    return index.manifests;
};

const sameSubject = (subject, runnable) => subject?.mediaType === runnable.mediaType
    && subject.digest === runnable.digest && subject.size === runnable.size;

const validateAttestation = async ({descriptor, runnable, loadDescriptor}) => {
    if (descriptor.mediaType !== MANIFEST_MEDIA_TYPE
        || descriptor.platform?.os !== 'unknown' || descriptor.platform?.architecture !== 'unknown')
        throw new Error('Unexpected non-runnable OCI descriptor');
    const annotations = descriptor.annotations;
    if (annotations?.[ATTESTATION_TYPE] !== ATTESTATION_TYPE_VALUE
        || annotations?.[ATTESTATION_REFERENCE] !== runnable.digest)
        throw new Error('OCI attestation reference does not match the runnable manifest');

    const entry = await loadDescriptor(descriptor, 'OCI attestation manifest', true);
    const manifest = parseJson(entry, 'OCI attestation manifest');
    if (manifest.schemaVersion !== 2 || manifest.mediaType !== MANIFEST_MEDIA_TYPE
        || manifest.artifactType !== ATTESTATION_ARTIFACT_TYPE
        || !sameSubject(manifest.subject, runnable))
        throw new Error('OCI attestation subject does not match the runnable manifest');
    if (manifest.config?.mediaType !== EMPTY_CONFIG_MEDIA_TYPE
        || manifest.config.data !== EMPTY_CONFIG_DATA)
        throw new Error('OCI attestation config is not the required empty OCI config');
    const config = await loadDescriptor(manifest.config, 'OCI attestation config', true);
    if (!config.bytes.equals(EMPTY_CONFIG_BYTES))
        throw new Error('OCI attestation config blob is not empty JSON');
    if (!Array.isArray(manifest.layers) || manifest.layers.length === 0
        || manifest.layers.length > MAX_ATTESTATION_LAYERS)
        throw new Error('OCI attestation must contain a bounded in-toto layer set');
    for (const layer of manifest.layers) {
        if (layer.mediaType !== IN_TOTO_MEDIA_TYPE)
            throw new Error('OCI attestation contains a non-in-toto layer');
        await loadDescriptor(layer, 'OCI attestation layer', false);
    }
};

export const inspectPlatformImage = async ({indexEntry, platform, loadDescriptor}) => {
    const [os, architecture] = platform.split('/');
    const rootIndex = parseJson(indexEntry, 'OCI layout index');
    const rootDescriptors = descriptors(rootIndex, 'OCI layout index');
    const rootMatches = rootDescriptors.filter((item) => item.platform?.os === os
        && item.platform?.architecture === architecture);

    let imageDescriptors = rootDescriptors;
    if (rootMatches.length === 0) {
        const nested = rootDescriptors.filter((item) => item.mediaType === INDEX_MEDIA_TYPE);
        if (rootDescriptors.length !== SINGLE_DESCRIPTOR || nested.length !== SINGLE_DESCRIPTOR)
            throw new Error(`OCI index must contain exactly one ${platform} platform descriptor`);
        const nestedEntry = await loadDescriptor(nested[0], 'OCI image index', true);
        imageDescriptors = descriptors(parseJson(nestedEntry, 'OCI image index'), 'OCI image index');
        if (imageDescriptors.some((item) => item.mediaType === INDEX_MEDIA_TYPE))
            throw new Error('OCI image index nesting exceeds one wrapper level');
    } else if (rootDescriptors.some((item) => item.mediaType === INDEX_MEDIA_TYPE)) {
        throw new Error('OCI index ambiguously contains direct and nested image descriptors');
    }

    const matches = imageDescriptors.filter((item) => item.platform?.os === os
        && item.platform?.architecture === architecture);
    if (matches.length !== SINGLE_DESCRIPTOR || matches[0].mediaType !== MANIFEST_MEDIA_TYPE)
        throw new Error(`OCI index must contain exactly one ${platform} platform manifest`);
    const descriptor = matches[0];
    assertDescriptor(descriptor, 'OCI manifest');

    const attestationDescriptors = [];
    for (const item of imageDescriptors) {
        if (item === descriptor) continue;
        assertDescriptor(item, 'OCI non-runnable manifest');
        await validateAttestation({descriptor: item, runnable: descriptor, loadDescriptor});
        attestationDescriptors.push(item);
    }

    const manifestEntry = await loadDescriptor(descriptor, 'OCI manifest', true);
    const manifest = parseJson(manifestEntry, 'OCI manifest');
    if (manifest.schemaVersion !== 2
        || (manifest.mediaType !== undefined && manifest.mediaType !== MANIFEST_MEDIA_TYPE))
        throw new Error('Invalid OCI image manifest');
    const configEntry = await loadDescriptor(manifest.config, 'OCI config', true);
    const config = parseJson(configEntry, 'OCI config');
    if (config.os !== os || config.architecture !== architecture)
        throw new Error(`OCI config platform does not match ${platform}`);
    if (!Array.isArray(manifest.layers) || manifest.layers.length === 0
        || manifest.layers.length > MAX_IMAGE_LAYERS)
        throw new Error('OCI manifest has no bounded layer set');
    for (const layer of manifest.layers) await loadDescriptor(layer, 'OCI layer', false);

    return {descriptor, attestationDescriptors, manifestDigest: descriptor.digest,
        configDigest: manifest.config.digest, layerDigests: manifest.layers.map(({digest}) => digest)};
};

export const assertOciDescriptor = assertDescriptor;
