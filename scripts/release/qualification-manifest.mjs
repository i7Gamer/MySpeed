import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {inspectCombinedOciArchive, inspectOciArchive} from './inspect-oci-archive.mjs';
import {inspectDockerRuntimeEvidence} from './docker-runtime-evidence.mjs';

const MANIFEST_SCHEMA_VERSION = 1;
const SHA256 = /^[a-f0-9]{64}$/;
const COMMIT_SHA = /^[a-f0-9]{40}$/;
const RELEASE_VERSION = /^(\d+)\.(\d+)\.(\d+)$/;
const WINDOWS_STAMP = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/;
const MSI_LIMITS = [255, 255, 65_535];
const WINDOWS_BUILD_LIMIT = 65_535;
const SINGLE_LINK = 1;
const MEBIBYTE = 1024 * 1024;
const GIBIBYTE = 1024 * MEBIBYTE;
const STATIC_ARCHIVE_LIMIT = 10 * MEBIBYTE;
const BUILD_ARCHIVE_LIMIT = GIBIBYTE;
const SOURCE_ARCHIVE_LIMIT = 2 * GIBIBYTE;
const OCI_ARCHIVE_LIMIT = 4 * GIBIBYTE;
const EVIDENCE_FILE_LIMIT = MEBIBYTE;
const FULL_MODE = 'full';
const RESET_MODE = 'listener-free-reset';
const REQUIRED_EVIDENCE_FIELDS = ['tests', 'binaries', 'msi', 'docker', 'dockerIndex', 'ice'];
const PROMOTION_BLOCKERS = [
    'Windows native full verification with enforced outbound denial',
    'macOS native full verification with enforced outbound denial',
    'Windows native CPU-floor verification',
    'Disposable Windows MSI lifecycle acceptance'
];

const RELEASE_FILES = [
    ['MySpeed-windows-x64.exe', 'MySpeed.exe', 'MySpeed-windows-x64.exe'],
    ['MySpeed-windows-x64-baseline.exe', 'MySpeed.exe', 'MySpeed-windows-x64-baseline.exe'],
    ['MySpeed-linux-x64', 'MySpeed-linux-x64', 'MySpeed-linux-x64'],
    ['MySpeed-linux-x64-baseline', 'MySpeed-linux-x64-baseline', 'MySpeed-linux-x64-baseline'],
    ['MySpeed-linux-arm64', 'MySpeed-linux-arm64', 'MySpeed-linux-arm64'],
    ['MySpeed-macos-x64', 'MySpeed-macos-x64', 'MySpeed-macos-x64'],
    ['MySpeed-macos-arm64', 'MySpeed-macos-arm64', 'MySpeed-macos-arm64'],
    ['MySpeed.zip', 'MySpeed.zip', 'MySpeed.zip'],
    ['release-msi-MySpeed-installer.msi', 'MySpeed-installer.msi', 'MySpeed-installer.msi'],
    ['release-msi-MySpeed-installer-baseline.msi', 'MySpeed-installer.msi', 'MySpeed-installer-baseline.msi'],
    ['release-static', 'install.sh', 'install.sh'],
    ['release-static', 'docker-install.sh', 'docker-install.sh'],
    ['release-static', 'chooser.sh', 'chooser.sh']
];

const CONTAINER_FILES = [
    ['qualified-oci-amd64', 'myspeed-amd64.oci.tar', 'linux/amd64'],
    ['qualified-oci-arm64', 'myspeed-arm64.oci.tar', 'linux/arm64']
];

const CONTAINER_INDEX_FILE = ['qualified-oci-index', 'myspeed-multiarch.oci.tar'];

const BINARY_VERIFICATIONS = [
    ['MySpeed-windows-x64.exe', 'MySpeed.exe', 'win32', 'x64', RESET_MODE],
    ['MySpeed-windows-x64-baseline.exe', 'MySpeed.exe', 'win32', 'x64', RESET_MODE],
    ['MySpeed-linux-x64', 'MySpeed-linux-x64', 'linux', 'x64', FULL_MODE],
    ['MySpeed-linux-x64-baseline', 'MySpeed-linux-x64-baseline', 'linux', 'x64', FULL_MODE],
    ['MySpeed-linux-arm64', 'MySpeed-linux-arm64', 'linux', 'arm64', FULL_MODE],
    ['MySpeed-macos-x64', 'MySpeed-macos-x64', 'darwin', 'x64', RESET_MODE],
    ['MySpeed-macos-arm64', 'MySpeed-macos-arm64', 'darwin', 'arm64', RESET_MODE]
];

