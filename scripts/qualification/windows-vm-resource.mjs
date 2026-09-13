import path from "node:path";
import {isDeepStrictEqual} from "node:util";

const CONTRACT_SCHEMA_VERSION = 1;
const OWNER_KIND = "myspeed-windows-qualification";
const QUALIFICATION_HOST_ROOT = "D:\\MySpeedQualification";
const VM_NAME_PREFIX = "MySpeedQualification-";
const OWNER_MARKER_FILENAME = "owner.json";
const VM_CONFIGURATION_DIRECTORY = "vm";
const OUTER_VHDX_FILENAME = "outer.vhdx";
const SNAPSHOT_DIRECTORY = "snapshots";
const SMART_PAGING_DIRECTORY = "smart-paging";
const OUTER_VM_GENERATION = 2;
const ALLOWED_EXISTING_VM_MUTATIONS = 0;
const EXPECTED_INTEGRATION_SERVICE_COUNT = 6;
const ENABLED_INTEGRATION_SERVICE_COUNT = 3;
const SHA256 = /^[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const UUID_V4 = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;

export const RESOURCE_LIMITS = Object.freeze({
    outerVcpuCount: 2,
    outerCpuMaximumPercentPerVp: 50,
    outerCpuReservePercent: 0,
    outerMemoryGiB: 8,
    outerVhdxMaximumGiB: 64,
    outerDirectoryMaximumGiB: 80,
    outerDirectoryAbortGiB: 78,
    outerMaximumIops: 1_000,
    innerVcpuCount: 2,
    innerMemoryGiB: 6,
    innerDiskMaximumGiB: 48,
    hostStartFreeGiB: 120,
    hostFreeReserveGiB: 40,
    hostStartAvailableMemoryGiB: 28,
    hostStopDriveFreeGiB: 42,
    hostStopAvailableMemoryGiB: 16,
    hostStopCpuPercent: 70,
    hostStopCpuSustainedSeconds: 60,
    hostStopDriveLatencyMs: 50,
    hostStopDriveLatencySustainedSeconds: 60
});

const assertCanonicalUuid = (value, label, pattern = UUID) => {
    if (typeof value !== "string" || !pattern.test(value))
        throw new Error(`${label} must be a canonical lowercase UUID`);
    return value;
};

const assertFiniteNumber = (value, label) => {
    if (typeof value !== "number" || !Number.isFinite(value))
        throw new Error(`${label} must be a finite number`);
};

const normalizeInventory = (inventory, label) => {
    if (!Array.isArray(inventory)) throw new Error(`${label} must be an array`);
    const seen = new Set();
    return inventory.map((entry) => {
        if (!entry || typeof entry !== "object" || Array.isArray(entry))
            throw new Error(`${label} has a malformed VM entry`);
        const id = assertCanonicalUuid(entry.id, `${label} VM ID`);
        if (seen.has(id)) throw new Error(`${label} has a duplicate VM ID ${id}`);
        seen.add(id);
        if (typeof entry.state !== "string" || entry.state.length === 0)
            throw new Error(`${label} VM state must be a nonempty string`);
        if (typeof entry.configurationDigest !== "string" || !SHA256.test(entry.configurationDigest))
            throw new Error(`${label} VM configuration digest must be lowercase SHA-256`);
        return {id, state: entry.state, configurationDigest: entry.configurationDigest};
    }).sort((left, right) => left.id.localeCompare(right.id));
};

export const createWindowsVmResourceContract = ({
    runId,
    runPathExists,
    driveFreeGiB,
    availableMemoryGiB,
    existingVms
}) => {
    assertCanonicalUuid(runId, "run ID", UUID_V4);
    if (runPathExists !== false)
        throw new Error(`Qualification run path for ${runId} already exists or absence was not proved`);
    assertFiniteNumber(driveFreeGiB, "driveFreeGiB");
    assertFiniteNumber(availableMemoryGiB, "availableMemoryGiB");
    if (driveFreeGiB < RESOURCE_LIMITS.hostStartFreeGiB)
        throw new Error(`D: free space must be at least ${RESOURCE_LIMITS.hostStartFreeGiB} GiB`);
    if (availableMemoryGiB < RESOURCE_LIMITS.hostStartAvailableMemoryGiB)
        throw new Error(`Host available memory must be at least ${RESOURCE_LIMITS.hostStartAvailableMemoryGiB} GiB`);

    const preExistingVms = normalizeInventory(existingVms, "pre-existing inventory");
    const runPath = path.win32.join(QUALIFICATION_HOST_ROOT, runId);
    return {
        schemaVersion: CONTRACT_SCHEMA_VERSION,
        ownerKind: OWNER_KIND,
        runId,
        hostRoot: QUALIFICATION_HOST_ROOT,
        runPath,
        paths: {
            configuration: path.win32.join(runPath, VM_CONFIGURATION_DIRECTORY),
            ownerMarker: path.win32.join(runPath, OWNER_MARKER_FILENAME),
            smartPaging: path.win32.join(runPath, SMART_PAGING_DIRECTORY),
            snapshots: path.win32.join(runPath, SNAPSHOT_DIRECTORY),
            vhdx: path.win32.join(runPath, OUTER_VHDX_FILENAME)
        },
        outerVm: {
            name: `${VM_NAME_PREFIX}${runId}`,
            generation: OUTER_VM_GENERATION,
            processorCount: RESOURCE_LIMITS.outerVcpuCount,
            cpuMaximumPercentPerVp: RESOURCE_LIMITS.outerCpuMaximumPercentPerVp,
            cpuReservePercent: RESOURCE_LIMITS.outerCpuReservePercent,
            dynamicMemoryEnabled: false,
            startupMemoryGiB: RESOURCE_LIMITS.outerMemoryGiB,
            vhdxMaximumGiB: RESOURCE_LIMITS.outerVhdxMaximumGiB,
            directoryMaximumGiB: RESOURCE_LIMITS.outerDirectoryMaximumGiB,
            maximumIops: RESOURCE_LIMITS.outerMaximumIops,
            networkAdapters: [],
            initialAdapterRemovalRequired: true,
            automaticStartAction: "Nothing",
            automaticStopAction: "ShutDown",
            automaticCheckpointsEnabled: false,
            checkpointType: "Disabled",
            exposeVirtualizationExtensions: false,
            secureBootTemplate: "MicrosoftUEFICertificateAuthority"
        },
        innerVm: {
            processorCount: RESOURCE_LIMITS.innerVcpuCount,
            memoryGiB: RESOURCE_LIMITS.innerMemoryGiB,
            diskMaximumGiB: RESOURCE_LIMITS.innerDiskMaximumGiB
        },
        hostMinimums: {
            driveFreeGiB: RESOURCE_LIMITS.hostStartFreeGiB,
            availableMemoryGiB: RESOURCE_LIMITS.hostStartAvailableMemoryGiB
        },
        hostFreeReserveGiB: RESOURCE_LIMITS.hostFreeReserveGiB,
        watchdogThresholds: {
            directoryAbortGiB: RESOURCE_LIMITS.outerDirectoryAbortGiB,
            driveFreeStopGiB: RESOURCE_LIMITS.hostStopDriveFreeGiB,
            availableMemoryStopGiB: RESOURCE_LIMITS.hostStopAvailableMemoryGiB,
            hostCpuStopPercent: RESOURCE_LIMITS.hostStopCpuPercent,
            hostCpuSustainedSeconds: RESOURCE_LIMITS.hostStopCpuSustainedSeconds,
            driveLatencyStopMs: RESOURCE_LIMITS.hostStopDriveLatencyMs,
            driveLatencySustainedSeconds: RESOURCE_LIMITS.hostStopDriveLatencySustainedSeconds
        },
        allowedExistingVmMutations: ALLOWED_EXISTING_VM_MUTATIONS,
        preExistingVms
    };
};

const assertResourceContractIdentity = (resourceContract) => {
    try {
        assertCanonicalUuid(resourceContract?.runId, "resource contract run ID", UUID_V4);
        const expectedRunPath = path.win32.join(QUALIFICATION_HOST_ROOT, resourceContract.runId);
        if (resourceContract.schemaVersion !== CONTRACT_SCHEMA_VERSION || resourceContract.ownerKind !== OWNER_KIND
            || resourceContract.hostRoot !== QUALIFICATION_HOST_ROOT || resourceContract.runPath !== expectedRunPath
            || resourceContract.outerVm?.name !== `${VM_NAME_PREFIX}${resourceContract.runId}`
            || resourceContract.paths?.configuration !== path.win32.join(expectedRunPath, VM_CONFIGURATION_DIRECTORY)
            || resourceContract.paths?.ownerMarker !== path.win32.join(expectedRunPath, OWNER_MARKER_FILENAME)
            || resourceContract.paths?.smartPaging !== path.win32.join(expectedRunPath, SMART_PAGING_DIRECTORY)
            || resourceContract.paths?.snapshots !== path.win32.join(expectedRunPath, SNAPSHOT_DIRECTORY)
            || resourceContract.paths?.vhdx !== path.win32.join(expectedRunPath, OUTER_VHDX_FILENAME))
            throw new Error("identity fields differ");
        normalizeInventory(resourceContract.preExistingVms, "resource contract pre-existing inventory");
    } catch (error) {
        throw new Error(`Invalid resource contract: ${error.message}`);
    }
};

export const createOwnerMarker = (resourceContract, vmId) => {
    assertResourceContractIdentity(resourceContract);
    assertCanonicalUuid(vmId, "VM ID");
    if (resourceContract.preExistingVms.some(({id}) => id === vmId))
        throw new Error(`VM ID ${vmId} belongs to a pre-existing VM`);

    return {
        schemaVersion: CONTRACT_SCHEMA_VERSION,
        ownerKind: OWNER_KIND,
        runId: resourceContract.runId,
        vmId,
        vmName: resourceContract.outerVm.name,
        runPath: resourceContract.runPath,
        configurationPath: resourceContract.paths.configuration,
        vhdxPath: resourceContract.paths.vhdx
    };
};

const markerFields = [
    "schemaVersion", "ownerKind", "runId", "vmId", "vmName", "runPath", "configurationPath", "vhdxPath"
];

const assertMarkerShape = (marker, label) => {
    assertCanonicalUuid(marker.runId, `${label} run ID`, UUID_V4);
    assertCanonicalUuid(marker.vmId, `${label} VM ID`);
    const expectedRunPath = path.win32.join(QUALIFICATION_HOST_ROOT, marker.runId);
    if (marker.schemaVersion !== CONTRACT_SCHEMA_VERSION || marker.ownerKind !== OWNER_KIND
        || marker.vmName !== `${VM_NAME_PREFIX}${marker.runId}` || marker.runPath !== expectedRunPath
        || marker.configurationPath !== path.win32.join(expectedRunPath, VM_CONFIGURATION_DIRECTORY)
        || marker.vhdxPath !== path.win32.join(expectedRunPath, OUTER_VHDX_FILENAME))
        throw new Error(`${label} identity fields differ`);
};

const assertMarkerMatch = (expectedMarker, actualMarker) => {
    if (!expectedMarker || !actualMarker || typeof expectedMarker !== "object" || typeof actualMarker !== "object"
        || Array.isArray(expectedMarker) || Array.isArray(actualMarker))
        throw new Error("Owned VM identity has no complete owner marker");
    const expectedKeys = Object.keys(expectedMarker).sort();
    const actualKeys = Object.keys(actualMarker).sort();
    if (JSON.stringify(expectedKeys) !== JSON.stringify(markerFields.slice().sort())
        || JSON.stringify(actualKeys) !== JSON.stringify(markerFields.slice().sort()))
        throw new Error("Owned VM identity owner marker schema differs");
    assertMarkerShape(expectedMarker, "expected owner marker");
    assertMarkerShape(actualMarker, "actual owner marker");
    for (const field of markerFields)
        if (actualMarker[field] !== expectedMarker[field])
            throw new Error(`Owned VM identity owner marker differs at ${field}`);
};

const expectedObservedVm = (marker) => ({
    id: marker.vmId,
    name: marker.vmName,
    generation: OUTER_VM_GENERATION,
    configurationPath: marker.configurationPath,
    vhd: {
        path: marker.vhdxPath,
        type: "Dynamic",
        maximumGiB: RESOURCE_LIMITS.outerVhdxMaximumGiB,
        minimumIops: 0,
        maximumIops: RESOURCE_LIMITS.outerMaximumIops,
        attachmentCount: 1,
        // This is the independent host disk-image/filesystem mount result.
        // Get-VHD.Attached is not equivalent: attachment to this VM is expected.
        hostMounted: false
    },
    networkAdapters: [],
    processorCount: RESOURCE_LIMITS.outerVcpuCount,
    cpuMaximumPercentPerVp: RESOURCE_LIMITS.outerCpuMaximumPercentPerVp,
    cpuReservePercent: RESOURCE_LIMITS.outerCpuReservePercent,
    dynamicMemoryEnabled: false,
    startupMemoryGiB: RESOURCE_LIMITS.outerMemoryGiB,
    automaticStartAction: "Nothing",
    automaticStopAction: "ShutDown",
    automaticCheckpointsEnabled: false,
    checkpointType: "Disabled",
    exposeVirtualizationExtensions: false,
    secureBootTemplate: "MicrosoftUEFICertificateAuthority"
});

export const assertOwnedVmIdentity = ({expectedMarker, actualMarker, observedVm}) => {
    assertMarkerMatch(expectedMarker, actualMarker);
    if (!observedVm || typeof observedVm !== "object" || Array.isArray(observedVm))
        throw new Error("Owned VM identity observation is missing");

    const expected = expectedObservedVm(expectedMarker);
    for (const [field, value] of Object.entries(expected))
        if (!isDeepStrictEqual(observedVm[field], value))
            throw new Error(`Owned VM identity differs at ${field}`);
    return expectedMarker.vmId;
};

const normalizeIntegrationServices = (services, label) => {
    if (!Array.isArray(services) || services.length !== EXPECTED_INTEGRATION_SERVICE_COUNT)
        throw new Error(`${label} integration service set must contain exactly ${EXPECTED_INTEGRATION_SERVICE_COUNT} entries`);
    const seen = new Set();
    const normalized = services.map((service) => {
        if (!service || typeof service !== "object" || Array.isArray(service)
            || !isDeepStrictEqual(Object.keys(service).sort(), ["enabled", "id"]))
            throw new Error(`${label} integration service entry has an unexpected schema`);
        const id = assertCanonicalUuid(service.id, `${label} integration service ID`);
        if (seen.has(id)) throw new Error(`${label} integration service ID ${id} is duplicated`);
        seen.add(id);
        if (typeof service.enabled !== "boolean")
            throw new Error(`${label} integration service enabled state must be boolean`);
        return {id, enabled: service.enabled};
    });
    const sorted = normalized.slice().sort((left, right) => left.id.localeCompare(right.id));
    if (!isDeepStrictEqual(normalized, sorted))
        throw new Error(`${label} integration service entries must be sorted by stable ID`);
    if (normalized.filter(({enabled}) => enabled).length !== ENABLED_INTEGRATION_SERVICE_COUNT)
        throw new Error(`${label} integration service allowlist must enable exactly ${ENABLED_INTEGRATION_SERVICE_COUNT} entries`);
    return normalized;
};

/**
 * Proves only the reviewed resource and ownership facts at one instant. This
 * is not Start-VM authorization. The caller must use an independently stored,
 * hash-bound integration-service allowlist (never one derived from observedVm)
 * and then re-read the exact VM object by GUID. It must separately prove the
 * authenticated DVD/firmware boot target, absence of every unapproved device
 * or passthrough, and filesystem real-path/reparse/ACL/create-new constraints.
 */
export const assertOwnedVmReadyForFirstBoot = ({
    expectedMarker,
    actualMarker,
    observedVm,
    expectedIntegrationServices
}) => {
    const vmId = assertOwnedVmIdentity({expectedMarker, actualMarker, observedVm});
    const expectedServices = normalizeIntegrationServices(expectedIntegrationServices, "expected");
    const observedServices = normalizeIntegrationServices(observedVm.integrationServices, "observed");
    if (!isDeepStrictEqual(observedServices, expectedServices))
        throw new Error("Owned VM first-boot integration service state differs from its reviewed stable-ID allowlist");

    const expectedFirstBootState = {
        state: "Off",
        secureBootEnabled: true,
        snapshots: [],
        snapshotFileLocation: path.win32.join(expectedMarker.runPath, SNAPSHOT_DIRECTORY),
        smartPagingFilePath: path.win32.join(expectedMarker.runPath, SMART_PAGING_DIRECTORY)
    };
    for (const [field, value] of Object.entries(expectedFirstBootState))
        if (!isDeepStrictEqual(observedVm[field], value))
            throw new Error(`Owned VM first-boot identity differs at ${field}`);
    return vmId;
};

export const assertExistingVmInventoryUnchanged = ({before, after, ownedVmId}) => {
    assertCanonicalUuid(ownedVmId, "owned VM ID");
    const prior = normalizeInventory(before, "pre-existing inventory");
    if (prior.some(({id}) => id === ownedVmId))
        throw new Error(`Owned VM ID ${ownedVmId} was already present`);
    const current = normalizeInventory(after, "current inventory");
    const currentById = new Map(current.map((entry) => [entry.id, entry]));

    for (const entry of prior) {
        const observed = currentById.get(entry.id);
        if (!observed) throw new Error(`Pre-existing VM ${entry.id} is missing`);
        if (observed.state !== entry.state || observed.configurationDigest !== entry.configurationDigest)
            throw new Error(`Pre-existing VM ${entry.id} changed`);
        currentById.delete(entry.id);
    }
    currentById.delete(ownedVmId);
    if (currentById.size > 0)
        throw new Error(`Unexpected VM ${currentById.keys().next().value} appeared`);
    return true;
};

export const decideWatchdogAction = ({expectedMarker, actualMarker, observedVm, stopRequired}) => {
    if (typeof stopRequired !== "boolean") return {
        action: "manual-intervention",
        targetVmId: null,
        mayMutate: false,
        reason: "Watchdog stop signal must be an explicit boolean"
    };
    try {
        const targetVmId = assertOwnedVmIdentity({expectedMarker, actualMarker, observedVm});
        return stopRequired === true
            ? {action: "stop-owned-vm", targetVmId, mayMutate: true}
            : {action: "none", targetVmId: null, mayMutate: false};
    } catch (error) {
        return {
            action: "manual-intervention",
            targetVmId: null,
            mayMutate: false,
            reason: `Owned VM identity could not be revalidated: ${error.message}`
        };
    }
};
