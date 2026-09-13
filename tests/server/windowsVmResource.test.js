import {describe, it} from "node:test";
import assert from "node:assert/strict";
import {
    RESOURCE_LIMITS,
    assertExistingVmInventoryUnchanged,
    assertOwnedVmIdentity,
    assertOwnedVmReadyForFirstBoot,
    createOwnerMarker,
    createWindowsVmResourceContract,
    decideWatchdogAction
} from "../../scripts/qualification/windows-vm-resource.mjs";

const RUN_ID = "123e4567-e89b-42d3-a456-426614174000";
const VM_ID = "223e4567-e89b-42d3-a456-426614174000";
const EXISTING_ID = "323e4567-e89b-42d3-a456-426614174000";
const CONFIGURATION_DIGEST = "a".repeat(64);
const EXISTING_VMS = [{id: EXISTING_ID, state: "Running", configurationDigest: CONFIGURATION_DIGEST}];
const INTEGRATION_SERVICES = [
    "423e4567-e89b-42d3-a456-426614174000",
    "523e4567-e89b-42d3-a456-426614174000",
    "623e4567-e89b-42d3-a456-426614174000",
    "723e4567-e89b-42d3-a456-426614174000",
    "823e4567-e89b-42d3-a456-426614174000",
    "923e4567-e89b-42d3-a456-426614174000"
].map((id, index) => ({id, enabled: index < 3}));

const contract = (overrides = {}) => createWindowsVmResourceContract({
    runId: RUN_ID,
    runPathExists: false,
    driveFreeGiB: RESOURCE_LIMITS.hostStartFreeGiB,
    availableMemoryGiB: RESOURCE_LIMITS.hostStartAvailableMemoryGiB,
    existingVms: EXISTING_VMS,
    ...overrides
});