const SOURCE_VERIFICATIONS = [
    ['node', 'qualification-node-summary.json'],
    ['bun', 'qualification-bun-summary.json']
];

const MSI_VERIFICATIONS = [
    ['release-msi-MySpeed-installer.msi', 'MySpeed-windows-x64.exe'],
    ['release-msi-MySpeed-installer-baseline.msi', 'MySpeed-windows-x64-baseline.exe']
];

const ALLOWED_DUPLICATES = [
    new Set(['MySpeed-linux-x64', 'MySpeed-linux-x64-baseline']),
    new Set(['MySpeed-windows-x64.exe', 'MySpeed-windows-x64-baseline.exe'])
];

const expectedArtifactNames = () => [...new Set([
    ...RELEASE_FILES.map(([artifact]) => artifact),
    ...CONTAINER_FILES.map(([artifact]) => artifact),
    CONTAINER_INDEX_FILE[0]
])].sort();

const artifactSizeLimit = (name) => name === 'release-static' ? STATIC_ARCHIVE_LIMIT
    : name === 'MySpeed.zip' ? SOURCE_ARCHIVE_LIMIT
        : name.startsWith('qualified-oci-') ? OCI_ARCHIVE_LIMIT : BUILD_ARCHIVE_LIMIT;

const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex');

const canonicalChecksums = (releaseAssets) => releaseAssets
    .map(({name, sha256: digest}) => `${digest}  ${name}`)
    .join('\n') + '\n';

const assertSafeSegment = (value, label) => {
    if (typeof value !== 'string' || value.length === 0 || value === '.' || value === '..'
        || value.includes('/') || value.includes('\\') || value.includes('\0'))
        throw new Error(`Unsafe ${label}: ${String(value)}`);
};

const assertVersion = (version) => {
    const match = RELEASE_VERSION.exec(version);
    if (!match) throw new Error(`Invalid release version: ${version}`);
    match.slice(1).map(Number).forEach((part, index) => {
        if (part > MSI_LIMITS[index]) throw new Error(`Release version exceeds MSI bounds: ${version}`);
    });
};

const assertWindowsStamp = (stamp, version) => {
    const match = WINDOWS_STAMP.exec(stamp);
    if (!match || match.slice(1, 4).join('.') !== version
        || Number(match[4]) > WINDOWS_BUILD_LIMIT)
        throw new Error(`Invalid Windows build stamp for ${version}: ${stamp}`);
};

const assertInputs = ({candidateSha, version, windowsStamp, runId, runAttempt, repository,
    evidence}) => {
    if (!COMMIT_SHA.test(candidateSha)) throw new Error(`Invalid source SHA: ${candidateSha}`);
    assertVersion(version);
    assertWindowsStamp(windowsStamp, version);
    if (!Number.isSafeInteger(Number(runId)) || Number(runId) <= 0)
        throw new Error(`Invalid qualification run ID: ${runId}`);
    if (!Number.isSafeInteger(Number(runAttempt)) || Number(runAttempt) <= 0)
        throw new Error(`Invalid qualification run attempt: ${runAttempt}`);
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository))
        throw new Error(`Invalid source repository: ${repository}`);
    for (const field of REQUIRED_EVIDENCE_FIELDS)
        if (evidence?.[field] !== 'success')
            throw new Error(`Mandatory qualification evidence ${field} is not success`);
};

const checkedFile = async (root, artifact, file, sizeLimit = null) => {
    assertSafeSegment(artifact, 'artifact name');
    assertSafeSegment(file, 'artifact file name');
    const filePath = path.join(root, artifact, file);
    let stats;
    try {
        stats = await fs.promises.lstat(filePath);
    } catch (error) {
        if (error.code === 'ENOENT') throw new Error(`Missing artifact file: ${artifact}/${file}`);
        throw error;
    }
    if (!stats.isFile() || stats.isSymbolicLink() || stats.nlink !== SINGLE_LINK)
        throw new Error(`Artifact payload is not an ordinary file: ${artifact}/${file}`);
    if (stats.size === 0) throw new Error(`Empty artifact payload: ${artifact}/${file}`);
    if (sizeLimit !== null && stats.size > sizeLimit)
        throw new Error(`Artifact payload exceeds size limit: ${artifact}/${file}`);

    const digestPath = `${filePath}.sha256`;
    let expected;
    try {
        expected = (await fs.promises.readFile(digestPath, 'utf8')).trim();
    } catch (error) {
        if (error.code === 'ENOENT') throw new Error(`Missing sha256 file: ${artifact}/${file}`);
        throw error;
    }
    if (!SHA256.test(expected)) throw new Error(`Invalid sha256 file: ${artifact}/${file}`);
    const actual = sha256(await fs.promises.readFile(filePath));
    if (actual !== expected) throw new Error(`SHA256 digest mismatch: ${artifact}/${file}`);
    return {artifact, path: file, sha256: actual, size: stats.size};
};

