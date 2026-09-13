import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';

const MEBIBYTE = 1024 * 1024;
const SINGLE_LINK = 1;
const CONTAINER_ID = /^[a-f0-9]{64}$/;
const CONFIG_DIGEST = /^sha256:[a-f0-9]{64}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const SHA256_SIDECAR_LIMIT_BYTES = 65;
const SIDECAR_MODES = new Set(['create', 'require']);

export const DOCKER_INSPECT_LIMIT_BYTES = MEBIBYTE;

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

const checkedOrdinaryFile = async (file, label, sizeLimit) => {
    let stats;
    try {
        stats = await fs.promises.lstat(file);
    } catch (error) {
        if (error.code === 'ENOENT') throw new Error(`Missing ${label}: ${file}`);
        throw error;
    }
    if (!stats.isFile() || stats.isSymbolicLink() || stats.nlink !== SINGLE_LINK)
        throw new Error(`${label} is not an ordinary single-link file: ${file}`);
    if (stats.size === 0 || stats.size > sizeLimit)
        throw new Error(`${label} is empty or exceeds its size limit: ${file}`);
    return fs.promises.readFile(file);
};

export const inspectDockerRuntimeEvidence = async ({file, expectedConfigDigest, sidecar}) => {
    if (typeof file !== 'string' || !path.isAbsolute(file))
        throw new Error('Docker container inspection path must be absolute');
    if (!CONFIG_DIGEST.test(expectedConfigDigest))
        throw new Error(`Invalid expected OCI config digest: ${expectedConfigDigest}`);
    if (!SIDECAR_MODES.has(sidecar)) throw new Error(`Invalid Docker inspection sidecar mode: ${sidecar}`);

    const bytes = await checkedOrdinaryFile(file, 'Docker container inspection', DOCKER_INSPECT_LIMIT_BYTES);
    let inspection;
    try {
        inspection = JSON.parse(bytes.toString('utf8'));
    } catch {
        throw new Error('Invalid Docker container inspection JSON');
    }
    if (!Array.isArray(inspection) || inspection.length !== SINGLE_LINK
        || !inspection[0] || typeof inspection[0] !== 'object' || Array.isArray(inspection[0]))
        throw new Error('Docker container inspection must contain exactly one record');

    const [{Id: containerId, Image: image}] = inspection;
    if (!CONTAINER_ID.test(containerId)) throw new Error('Docker container inspection has an invalid container ID');
    if (image !== expectedConfigDigest)
        throw new Error(`Docker runtime image does not match OCI config digest: ${image}`);

    const inspectionSha256 = sha256(bytes);
    const sidecarPath = `${file}.sha256`;
    if (sidecar === 'create') {
        await fs.promises.writeFile(sidecarPath, `${inspectionSha256}\n`, {flag: 'wx'});
    } else {
        const sidecarBytes = await checkedOrdinaryFile(sidecarPath, 'Docker inspection sha256 sidecar',
            SHA256_SIDECAR_LIMIT_BYTES);
        const expected = sidecarBytes.toString('utf8').trim();
        if (!SHA256.test(expected) || expected !== inspectionSha256)
            throw new Error('Docker inspection sha256 digest mismatch');
    }

    return {containerId, image, inspectionPath: path.basename(file), inspectionSha256,
        inspectionSize: bytes.length};
};
