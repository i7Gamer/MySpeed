import path from "node:path";
import {spawnSync} from "node:child_process";
import {isDeepStrictEqual} from "node:util";

const SCHEMA_VERSION = 1;
const KIND = "myspeed-v1.6.1-post-release-msi-windows-preparation";
const GUID = /^\{[0-9A-F]{8}(?:-[0-9A-F]{4}){3}-[0-9A-F]{12}\}$/u;
const VERSION = /^[0-9]{1,3}(?:\.[0-9]{1,5}){2,3}$/u;
const HASH = /^[0-9a-f]{64}$/u;
const MAX_FILE_BYTES = 1_073_741_824;
const HOST_OPERATION_TIMEOUT_MS = 600_000;

const fail = message => { throw new Error(`Invalid hosted MSI preparation: ${message}`); };
const object = (value, label) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${label} must be an object`);
};
const exactKeys = (value, keys, label) => {
    object(value, label);
    const actual = Object.keys(value).sort();
    const expected = [...keys].sort();
    if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index]))
        fail(`${label} keys differ`);
};
const scalar = (value, pattern, label) => {
    if (typeof value !== "string") fail(`${label} must be a string`);
    const match = pattern.exec(value);
    if (!match || match.index !== 0 || match[0].length !== value.length) fail(`${label} differs`);
    return value;
};
const positiveInteger = (value, label) => {
    if (!Number.isSafeInteger(value) || value < 1 || value > MAX_FILE_BYTES) fail(`${label} differs`);
};
const freeze = value => {
    if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
    for (const child of Object.values(value)) freeze(child);
    return Object.freeze(value);
};
const validateLocal = (value, expected, label) => {
    exactKeys(value, ["bindingId", "role", "path", "bytes", "sha256"], label);
    if (value.bindingId !== expected.bindingId || value.role !== expected.role
        || value.path !== expected.destinationPath || value.bytes !== expected.source.bytes
        || value.sha256 !== expected.source.sha256) fail(`${label} identity differs`);
    positiveInteger(value.bytes, `${label} bytes`);
    scalar(value.sha256, HASH, `${label} SHA-256`);
};
const validateProperties = value => {
    exactKeys(value, ["ProductCode", "ProductVersion", "UpgradeCode"], "MSI properties");
    scalar(value.ProductCode, GUID, "MSI ProductCode");
    scalar(value.ProductVersion, VERSION, "MSI ProductVersion");
    scalar(value.UpgradeCode, GUID, "MSI UpgradeCode");
};

export const prepareV161PostReleaseMsiOnWindows = async (plan, operations) => {
    object(plan, "acquisition plan");
    object(operations, "host operations");
    if (!Array.isArray(plan.files) || plan.files.length === 0 || !plan.runtime
        || !Array.isArray(plan.inspection?.bindings)) fail("acquisition plan is incomplete");
    for (const name of ["initialize", "download", "observe", "extractZipMember", "observeRuntime",
        "inspectMsi"]) if (typeof operations[name] !== "function") fail(`host operation ${name} is absent`);
    const root = path.win32.dirname(plan.files[0].destinationPath);
    await operations.initialize(root);
    const locals = [];
    for (const file of plan.files) {
        await operations.download(file);
        const local = await operations.observe(file);
        validateLocal(local, file, `download ${file.bindingId}`);
        locals.push(structuredClone(local));
    }
    const archive = plan.files.find(file => file.bindingId === plan.runtime.archiveBindingId
        && file.role === "runtime-archive");
    if (!archive) fail("Node runtime archive binding differs");
    await operations.extractZipMember({...plan.runtime, archivePath: archive.destinationPath});
    const runtime = await operations.observeRuntime(plan.runtime);
    exactKeys(runtime, ["path", "bytes", "sha256"], "Node runtime");
    if (runtime.path !== plan.runtime.destinationPath || runtime.sha256 !== plan.runtime.sha256)
        fail("Node runtime identity differs");
    positiveInteger(runtime.bytes, "Node runtime bytes");
    scalar(runtime.sha256, HASH, "Node runtime SHA-256");
    const inspections = [];
    for (const bindingId of plan.inspection.bindings) {
        const index = plan.files.findIndex(file => file.bindingId === bindingId && file.role === "msi");
        if (index < 0) fail("MSI inspection binding differs");
        const properties = await operations.inspectMsi(plan.files[index], plan.inspection.properties);
        validateProperties(properties);
        inspections.push({bindingId, local: {path: locals[index].path, bytes: locals[index].bytes,
            sha256: locals[index].sha256}, properties: structuredClone(properties)});
    }
    return freeze({schemaVersion: SCHEMA_VERSION, kind: KIND, status: "prepared",
        authority: "windows-hosted-preparation-only", installerExecution: false,
        preparation: structuredClone(plan.preparation),
        files: locals, runtime: {archiveBindingId: plan.runtime.archiveBindingId,
            local: structuredClone(runtime)}, inspections});
};

export const validateV161PostReleaseMsiWindowsPreparation = (value, plan) => {
    exactKeys(value, ["schemaVersion", "kind", "status", "authority", "installerExecution",
        "preparation", "files", "runtime", "inspections"], "hosted preparation");
    if (value.schemaVersion !== SCHEMA_VERSION || value.kind !== KIND || value.status !== "prepared"
        || value.authority !== "windows-hosted-preparation-only" || value.installerExecution !== false)
        fail("hosted preparation header differs");
    if (!isDeepStrictEqual(value.preparation, plan.preparation)) fail("preparation binding differs");
    if (!Array.isArray(value.files) || value.files.length !== plan.files.length)
        fail("hosted preparation files differ");
    value.files.forEach((local, index) => validateLocal(local, plan.files[index], "prepared file"));
    exactKeys(value.runtime, ["archiveBindingId", "local"], "prepared runtime");
    if (value.runtime.archiveBindingId !== plan.runtime.archiveBindingId)
        fail("prepared runtime binding differs");
    const localRuntime = value.runtime.local;
    exactKeys(localRuntime, ["path", "bytes", "sha256"], "prepared runtime local");
    if (localRuntime.path !== plan.runtime.destinationPath || localRuntime.sha256 !== plan.runtime.sha256)
        fail("prepared runtime identity differs");
    positiveInteger(localRuntime.bytes, "prepared runtime bytes");
    if (!Array.isArray(value.inspections) || value.inspections.length !== plan.inspection.bindings.length)
        fail("prepared inspections differ");
    value.inspections.forEach((inspection, index) => {
        exactKeys(inspection, ["bindingId", "local", "properties"], "prepared inspection");
        const bindingId = plan.inspection.bindings[index];
        const file = value.files.find(item => item.bindingId === bindingId && item.role === "msi");
        if (inspection.bindingId !== bindingId || !file || !isDeepStrictEqual(inspection.local,
            {path: file.path, bytes: file.bytes, sha256: file.sha256})) fail("prepared inspection binding differs");
        validateProperties(inspection.properties);
    });
    return true;
};

export const createWindowsHostedMsiPrepareOperations = ({powershellPath, scriptPath, spawn = spawnSync}) => {
    if (typeof powershellPath !== "string" || !path.win32.isAbsolute(powershellPath)
        || typeof scriptPath !== "string" || !path.win32.isAbsolute(scriptPath) || typeof spawn !== "function")
        fail("host adapter configuration differs");
    if (path.win32.basename(powershellPath).toLowerCase() !== "pwsh.exe") fail("host adapter requires pwsh.exe");
    const invoke = (mode, input) => {
        const args = ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File",
            scriptPath, "-Mode", mode, "-InputJson", JSON.stringify(input)];
        const result = spawn(powershellPath, args, {encoding: "utf8", windowsHide: true,
            maxBuffer: 1024 * 1024, timeout: HOST_OPERATION_TIMEOUT_MS});
        if (!result || result.error || result.status !== 0) fail(`host ${mode} operation failed`);
        try { return JSON.parse(result.stdout); } catch { fail(`host ${mode} output differs`); }
    };
    return Object.freeze({
        initialize: async root => { invoke("Initialize", {root}); },
        download: async file => { invoke("Download", {url: file.source.url, path: file.destinationPath,
            maximumBytes: file.source.bytes}); },
        observe: async file => ({bindingId: file.bindingId, role: file.role, ...invoke("Observe",
            {path: file.destinationPath, maximumBytes: MAX_FILE_BYTES, expectedBytes: file.source.bytes,
                expectedSha256: file.source.sha256})}),
        extractZipMember: async runtime => { invoke("ExtractZipMember", {archivePath: runtime.archivePath,
            member: runtime.member, destinationPath: runtime.destinationPath, maximumBytes: MAX_FILE_BYTES}); },
        observeRuntime: async runtime => invoke("Observe", {path: runtime.destinationPath,
            maximumBytes: MAX_FILE_BYTES, expectedSha256: runtime.sha256}),
        inspectMsi: async (file, properties) => invoke("InspectMsi", {path: file.destinationPath, properties})
    });
};