const portableBasename = (value) => typeof value === 'string' ? value.split(/[\\/]/).at(-1) : '';

const checkedVerificationSummary = async (options, artifact, file, expected) => {
    const checked = await checkedFile(options.root, artifact, file, EVIDENCE_FILE_LIMIT);
    let summary;
    try {
        summary = JSON.parse(await fs.promises.readFile(path.join(options.root, artifact, file), 'utf8'));
    } catch {
        throw new Error(`Invalid verifier evidence JSON: ${artifact}/${file}`);
    }
    if (summary.status !== 'passed' || summary.exit !== 0)
        throw new Error(`Verifier evidence status is not passed: ${artifact}/${file}`);
    if (summary.mode !== expected.mode)
        throw new Error(`Verifier evidence mode mismatch: ${artifact}/${file}`);
    if (summary.sourceSha !== options.candidateSha)
        throw new Error(`Verifier evidence source SHA mismatch: ${artifact}/${file}`);
    if (summary.platform !== expected.platform || summary.architecture !== expected.architecture)
        throw new Error(`Verifier evidence platform mismatch: ${artifact}/${file}`);
    if (!SHA256.test(summary.artifactSha256))
        throw new Error(`Verifier evidence artifact digest is invalid: ${artifact}/${file}`);
    if (expected.artifactSha256 && summary.artifactSha256 !== expected.artifactSha256)
        throw new Error(`Verifier evidence artifact digest mismatch: ${artifact}/${file}`);
    if (!Array.isArray(summary.command) || portableBasename(summary.command[0]) !== expected.command)
        throw new Error(`Verifier evidence command mismatch: ${artifact}/${file}`);
    const scenarios = summary.processes?.map(({scenario}) => scenario);
    const expectedScenarios = expected.mode === FULL_MODE
        ? ['populated-first-boot', 'populated-restart', 'fresh-no-config-reset']
        : ['listener-free-reset'];
    if (JSON.stringify(scenarios) !== JSON.stringify(expectedScenarios))
        throw new Error(`Verifier evidence scenarios mismatch: ${artifact}/${file}`);
    if (expected.runtime && !summary.command.slice(1).some((argument) =>
        portableBasename(argument) === 'index.js'))
        throw new Error(`Source verifier evidence omitted server entrypoint: ${artifact}/${file}`);

    return {artifact, artifactSha256: summary.artifactSha256, architecture: summary.architecture,
        mode: summary.mode, platform: summary.platform, sourceSha: summary.sourceSha,
        summaryPath: file, summarySha256: checked.sha256};
};

const normalizeArtifactMetadata = (metadata) => {
    if (!Array.isArray(metadata?.artifacts)) throw new Error('Actions artifact metadata is missing');
    const seen = new Set();
    const normalized = metadata.artifacts.map((artifact) => {
        assertSafeSegment(artifact.name, 'artifact name');
        if (seen.has(artifact.name)) throw new Error(`Duplicate Actions artifact: ${artifact.name}`);
        seen.add(artifact.name);
        if (!Number.isSafeInteger(Number(artifact.id)) || Number(artifact.id) <= 0)
            throw new Error(`Invalid Actions artifact ID: ${artifact.name}`);
        if (!Number.isSafeInteger(Number(artifact.size_in_bytes)) || Number(artifact.size_in_bytes) <= 0
            || Number(artifact.size_in_bytes) > artifactSizeLimit(artifact.name))
            throw new Error(`Invalid Actions artifact size: ${artifact.name}`);
        if (artifact.expired) throw new Error(`Expired Actions artifact: ${artifact.name}`);
        if (typeof artifact.digest !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(artifact.digest))
            throw new Error(`Invalid Actions artifact digest: ${artifact.name}`);
        return {archiveDigest: artifact.digest, archiveSize: Number(artifact.size_in_bytes),
            id: Number(artifact.id), name: artifact.name};
    }).sort((left, right) => left.name.localeCompare(right.name));

    const actual = normalized.map(({name}) => name);
    const expected = expectedArtifactNames();
    if (JSON.stringify(actual) !== JSON.stringify(expected))
        throw new Error(`Actions artifact set mismatch: expected ${expected.join(', ')}, got ${actual.join(', ')}`);
    return normalized;
};

