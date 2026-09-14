import crypto from "node:crypto";
import {spawnSync} from "node:child_process";
import path from "node:path";
import {isDeepStrictEqual} from "node:util";

import {createV161PostReleaseMsiAcquisitionRecord} from "./post-release-msi-acquisition.mjs";
import {validateV161PostReleaseMsiWindowsPreparation} from "./post-release-msi-hosted-prepare.mjs";

const SCHEMA_VERSION = 1;
const PLAN_KIND = "myspeed-v1.6.1-post-release-msi-fixture-plan";
const RESULT_KIND = "myspeed-v1.6.1-post-release-msi-fixture-preparation";
const CANDIDATE_BINDING = "candidate-default";
const PREDECESSOR_SOURCE_BINDING = "authentic-1.6.0-default-msi";
const MYSPEED_UPGRADE_CODE = "{A1B2C3D4-5E6F-7890-ABCD-EF1234567890}";
const CANDIDATE_WINDOWS_STAMP = "1.6.1.45";
const MAX_FILE_BYTES = 1_073_741_824;
const MIN_PAYLOAD_FILE_COUNT = 3;
const MAX_PAYLOAD_FILE_COUNT = 128;
const HOST_OPERATION_TIMEOUT_MS = 600_000;
const HASH = /^[0-9a-f]{64}$/u;
const SOURCE_SHA = /^[0-9a-f]{40}$/u;
const NONCE = /^[0-9a-f]{32}$/u;
const DECIMAL = /^[1-9][0-9]{0,19}$/u;
const GUID = /^\{[0-9A-F]{8}(?:-[0-9A-F]{4}){3}-[0-9A-F]{12}\}$/u;
const VERSION = /^[0-9]{1,3}(?:\.[0-9]{1,5}){2,3}$/u;
const FIXTURE_SPECS = Object.freeze([
    Object.freeze({bindingId: "lower-stamp-fixture", sourceBindingId: PREDECESSOR_SOURCE_BINDING,
        productVersion: "1.6.0.0", fileName: "lower-stamp.msi"}),
    Object.freeze({bindingId: "safe-rollback-predecessor", productVersion: "1.5.0.0",
        sourceBindingId: PREDECESSOR_SOURCE_BINDING, fileName: "safe-rollback-predecessor.msi"})
]);
const PLAN_IDENTITY = Symbol("validated-post-release-msi-fixture-plan");