const ownedState = (ownerMarker) => ({
    id: ownerMarker.vmId,
    name: ownerMarker.vmName,
    generation: 2,
    configurationPath: ownerMarker.configurationPath,
    vhd: {
        path: ownerMarker.vhdxPath,
        type: "Dynamic",
        maximumGiB: RESOURCE_LIMITS.outerVhdxMaximumGiB,
        minimumIops: 0,
        maximumIops: RESOURCE_LIMITS.outerMaximumIops,
        attachmentCount: 1,
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

const readyState = (ownerMarker) => ({
    ...ownedState(ownerMarker),
    state: "Off",
    secureBootEnabled: true,
    snapshots: [],
    snapshotFileLocation: `${ownerMarker.runPath}\\snapshots`,
    smartPagingFilePath: `${ownerMarker.runPath}\\smart-paging`,
    integrationServices: INTEGRATION_SERVICES
});

describe("Windows qualification VM resource contract", () => {
    it("generates the exact isolated D: paths and fixed resource ceilings", () => {
        const result = contract();

        assert.equal(result.hostRoot, "D:\\MySpeedQualification");
        assert.equal(result.runPath, `D:\\MySpeedQualification\\${RUN_ID}`);
        assert.deepEqual(result.paths, {
            configuration: `D:\\MySpeedQualification\\${RUN_ID}\\vm`,
            ownerMarker: `D:\\MySpeedQualification\\${RUN_ID}\\owner.json`,
            smartPaging: `D:\\MySpeedQualification\\${RUN_ID}\\smart-paging`,
            snapshots: `D:\\MySpeedQualification\\${RUN_ID}\\snapshots`,
            vhdx: `D:\\MySpeedQualification\\${RUN_ID}\\outer.vhdx`
        });
        assert.deepEqual(result.outerVm, {
            name: `MySpeedQualification-${RUN_ID}`,
            generation: 2,
            processorCount: 2,
            cpuMaximumPercentPerVp: 50,
            cpuReservePercent: 0,
            dynamicMemoryEnabled: false,
            startupMemoryGiB: 8,
            vhdxMaximumGiB: 64,
            directoryMaximumGiB: 80,
            maximumIops: 1000,
            networkAdapters: [],
            initialAdapterRemovalRequired: true,
            automaticStartAction: "Nothing",
            automaticStopAction: "ShutDown",
            automaticCheckpointsEnabled: false,
            checkpointType: "Disabled",
            exposeVirtualizationExtensions: false,
            secureBootTemplate: "MicrosoftUEFICertificateAuthority"
        });
        assert.deepEqual(result.innerVm, {processorCount: 2, memoryGiB: 6, diskMaximumGiB: 48});
        assert.equal(result.hostMinimums.driveFreeGiB, 120);
        assert.equal(result.hostMinimums.availableMemoryGiB, 28);
        assert.equal(result.hostFreeReserveGiB, 40);
        assert.deepEqual(result.watchdogThresholds, {
            directoryAbortGiB: 78,
            driveFreeStopGiB: 42,
            availableMemoryStopGiB: 16,
            hostCpuStopPercent: 70,
            hostCpuSustainedSeconds: 60,
            driveLatencyStopMs: 50,
            driveLatencySustainedSeconds: 60
        });
        assert.equal(result.allowedExistingVmMutations, 0);
    });

    it("accepts exact preflight boundaries and snapshots the existing inventory", () => {
        const result = contract();
        assert.deepEqual(result.preExistingVms, EXISTING_VMS);
        assert.notEqual(result.preExistingVms, EXISTING_VMS);
    });

    it("rejects a noncanonical run ID, an existing run path, and insufficient resources", () => {
        for (const runId of ["UPPER", RUN_ID.toUpperCase(), "../escape", "123e4567-e89b-12d3-a456-426614174000"])
            assert.throws(() => contract({runId}), /run ID/i);
        assert.throws(() => contract({runPathExists: true}), /already exists/i);
        assert.throws(() => contract({driveFreeGiB: RESOURCE_LIMITS.hostStartFreeGiB - 1}), /free space/i);
        assert.throws(() => contract({availableMemoryGiB:
            RESOURCE_LIMITS.hostStartAvailableMemoryGiB - 1}), /available memory/i);
        for (const field of ["driveFreeGiB", "availableMemoryGiB"])
            assert.throws(() => contract({[field]: Number.NaN}), new RegExp(field, "i"));
    });

    it("rejects malformed or ambiguous pre-existing VM inventory", () => {
        assert.throws(() => contract({existingVms: [{...EXISTING_VMS[0], id: "not-a-guid"}]}), /VM ID/i);
        assert.throws(() => contract({existingVms: [{...EXISTING_VMS[0], configurationDigest: "A".repeat(64)}]}),
            /configuration digest/i);
        assert.throws(() => contract({existingVms: [...EXISTING_VMS, ...EXISTING_VMS]}), /duplicate/i);
    });

    it("binds one fresh GUID to the exact generated name and paths", () => {
        const resource = contract();
        const marker = createOwnerMarker(resource, VM_ID);

        assert.deepEqual(marker, {
            schemaVersion: 1,
            ownerKind: "myspeed-windows-qualification",
            runId: RUN_ID,
            vmId: VM_ID,
            vmName: resource.outerVm.name,
            runPath: resource.runPath,
            configurationPath: resource.paths.configuration,
            vhdxPath: resource.paths.vhdx
        });
        assert.throws(() => createOwnerMarker(resource, EXISTING_ID), /pre-existing/i);
        assert.throws(() => createOwnerMarker(resource, VM_ID.toUpperCase()), /VM ID/i);
        assert.throws(() => createOwnerMarker({...resource, runPath: "C:\\wrong"}, VM_ID),
            /resource contract/i);
    });

    it("proves ownership only from the complete marker, GUID, paths, settings, and zero NIC state", () => {
        const expectedMarker = createOwnerMarker(contract(), VM_ID);
        const observed = ownedState(expectedMarker);
        assert.equal(assertOwnedVmIdentity({expectedMarker, actualMarker: {...expectedMarker}, observedVm: observed}),
            VM_ID);

        const markerFields = ["runId", "vmId", "vmName", "runPath", "configurationPath", "vhdxPath"];
        for (const field of markerFields) assert.throws(() => assertOwnedVmIdentity({
            expectedMarker,
            actualMarker: {...expectedMarker, [field]: `${expectedMarker[field]}-drift`},
            observedVm: observed
        }), /owner marker/i, field);
        for (const actualMarker of [
            {...expectedMarker, schemaVersion: 2},
            {...expectedMarker, ownerKind: "foreign"},
            Object.fromEntries(Object.entries(expectedMarker).filter(([field]) => field !== "vmId")),
            {...expectedMarker, unexpected: true}
        ]) assert.throws(() => assertOwnedVmIdentity({expectedMarker, actualMarker, observedVm: observed}),
            /owner marker/i);

        const observedDrift = [
            ["id", "423e4567-e89b-42d3-a456-426614174000"],
            ["name", `${expectedMarker.vmName}-other`],
            ["configurationPath", `${expectedMarker.configurationPath}-other`],
            ["vhd", {...observed.vhd, path: `${expectedMarker.runPath}\\foreign.vhdx`}],
            ["vhd", {...observed.vhd, type: "Fixed"}],
            ["vhd", {...observed.vhd, maximumGiB: 65}],
            ["vhd", {...observed.vhd, minimumIops: 1}],
            ["vhd", {...observed.vhd, maximumIops: 0}],
            ["vhd", {...observed.vhd, attachmentCount: 2}],
            ["vhd", {...observed.vhd, hostMounted: true}],
            ["networkAdapters", [{id: "unexpected"}]],
            ["processorCount", 4],
            ["cpuMaximumPercentPerVp", 100],
            ["cpuReservePercent", 1],
            ["dynamicMemoryEnabled", true],
            ["startupMemoryGiB", 9],
            ["automaticStartAction", "StartIfRunning"],
            ["automaticStopAction", "TurnOff"],
            ["automaticCheckpointsEnabled", true],
            ["checkpointType", "Production"],
            ["exposeVirtualizationExtensions", true],
            ["secureBootTemplate", "MicrosoftWindows"]
        ];
        for (const [field, value] of observedDrift) assert.throws(() => assertOwnedVmIdentity({
            expectedMarker,
            actualMarker: expectedMarker,
            observedVm: {...observed, [field]: value}
        }), /identity/i, field);
    });

    it("requires the complete powered-off first-boot seal and reviewed integration-service IDs", () => {
        const expectedMarker = createOwnerMarker(contract(), VM_ID);
        const observedVm = readyState(expectedMarker);
        assert.equal(assertOwnedVmReadyForFirstBoot({expectedMarker, actualMarker: expectedMarker, observedVm,
            expectedIntegrationServices: INTEGRATION_SERVICES}), VM_ID);

        const drift = [
            ["state", "Running"],
            ["secureBootEnabled", false],
            ["snapshots", [{id: "unexpected"}]],
            ["snapshotFileLocation", `${expectedMarker.runPath}\\wrong`],
            ["smartPagingFilePath", `${expectedMarker.runPath}\\wrong`],
            ["integrationServices", INTEGRATION_SERVICES.slice(0, -1)],
            ["integrationServices", INTEGRATION_SERVICES.map((service, index) =>
                index === 0 ? {...service, enabled: false} : service)]
        ];
        for (const [field, value] of drift) assert.throws(() => assertOwnedVmReadyForFirstBoot({
            expectedMarker,
            actualMarker: expectedMarker,
            observedVm: {...observedVm, [field]: value},
            expectedIntegrationServices: INTEGRATION_SERVICES
        }), /first-boot|integration service/i, field);
    });

    it("rejects ambiguous integration-service allowlists", () => {
        const expectedMarker = createOwnerMarker(contract(), VM_ID);
        const observedVm = readyState(expectedMarker);
        const cases = [
            INTEGRATION_SERVICES.slice(0, -1),
            [...INTEGRATION_SERVICES.slice(0, -1), {...INTEGRATION_SERVICES[0]}],
            INTEGRATION_SERVICES.slice().reverse(),
            INTEGRATION_SERVICES.map((service, index) => index === 0 ? {...service, id: "not-a-guid"} : service),
            INTEGRATION_SERVICES.map((service, index) => index === 0 ? {...service, enabled: "true"} : service),
            INTEGRATION_SERVICES.map((service, index) => index === 0 ? {...service, name: "Heartbeat"} : service)
        ];
        for (const expectedIntegrationServices of cases)
            assert.throws(() => assertOwnedVmReadyForFirstBoot({expectedMarker, actualMarker: expectedMarker,
                observedVm, expectedIntegrationServices}), /integration service/i);

        const actualCases = [
            INTEGRATION_SERVICES.slice().reverse(),
            [...INTEGRATION_SERVICES.slice(0, -1), {...INTEGRATION_SERVICES[0]}],
            INTEGRATION_SERVICES.map((service, index) => index === 0 ? {...service, enabled: "true"} : service)
        ];
        for (const integrationServices of actualCases)
            assert.throws(() => assertOwnedVmReadyForFirstBoot({expectedMarker, actualMarker: expectedMarker,
                observedVm: {...observedVm, integrationServices},
                expectedIntegrationServices: INTEGRATION_SERVICES}), /integration service/i);

        const validButDifferent = INTEGRATION_SERVICES.map((service, index) => ({
            ...service,
            enabled: index >= 3
        }));
        assert.throws(() => assertOwnedVmReadyForFirstBoot({expectedMarker, actualMarker: expectedMarker,
            observedVm: {...observedVm, integrationServices: validButDifferent},
            expectedIntegrationServices: INTEGRATION_SERVICES}), /state differs/i);
    });

    it("rejects any missing, changed, or added pre-existing VM", () => {
        assert.equal(assertExistingVmInventoryUnchanged({
            before: EXISTING_VMS,
            after: [...EXISTING_VMS, {id: VM_ID, state: "Off", configurationDigest: "b".repeat(64)}],
            ownedVmId: VM_ID
        }), true);
        assert.throws(() => assertExistingVmInventoryUnchanged({
            before: EXISTING_VMS,
            after: [{...EXISTING_VMS[0], state: "Off"}],
            ownedVmId: VM_ID
        }), /changed/i);
        assert.throws(() => assertExistingVmInventoryUnchanged({before: EXISTING_VMS, after: [], ownedVmId: VM_ID}),
            /missing/i);
        assert.throws(() => assertExistingVmInventoryUnchanged({
            before: EXISTING_VMS,
            after: [...EXISTING_VMS, {id: "423e4567-e89b-42d3-a456-426614174000", state: "Off",
                configurationDigest: "c".repeat(64)}],
            ownedVmId: VM_ID
        }), /unexpected/i);
    });

    it("returns a stop target only for a revalidated exact GUID identity", () => {
        const expectedMarker = createOwnerMarker(contract(), VM_ID);
        const actualMarker = {...expectedMarker};
        const observedVm = ownedState(expectedMarker);

        assert.deepEqual(decideWatchdogAction({expectedMarker, actualMarker, observedVm,
            stopRequired: false}), {action: "none", targetVmId: null, mayMutate: false});
        assert.deepEqual(decideWatchdogAction({expectedMarker, actualMarker, observedVm,
            stopRequired: true}), {action: "stop-owned-vm", targetVmId: VM_ID, mayMutate: true});

        const ambiguous = decideWatchdogAction({expectedMarker, actualMarker,
            observedVm: {...observedVm, configurationPath: `${observedVm.configurationPath}-wrong`},
            stopRequired: true});
        assert.equal(ambiguous.action, "manual-intervention");
        assert.equal(ambiguous.targetVmId, null);
        assert.equal(ambiguous.mayMutate, false);
        assert.match(ambiguous.reason, /identity/i);

        const malformedSignal = decideWatchdogAction({expectedMarker, actualMarker, observedVm,
            stopRequired: "yes"});
        assert.equal(malformedSignal.action, "manual-intervention");
        assert.equal(malformedSignal.targetVmId, null);
        assert.equal(malformedSignal.mayMutate, false);
        assert.match(malformedSignal.reason, /signal/i);
    });
});