export const validateReleaseDigestPolicy = (assets) => {
    const groups = new Map();
    for (const asset of assets) {
        const group = groups.get(asset.sha256) ?? [];
        group.push(asset.name);
        groups.set(asset.sha256, group);
    }
    for (const names of groups.values()) {
        if (names.length === SINGLE_LINK) continue;
        const set = new Set(names);
        const allowed = ALLOWED_DUPLICATES.some((candidate) => candidate.size === set.size
            && names.length === set.size && [...set].every((name) => candidate.has(name)));
        if (!allowed) throw new Error(`Unexpected release digest collision: ${names.join(', ')}`);
    }
};

const buildManifest = async (options) => {
    assertInputs(options);
    const actionsArtifacts = normalizeArtifactMetadata(options.artifactMetadata);
    const releaseAssets = [];
    for (const [artifact, file, name] of RELEASE_FILES) {
        const checked = await checkedFile(options.root, artifact, file, artifactSizeLimit(artifact));
        releaseAssets.push({...checked, name});
    }
    releaseAssets.sort((left, right) => left.name.localeCompare(right.name));
    validateReleaseDigestPolicy(releaseAssets);

    const runtimeVerification = {docker: [], linux: [], macos: [], source: {}, windows: [], wixIce: []};
    for (const [artifact, payload, platform, architecture, mode] of BINARY_VERIFICATIONS) {
        const asset = releaseAssets.find((candidate) => candidate.artifact === artifact
            && candidate.path === payload);
        const verification = await checkedVerificationSummary(options, artifact,
            'qualification-summary.json', {artifactSha256: asset.sha256, architecture,
                command: payload, mode, platform});
        if (platform === 'win32') {
            const versionFile = await checkedFile(options.root, artifact,
                'windows-version.json', EVIDENCE_FILE_LIMIT);
            let versionEvidence;
            try {
                versionEvidence = JSON.parse(await fs.promises.readFile(path.join(options.root,
                    artifact, 'windows-version.json'), 'utf8'));
            } catch {
                throw new Error(`Invalid Windows version evidence JSON: ${artifact}`);
            }
            if (versionEvidence.fileVersion !== options.windowsStamp
                || versionEvidence.productVersion !== options.windowsStamp
                || versionEvidence.windowsStamp !== options.windowsStamp
                || versionEvidence.artifactSha256 !== asset.sha256)
                throw new Error(`Windows version evidence mismatch: ${artifact}`);
            verification.versionEvidencePath = versionFile.path;
            verification.versionEvidenceSha256 = versionFile.sha256;
        }
        const group = platform === 'win32' ? 'windows' : platform === 'darwin' ? 'macos' : 'linux';
        runtimeVerification[group].push(verification);
    }
    for (const [runtime, file] of SOURCE_VERIFICATIONS)
        runtimeVerification.source[runtime] = await checkedVerificationSummary(options,
            'MySpeed.zip', file, {architecture: 'x64', command: runtime, mode: FULL_MODE,
                platform: 'linux', runtime});

    for (const [artifact, binaryArtifact] of MSI_VERIFICATIONS) {
        const ice = await checkedFile(options.root, artifact, 'ice-validation.log', EVIDENCE_FILE_LIMIT);
        const provenanceFile = await checkedFile(options.root, artifact,
            'msi-build-provenance.json', EVIDENCE_FILE_LIMIT);
        let provenance;
        try {
            provenance = JSON.parse(await fs.promises.readFile(path.join(options.root, artifact,
                'msi-build-provenance.json'), 'utf8'));
        } catch {
            throw new Error(`Invalid MSI provenance JSON: ${artifact}`);
        }
        const binary = releaseAssets.find((asset) => asset.artifact === binaryArtifact);
        const installer = releaseAssets.find((asset) => asset.artifact === artifact);
        if (provenance.sourceSha !== options.candidateSha || provenance.version !== options.version
            || provenance.windowsStamp !== options.windowsStamp
            || provenance.binarySha256 !== binary.sha256
            || provenance.installerSha256 !== installer.sha256
            || provenance.iceSha256 !== ice.sha256)
            throw new Error(`MSI provenance mismatch: ${artifact}`);
        runtimeVerification.wixIce.push({artifact, logPath: ice.path, logSha256: ice.sha256,
            mode: 'wix-ice-with-reviewed-ICE61-suppression',
            provenancePath: provenanceFile.path, provenanceSha256: provenanceFile.sha256,
            windowsStamp: provenance.windowsStamp});
    }

    const containers = [];
    const inspectedPlatforms = [];
    for (const [artifact, file, platform] of CONTAINER_FILES) {
        const checked = await checkedFile(options.root, artifact, file, OCI_ARCHIVE_LIMIT);
        const inspected = await inspectOciArchive({archive: path.join(options.root, artifact, file),
            platform, sourceSha: options.candidateSha, version: options.version});
        const runtimeDocker = await inspectDockerRuntimeEvidence({
            file: path.join(options.root, artifact, 'container-inspect.json'),
            expectedConfigDigest: inspected.configDigest,
            sidecar: 'require'
        });
        const provenancePath = path.join(options.root, artifact, 'oci-provenance.json');
        const provenance = JSON.parse(await fs.promises.readFile(provenancePath, 'utf8'));
        if (provenance.sourceSha !== options.candidateSha || provenance.version !== options.version
            || provenance.platform !== platform || provenance.verification !== 'success'
            || provenance.indexDigest !== inspected.indexDigest
            || provenance.manifestDigest !== inspected.manifestDigest
            || provenance.configDigest !== inspected.configDigest
            || JSON.stringify(provenance.layerDigests) !== JSON.stringify(inspected.layerDigests)
            || JSON.stringify(provenance.runtimeDocker) !== JSON.stringify(runtimeDocker))
            throw new Error(`OCI provenance mismatch: ${artifact}`);
        for (const field of ['indexDigest', 'manifestDigest', 'configDigest'])
            if (!/^sha256:[a-f0-9]{64}$/.test(provenance[field]))
                throw new Error(`Invalid OCI ${field}: ${artifact}`);
        if (!Array.isArray(provenance.layerDigests) || provenance.layerDigests.length === 0
            || provenance.layerDigests.some((value) => !/^sha256:[a-f0-9]{64}$/.test(value)))
            throw new Error(`Invalid OCI layer digests: ${artifact}`);
        const architecture = platform.endsWith('amd64') ? 'x64' : 'arm64';
        const verification = await checkedVerificationSummary(options, artifact,
            'qualification-summary.json', {architecture, command: 'docker-entrypoint.sh',
                mode: FULL_MODE, platform: 'linux'});
        runtimeVerification.docker.push({...verification, runtimeDocker});
        inspectedPlatforms.push(inspected);
        containers.push({...checked, platform, indexDigest: inspected.indexDigest,
            manifestDigest: inspected.manifestDigest, configDigest: inspected.configDigest,
            layerDigests: inspected.layerDigests});
    }

    const containerIndex = await checkedFile(options.root, ...CONTAINER_INDEX_FILE,
        OCI_ARCHIVE_LIMIT);
    const indexProvenance = JSON.parse(await fs.promises.readFile(path.join(options.root,
        CONTAINER_INDEX_FILE[0], 'oci-index-provenance.json'), 'utf8'));
    const inspectedIndex = await inspectCombinedOciArchive({archive: path.join(options.root,
        ...CONTAINER_INDEX_FILE), platforms: inspectedPlatforms});
    if (indexProvenance.sourceSha !== options.candidateSha || indexProvenance.version !== options.version
        || indexProvenance.indexDigest !== inspectedIndex.indexDigest
        || indexProvenance.reference !== inspectedIndex.reference
        || JSON.stringify(indexProvenance.platforms) !== JSON.stringify(inspectedIndex.platforms))
        throw new Error('Combined OCI index provenance mismatch');

    return {
        schemaVersion: MANIFEST_SCHEMA_VERSION,
        source: {repository: options.repository, sha: options.candidateSha, version: options.version,
            windowsStamp: options.windowsStamp},
        run: {id: Number(options.runId), attempt: Number(options.runAttempt)},
        evidence: Object.fromEntries(REQUIRED_EVIDENCE_FIELDS.map((field) => [field, options.evidence[field]])),
        runtimeVerification: {...runtimeVerification,
            dockerIndex: {indexDigest: indexProvenance.indexDigest,
                mode: 'content-addressed-combination', result: options.evidence.dockerIndex}},
        promotion: {
            eligible: false,
            evidence: {macosNative: null, msiLifecycle: null, windowsCpuFloor: null, windowsNative: null},
            blockers: PROMOTION_BLOCKERS
        },
        actionsArtifacts,
        releaseAssets,
        containers,
        containerIndex: {...containerIndex, indexDigest: indexProvenance.indexDigest,
            platforms: indexProvenance.platforms, reference: indexProvenance.reference}
    };
};