const fail = message => { throw new Error(`Invalid post-release MSI fixture preparation: ${message}`); };
const object = (value, label) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${label} must be an object`);
};
const exactKeys = (value, keys, label) => {
    object(value, label);
    const actual = Object.keys(value).sort(), expected = [...keys].sort();
    if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index]))
        fail(`${label} keys differ`);
};
const scalar = (value, pattern, label) => {
    if (typeof value !== "string") fail(`${label} differs`);
    const match = pattern.exec(value);
    if (!match || match.index !== 0 || match[0].length !== value.length) fail(`${label} differs`);
    return value;
};
const integer = (value, label) => {
    if (!Number.isSafeInteger(value) || value < 1 || value > MAX_FILE_BYTES) fail(`${label} differs`);
    return value;
};
const windowsPath = (value, label) => {
    scalar(value, /^[A-Za-z]:\\[^\x00-\x1f\x7f*?]*$/u, label);
    if (path.win32.normalize(value) !== value || value.slice(2).includes(":")) fail(`${label} differs`);
    return value;
};
const descendant = (root, value, label) => {
    const item = windowsPath(value, label), relative = path.win32.relative(root, item);
    if (!relative || relative === ".." || relative.startsWith(`..${path.win32.sep}`)
        || path.win32.isAbsolute(relative)) fail(`${label} escapes output root`);
    return item;
};
const freeze = value => {
    if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
    for (const child of Object.values(value)) freeze(child);
    return Object.freeze(value);
};
const deterministicGuid = (candidateSha256, bindingId, purpose) => {
    const bytes = crypto.createHash("sha256").update(`${candidateSha256}\0${bindingId}\0${purpose}`, "utf8")
        .digest().subarray(0, 16);
    bytes[6] = (bytes[6] & 0x0f) | 0x50;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = bytes.toString("hex").toUpperCase();
    return `{${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}}`;
};
const versionParts = value => scalar(value, VERSION, "MSI ProductVersion").split(".").map(Number);
const compareVersions = (left, right) => {
    const a = versionParts(left), b = versionParts(right);
    for (let index = 0; index < Math.max(a.length, b.length); index++) {
        const difference = (a[index] ?? 0) - (b[index] ?? 0);
        if (difference !== 0) return Math.sign(difference);
    }
    return 0;
};
const validatePreparation = value => {
    exactKeys(value, ["repository", "harnessSourceSha", "candidateSourceSha", "runId", "runAttempt",
        "imageVersion", "nonce"], "preparation context");
    if (value.repository !== "i7Gamer/MySpeed") fail("preparation repository differs");
    scalar(value.harnessSourceSha, SOURCE_SHA, "harness source SHA");
    scalar(value.candidateSourceSha, SOURCE_SHA, "candidate source SHA");
    scalar(value.runId, DECIMAL, "run ID"); scalar(value.runAttempt, DECIMAL, "run attempt");
    scalar(value.imageVersion, /^[^\x00-\x20\x7f]{1,128}$/u, "image version");
    scalar(value.nonce, NONCE, "preparation nonce");
};
const validateProperties = (value, label, includePackage = false) => {
    exactKeys(value, ["ProductCode", "ProductVersion", "UpgradeCode",
        ...(includePackage ? ["PackageCode"] : [])], `${label} properties`);
    scalar(value.ProductCode, GUID, `${label} ProductCode`);
    scalar(value.ProductVersion, VERSION, `${label} ProductVersion`);
    scalar(value.UpgradeCode, GUID, `${label} UpgradeCode`);
    if (includePackage) scalar(value.PackageCode, GUID, `${label} PackageCode`);
};
const validatePayload = (value, label) => {
    exactKeys(value, ["exe", "configuration", "wrapper", "inventory"], `${label} payload`);
    for (const [name, item] of Object.entries(value).filter(([name]) => name !== "inventory")) {
        exactKeys(item, ["bytes", "sha256", ...(name === "exe" ? ["fileVersion", "productVersion"] : [])],
            `${label} ${name}`);
        integer(item.bytes, `${label} ${name} bytes`); scalar(item.sha256, HASH, `${label} ${name} SHA-256`);
        if (name === "exe") {
            scalar(item.fileVersion, VERSION, `${label} executable file version`);
            scalar(item.productVersion, VERSION, `${label} executable product version`);
        }
    }
    if (!Array.isArray(value.inventory) || value.inventory.length < MIN_PAYLOAD_FILE_COUNT ||
        value.inventory.length > MAX_PAYLOAD_FILE_COUNT)
        fail(`${label} payload inventory differs`);
    const paths = [];
    for (const item of value.inventory) {
        exactKeys(item, ["path", "bytes", "sha256"], `${label} payload inventory item`);
        scalar(item.path, /^[A-Za-z0-9._ -]+(?:\/[A-Za-z0-9._ -]+)*$/u, `${label} payload path`);
        if (path.posix.normalize(item.path) !== item.path) fail(`${label} payload path differs`);
        integer(item.bytes, `${label} payload bytes`); scalar(item.sha256, HASH, `${label} payload SHA-256`);
        paths.push(item.path);
    }
    const sorted = [...paths].sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
    if (new Set(paths).size !== paths.length || paths.some((item, index) => item !== sorted[index]))
        fail(`${label} payload inventory order differs`);
    for (const [name, fileName] of [["exe", "MySpeed.exe"], ["configuration", "MySpeedService.xml"],
        ["wrapper", "MySpeedService.exe"]]) {
        const matches = value.inventory.filter(item => path.posix.basename(item.path) === fileName);
        if (matches.length !== 1 || matches[0].bytes !== value[name].bytes
            || matches[0].sha256 !== value[name].sha256) fail(`${label} ${name} inventory binding differs`);
    }
};
const validateCandidate = value => {
    exactKeys(value, ["bindingId", "local", "properties"], "candidate inspection");
    if (value.bindingId !== CANDIDATE_BINDING) fail("candidate binding differs");
    exactKeys(value.local, ["path", "bytes", "sha256"], "candidate local identity");
    windowsPath(value.local.path, "candidate path"); integer(value.local.bytes, "candidate bytes");
    scalar(value.local.sha256, HASH, "candidate SHA-256"); validateProperties(value.properties, "candidate");
    if (value.properties.UpgradeCode !== MYSPEED_UPGRADE_CODE) fail("candidate UpgradeCode differs");
    if (compareVersions(value.properties.ProductVersion, "1.6.1") !== 0)
        fail("candidate ProductVersion differs from v1.6.1");
};
const validateFileIdentity = (value, label) => {
    exactKeys(value, ["path", "bytes", "sha256"], label);
    windowsPath(value.path, `${label} path`); integer(value.bytes, `${label} bytes`);
    scalar(value.sha256, HASH, `${label} SHA-256`);
};

export const buildV161PostReleaseMsiFixturePlan = input => {
    exactKeys(input, ["acquisitionPlan", "outputRoot", "windowsPreparation"], "fixture plan input");
    createV161PostReleaseMsiAcquisitionRecord(input.acquisitionPlan, input.windowsPreparation.files,
        input.windowsPreparation.runtime.local);
    validateV161PostReleaseMsiWindowsPreparation(input.windowsPreparation, input.acquisitionPlan);
    const preparation = input.windowsPreparation.preparation;
    validatePreparation(preparation);
    const candidate = input.windowsPreparation.inspections.find(item => item.bindingId === CANDIDATE_BINDING);
    validateCandidate(candidate);
    const predecessorSource = input.windowsPreparation.inspections.find(item =>
        item.bindingId === PREDECESSOR_SOURCE_BINDING);
    if (!predecessorSource) fail("rollback predecessor source differs");
    validateProperties(predecessorSource.properties, "rollback predecessor source");
    if (predecessorSource.properties.UpgradeCode !== MYSPEED_UPGRADE_CODE
        || compareVersions(predecessorSource.properties.ProductVersion, candidate.properties.ProductVersion) >= 0)
        fail("rollback predecessor source properties differ");
    const candidateExecutable = input.windowsPreparation.files.find(item =>
        item.bindingId === CANDIDATE_BINDING && item.role === "exe");
    const candidateExecutableIdentity = candidateExecutable && {path: candidateExecutable.path,
        bytes: candidateExecutable.bytes, sha256: candidateExecutable.sha256};
    validateFileIdentity(candidateExecutableIdentity, "candidate executable");
    const outputRoot = windowsPath(input.outputRoot, "fixture output root");
    const sources = new Map([[CANDIDATE_BINDING, candidate], [PREDECESSOR_SOURCE_BINDING, predecessorSource]]);
    const fixtures = FIXTURE_SPECS.map(spec => { const source = sources.get(spec.sourceBindingId); return {...spec,
        destinationPath: descendant(outputRoot, path.win32.join(outputRoot, spec.fileName), "fixture destination"),
        sourcePath: source.local.path, sourceSha256: source.local.sha256,
        productCode: deterministicGuid(source.local.sha256, spec.bindingId, "product"),
        packageCode: deterministicGuid(source.local.sha256, spec.bindingId, "package"),
        upgradeCode: MYSPEED_UPGRADE_CODE}; });
    if (fixtures.some(item => compareVersions(item.productVersion, candidate.properties.ProductVersion) >= 0))
        fail("fixture ProductVersion is not below candidate");
    const plan = {schemaVersion: SCHEMA_VERSION, kind: PLAN_KIND, preparation: structuredClone(preparation),
        candidate: structuredClone(candidate), predecessorSource: structuredClone(predecessorSource),
        candidateExecutable: structuredClone(candidateExecutableIdentity),
        outputRoot, fixtures};
    Object.defineProperty(plan, PLAN_IDENTITY, {value: true});
    return freeze(plan);
};

const validateBuiltFixture = (value, expected, candidatePayload) => {
    exactKeys(value, ["bindingId", "path", "bytes", "sha256", "properties", "payload"], "built fixture");
    if (value.bindingId !== expected.bindingId || value.path !== expected.destinationPath)
        fail("built fixture binding differs");
    integer(value.bytes, "built fixture bytes"); scalar(value.sha256, HASH, "built fixture SHA-256");
    validateProperties(value.properties, "built fixture", true); validatePayload(value.payload, "built fixture");
    if (value.properties.ProductCode !== expected.productCode || value.properties.PackageCode !== expected.packageCode
        || value.properties.ProductVersion !== expected.productVersion
        || value.properties.UpgradeCode !== expected.upgradeCode) fail("built fixture properties differ");
    if (!isDeepStrictEqual(value.payload, candidatePayload)) fail("built fixture payload differs from candidate");
};

export const prepareV161PostReleaseMsiFixturesOnWindows = async (plan, operations) => {
    if (!plan || !Object.isFrozen(plan) || plan[PLAN_IDENTITY] !== true)
        fail("fixture plan must come from the authenticated builder");
    object(operations, "host operations");
    for (const name of ["initialize", "inspectPayload", "buildClone"])
        if (typeof operations[name] !== "function") fail(`host operation ${name} is absent`);
    await operations.initialize(plan.outputRoot);
    const candidatePayload = await operations.inspectPayload(plan.candidate);
    validatePayload(candidatePayload, "candidate");
    if (candidatePayload.exe.bytes !== plan.candidateExecutable.bytes
        || candidatePayload.exe.sha256 !== plan.candidateExecutable.sha256)
        fail("candidate MSI executable differs from published executable");
    if (candidatePayload.exe.fileVersion !== CANDIDATE_WINDOWS_STAMP
        || candidatePayload.exe.productVersion !== CANDIDATE_WINDOWS_STAMP)
        fail("candidate executable Windows stamp differs");
    const predecessorPayload = await operations.inspectPayload(plan.predecessorSource);
    validatePayload(predecessorPayload, "rollback predecessor source");
    if (predecessorPayload.exe.sha256 === candidatePayload.exe.sha256)
        fail("rollback predecessor executable does not force candidate replacement");
    if (compareVersions(predecessorPayload.exe.fileVersion, candidatePayload.exe.fileVersion) >= 0
        || compareVersions(predecessorPayload.exe.productVersion, candidatePayload.exe.productVersion) >= 0)
        fail("fixture executable Windows stamp is not lower than candidate");
    const fixtures = [];
    for (const fixture of plan.fixtures) {
        const expectedPayload = fixture.sourceBindingId === CANDIDATE_BINDING ? candidatePayload : predecessorPayload;
        const built = await operations.buildClone({...structuredClone(fixture),
            sourceMsiPath: fixture.sourcePath, sourceMsiSha256: fixture.sourceSha256,
            expectedPayload: structuredClone(expectedPayload)});
        validateBuiltFixture(built, fixture, expectedPayload);
        fixtures.push({bindingId: fixture.bindingId, path: built.path, bytes: built.bytes, sha256: built.sha256,
            sourceBindingId: fixture.sourceBindingId, sourceMsiSha256: fixture.sourceSha256,
            productCode: built.properties.ProductCode, packageCode: built.properties.PackageCode,
            productVersion: built.properties.ProductVersion,
            upgradeCode: built.properties.UpgradeCode, exeBytes: built.payload.exe.bytes,
            exeSha256: built.payload.exe.sha256, exeFileVersion: built.payload.exe.fileVersion,
            exeProductVersion: built.payload.exe.productVersion,
            configurationSha256: built.payload.configuration.sha256,
            serviceWrapperSha256: built.payload.wrapper.sha256,
            payloadInventory: structuredClone(built.payload.inventory)});
    }
    return freeze({schemaVersion: SCHEMA_VERSION, kind: RESULT_KIND, status: "prepared",
        authority: "windows-hosted-fixture-preparation-only", installerExecution: false,
        preparation: structuredClone(plan.preparation), candidate: structuredClone(plan.candidate),
        predecessorSource: structuredClone(plan.predecessorSource),
        candidateExecutable: structuredClone(plan.candidateExecutable), candidatePayload: structuredClone(candidatePayload),
        predecessorPayload: structuredClone(predecessorPayload), fixtures});
};

export const validateV161PostReleaseMsiFixturePreparation = (value, plan) => {
    exactKeys(value, ["schemaVersion", "kind", "status", "authority", "installerExecution", "preparation",
        "candidate", "predecessorSource", "candidateExecutable", "candidatePayload", "predecessorPayload",
        "fixtures"], "fixture preparation");
    if (value.schemaVersion !== SCHEMA_VERSION || value.kind !== RESULT_KIND || value.status !== "prepared"
        || value.authority !== "windows-hosted-fixture-preparation-only" || value.installerExecution !== false
        || !isDeepStrictEqual(value.preparation, plan.preparation) || !isDeepStrictEqual(value.candidate, plan.candidate)
        || !isDeepStrictEqual(value.predecessorSource, plan.predecessorSource)
        || !isDeepStrictEqual(value.candidateExecutable, plan.candidateExecutable))
        fail("fixture preparation header differs");
    validatePayload(value.candidatePayload, "candidate");
    if (value.candidatePayload.exe.bytes !== plan.candidateExecutable.bytes
        || value.candidatePayload.exe.sha256 !== plan.candidateExecutable.sha256)
        fail("candidate MSI executable differs from published executable");
    if (value.candidatePayload.exe.fileVersion !== CANDIDATE_WINDOWS_STAMP
        || value.candidatePayload.exe.productVersion !== CANDIDATE_WINDOWS_STAMP)
        fail("candidate executable Windows stamp differs");
    validatePayload(value.predecessorPayload, "rollback predecessor source");
    if (value.predecessorPayload.exe.sha256 === value.candidatePayload.exe.sha256)
        fail("rollback predecessor executable does not force candidate replacement");
    if (compareVersions(value.predecessorPayload.exe.fileVersion, value.candidatePayload.exe.fileVersion) >= 0
        || compareVersions(value.predecessorPayload.exe.productVersion,
            value.candidatePayload.exe.productVersion) >= 0)
        fail("fixture executable Windows stamp is not lower than candidate");
    if (!Array.isArray(value.fixtures) || value.fixtures.length !== plan.fixtures.length)
        fail("fixture preparation count differs");
    value.fixtures.forEach((fixture, index) => {
        const expected = plan.fixtures[index];
        exactKeys(fixture, ["bindingId", "sourceBindingId", "sourceMsiSha256", "path", "bytes", "sha256",
            "productCode", "packageCode",
            "productVersion", "upgradeCode", "exeBytes", "exeSha256", "configurationSha256",
            "exeFileVersion", "exeProductVersion", "serviceWrapperSha256", "payloadInventory"],
        "prepared fixture");
        if (fixture.sourceBindingId !== expected.sourceBindingId || fixture.sourceMsiSha256 !== expected.sourceSha256)
            fail("prepared fixture source differs");
        const expectedPayload = expected.sourceBindingId === CANDIDATE_BINDING
            ? value.candidatePayload : value.predecessorPayload;
        validateBuiltFixture({bindingId: fixture.bindingId, path: fixture.path, bytes: fixture.bytes,
            sha256: fixture.sha256, properties: {ProductCode: fixture.productCode,
                ProductVersion: fixture.productVersion, UpgradeCode: fixture.upgradeCode,
                PackageCode: fixture.packageCode}, payload: {
                exe: {bytes: fixture.exeBytes, sha256: fixture.exeSha256,
                    fileVersion: fixture.exeFileVersion, productVersion: fixture.exeProductVersion}, configuration: {
                    bytes: expectedPayload.configuration.bytes, sha256: fixture.configurationSha256},
                wrapper: {bytes: expectedPayload.wrapper.bytes, sha256: fixture.serviceWrapperSha256},
                inventory: fixture.payloadInventory}},
        expected, expectedPayload);
    });
    return true;
};

export const createWindowsHostedMsiFixtureOperations = ({powershellPath, scriptPath, inspectionRoot, wix,
    spawn = spawnSync}) => {
    for (const [label, value] of [["PowerShell", powershellPath], ["fixture script", scriptPath],
        ["inspection root", inspectionRoot], ["WiX dark", wix?.darkPath], ["WiX candle", wix?.candlePath],
        ["WiX light", wix?.lightPath]]) windowsPath(value, label);
    if (path.win32.basename(powershellPath).toLowerCase() !== "pwsh.exe") fail("host adapter requires pwsh.exe");
    if (typeof spawn !== "function") fail("host adapter spawn differs");
    let sequence = 0;
    const invoke = (mode, input) => {
        const args = ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File",
            scriptPath, "-Mode", mode, "-InputJson", JSON.stringify(input)];
        const result = spawn(powershellPath, args, {encoding: "utf8", windowsHide: true,
            maxBuffer: 1024 * 1024, timeout: HOST_OPERATION_TIMEOUT_MS});
        if (!result || result.error || result.status !== 0) fail(`host ${mode} operation failed`);
        try { return JSON.parse(result.stdout); } catch { fail(`host ${mode} output differs`); }
    };
    const workRoot = bindingId => path.win32.join(inspectionRoot, `${String(sequence++).padStart(2, "0")}-${bindingId}`);
    return Object.freeze({
        initialize: async root => { invoke("Initialize", {root}); },
        inspectPayload: async candidate => invoke("InspectPayload", {bindingId: candidate.bindingId,
            path: candidate.local.path, expectedSha256: candidate.local.sha256, outputRoot: workRoot(candidate.bindingId),
            darkPath: wix.darkPath}),
        buildClone: async input => invoke("BuildClone", {...input, outputRoot: workRoot(input.bindingId),
            darkPath: wix.darkPath, candlePath: wix.candlePath, lightPath: wix.lightPath})
    });
};