export const createQualificationManifest = async (options) => {
    const manifest = await buildManifest(options);
    await fs.promises.mkdir(options.output, {recursive: true});
    const checksumLines = canonicalChecksums(manifest.releaseAssets);
    await fs.promises.writeFile(path.join(options.output, 'SHA256SUMS'), checksumLines);
    const serialized = JSON.stringify(manifest, null, 2) + '\n';
    const manifestPath = path.join(options.output, 'qualification-manifest.json');
    await fs.promises.writeFile(manifestPath, serialized);
    await fs.promises.writeFile(`${manifestPath}.sha256`, `${sha256(Buffer.from(serialized))}\n`);
    return manifest;
};

export const readSealedQualificationManifest = async (directory) => {
    const manifestPath = path.join(directory, 'qualification-manifest.json');
    const bytes = await fs.promises.readFile(manifestPath);
    const expected = (await fs.promises.readFile(`${manifestPath}.sha256`, 'utf8')).trim();
    if (!SHA256.test(expected) || sha256(bytes) !== expected)
        throw new Error('Qualification manifest digest mismatch');
    return JSON.parse(bytes);
};

export const validateQualificationManifest = async ({manifest, summaryDirectory, ...options}) => {
    const expected = await buildManifest(options);
    if (JSON.stringify(manifest) !== JSON.stringify(expected))
        throw new Error('Qualification manifest source, version, stamp, run, repository or artifacts mismatch');
    if (!summaryDirectory) throw new Error('Qualification summary directory is required');
    const checksumPath = path.join(summaryDirectory, 'SHA256SUMS');
    let stats;
    try {
        stats = await fs.promises.lstat(checksumPath);
    } catch (error) {
        if (error.code === 'ENOENT') throw new Error('Missing qualified SHA256SUMS');
        throw error;
    }
    if (!stats.isFile() || stats.isSymbolicLink() || stats.nlink !== SINGLE_LINK
        || stats.size === 0 || stats.size > STATIC_ARCHIVE_LIMIT)
        throw new Error('Qualified SHA256SUMS is not an ordinary bounded file');
    const actualChecksums = await fs.promises.readFile(checksumPath, 'utf8');
    if (actualChecksums !== canonicalChecksums(expected.releaseAssets))
        throw new Error('Qualified SHA256SUMS does not match release assets');
    return expected;
};

const parseArguments = (arguments_) => {
    const [command, ...tokens] = arguments_;
    const values = {};
    for (let index = 0; index < tokens.length; index += 2) {
        const key = tokens[index];
        if (!key?.startsWith('--') || tokens[index + 1] === undefined)
            throw new Error(`Invalid argument: ${key ?? ''}`);
        values[key.slice(2)] = tokens[index + 1];
    }
    return {command, values};
};

const runCli = async () => {
    const {command, values} = parseArguments(process.argv.slice(2));
    const options = {
        root: values.root,
        output: values.output,
        artifactMetadata: JSON.parse(await fs.promises.readFile(values.artifacts, 'utf8')),
        candidateSha: values.sha,
        version: values.version,
        windowsStamp: values['windows-stamp'],
        runId: Number(values['run-id']),
        runAttempt: Number(values['run-attempt']),
        repository: values.repository,
        evidence: JSON.parse(await fs.promises.readFile(values.evidence, 'utf8'))
    };
    if (command === 'create') {
        await createQualificationManifest(options);
        return;
    }
    if (command === 'validate') {
        const manifestDirectory = path.dirname(values.manifest);
        const manifest = await readSealedQualificationManifest(manifestDirectory);
        await validateQualificationManifest({...options, manifest, summaryDirectory: manifestDirectory});
        return;
    }
    throw new Error(`Unknown qualification-manifest command: ${command}`);
};

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
    runCli().catch((error) => {
        console.error(error.message);
        process.exitCode = 1;
    });
