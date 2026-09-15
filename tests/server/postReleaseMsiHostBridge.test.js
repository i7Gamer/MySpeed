import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {describe, it} from "node:test";

import {createWindowsMsiGuestRowSemanticResult} from
    "../helpers/windows-msi-guest-lifecycle-evidence-fixture.mjs";
import {createWindowsMsiMatrixContract} from
    "../../scripts/qualification/windows-msi-matrix-contract.mjs";
import {buildWindowsMsiLifecycleQemuArguments, buildWindowsMsiLifecycleRowActivationHandoff,
    runWindowsMsiLifecycleHost, validateCompletedWindowsMsiLifecycleHostResult,
    validateWindowsMsiLifecycleHostRequest} from
    "../../scripts/qualification/linux-windows-msi-lifecycle-host.mjs";
import {createV161PostReleaseMsiHostBinding, validateV161PostReleaseMsiHostProvenance} from
    "../../scripts/release/post-release-msi-host-bridge.mjs";
import {buildV161PostReleaseMsiLifecycleHostBinding} from "../../scripts/release/post-release-msi-linux-controller.mjs";
import {BASE_SHA256, createPostReleaseMsiControllerFixture, decodedExecution, earlyBoot,
    lifecycleInput, retainedTransportDocument} from
    "../helpers/post-release-msi-controller-fixture.mjs";

const fixture = createPostReleaseMsiControllerFixture;

describe("v1.6.1 published MSI host provenance", () => {
    it("rejects stale same-run metadata, target bytes, proofs, and acquired bytes before host binding", async () => {
        for (const mutate of [
            value => { value.input.artifact.runId = "2"; },
            value => { value.input.artifact.headSha = "f".repeat(40); },
            value => { const result = structuredClone(value.documents.get("result.json"));
                result.targetInput.manifestBytesBase64 = Buffer.from("foreign").toString("base64");
                value.documents.set("result.json", result); },
            value => { const proof = structuredClone(value.documents.get("fixture-proof.json"));
                proof.fixtures[0].sha256 = "f".repeat(64); value.documents.set("fixture-proof.json", proof); },
            value => { const [name, identity] = value.identities.entries().next().value;
                value.identities.set(name, {...identity, sha256: "f".repeat(64)}); }
        ]) await assert.rejects(() => fixture(mutate), /controller|target|proof|acquired|artifact/i);
    });

    it("binds authenticated publication, exact local bytes, and same-job base before row execution", async () => {
        const value = await fixture();
        const controllerBound = await buildV161PostReleaseMsiLifecycleHostBinding(lifecycleInput(value,
            decodedExecution(value.host.request.rows[0])));
        assert.equal(controllerBound.hostRequest.rows.length, 14);
        assert.equal(controllerBound.hostRequest.candidateProvenance, controllerBound.provenance);
        assert.equal(controllerBound.hostRequest.toolchain.firmware.vga.path,
            lifecycleInput(value, decodedExecution(value.host.request.rows[0])).stage2Result.toolchain.firmware.vga.path);
        assert.ok(controllerBound.hostRequest.rows.every(row => row.seedFiles.some(file =>
            file.name === "windows-msi-guest-matrix-operations.mjs")));
        const bound = createV161PostReleaseMsiHostBinding({target: value.target,
            harnessContext: value.harness, envelope: value.envelope, acquisitionPlan: value.acquisitionPlan,
            acquisitionRecord: value.acquisitionRecord, preparation: value.preparation,
            fixturePreparation: value.fixturePreparation, baselinePreparation: value.baselinePreparation,
            transport: value.transport, execution: value.execution, installedBaseSeal: value.seal,
            hostRequest: value.host.request});
        assert.equal(bound.provenance.schemaVersion, 2);
        assert.equal(bound.provenance.candidate.sourceSha, value.target.candidate.sourceSha);
        assert.equal(bound.provenance.harness.sourceSha, value.harness.sourceSha);
        assert.notEqual(bound.provenance.candidate.sourceSha, bound.provenance.harness.sourceSha);
        assert.ok(bound.hostRequest.rows.every(row => decodedExecution(row).fixture.sourceSha
            === value.target.candidate.sourceSha));
        assert.equal(bound.provenance.installedBase.seal.image.sha256, BASE_SHA256);
        assert.deepEqual(bound.provenance.baselinePreparation, value.baselinePreparation);
        assert.equal(bound.hostRequest.candidateProvenance, bound.provenance);
        assert.equal(validateV161PostReleaseMsiHostProvenance(bound.provenance, bound.hostRequest), true);
        assert.equal(validateWindowsMsiLifecycleHostRequest(bound.hostRequest), bound.hostRequest);
        const bootstrapBytes = Buffer.from("function Invoke-MyspeedMsiGuestBootstrap {}", "utf8");
        const activationHandoff = buildWindowsMsiLifecycleRowActivationHandoff({request: bound.hostRequest,
            row: bound.hostRequest.rows[0], bootstrapBytes});
        assert.equal(activationHandoff.value.kind, "myspeed-windows-msi-setupcomplete-handoff");
        assert.equal(activationHandoff.value.host.sourceSha, value.harness.sourceSha);
        assert.equal(activationHandoff.value.row.nonce, bound.hostRequest.rows[0].nonce);
        assert.equal(activationHandoff.value.bootstrap.sha256,
            createHash("sha256").update(bootstrapBytes).digest("hex"));
        assert.notEqual(activationHandoff.value.host.sourceSha, value.target.candidate.sourceSha);
        const row = bound.hostRequest.rows[0];
        const overlay = {path: row.overlayPath, format: "qcow2", backingBaseSha256: BASE_SHA256,
            createNew: true, receiptSha256: "a".repeat(64)};
        const media = {seed: {path: row.seedIsoPath, bytes: "1048576", sha256: "b".repeat(64),
            manifestSha256: "c".repeat(64), readOnly: true, volumeLabel: "MYSPEEDSEED"},
        outputBefore: {path: row.outputDiskPath, bytes: "268435456", sha256: "d".repeat(64),
            createNew: true, volumeLabel: "MYSPEEDOUT"},
        ovmfVarsSha256: bound.hostRequest.toolchain.ovmfVarsTemplate.sha256};
        assert.throws(() => buildWindowsMsiLifecycleQemuArguments({request: bound.hostRequest, row,
            overlay, media}), /seed ISO keys/i);
        media.seed.activationHandoffSha256 = activationHandoff.sha256;
        assert.ok(buildWindowsMsiLifecycleQemuArguments({request: bound.hostRequest, row, overlay, media})
            .includes("none"));
        assert.equal(bound.nativeExecutionStarted, false);
        assert.deepEqual(bound.releaseGatesCleared, []);
    });

    it("rejects a Linux fixture detached from the authenticated candidate baseline", async () => {
        const value = await fixture();
        const input = lifecycleInput(value, decodedExecution(value.host.request.rows[0]));
        input.linuxFixture.binding.candidateFiles[0].sha256 = "f".repeat(64);
        await assert.rejects(buildV161PostReleaseMsiLifecycleHostBinding(input), /fixture.*binding/i);
        const foreignClosure = lifecycleInput(value, decodedExecution(value.host.request.rows[0]));
        foreignClosure.sources.matrixOperations.path = `${foreignClosure.taskRoot}/foreign.mjs`;
        await assert.rejects(buildV161PostReleaseMsiLifecycleHostBinding(foreignClosure), /closure source/i);
    });

    it("rejects changed target, envelope, acquisition, context, base, and local seed identity", async () => {
        for (const [mutationIndex, mutate] of [
            value => { value.target = structuredClone(value.target); },
            value => { value.envelope.candidates[0].msi.sha256 = "f".repeat(64); },
            value => { value.acquisitionRecord.files[0].local.sha256 = "f".repeat(64); },
            value => { value.fixturePreparation.fixtures[0].sha256 = "f".repeat(64); },
            value => { value.baselinePreparation.files[1].sha256 = "f".repeat(64); },
            value => { const baseline = JSON.parse(Buffer.from(value.transport.baselineProof.bytesBase64, "base64"));
                baseline.files[1].sha256 = "f".repeat(64);
                value.transport.baselineProof = retainedTransportDocument("baseline-proof.json", baseline); },
            value => { const result = JSON.parse(Buffer.from(value.transport.result.bytesBase64, "base64"));
                result.target.candidate.sourceSha = "f".repeat(40);
                value.transport.result = retainedTransportDocument("result.json", result); },
            value => { value.seal.context.runId = "2"; },
            value => { value.execution.files[0].path = value.execution.files[1].path; },
            value => { value.host.request.baseImage.sha256 = "f".repeat(64); },
            value => { value.host.request.rows[0].seedFiles.find(file => file.name === "candidate-default.msi")
                .sourcePath = "/opt/myspeed/foreign.msi"; }
        ].entries()) {
            const value = await fixture();
            value.envelope = structuredClone(value.envelope);
            value.acquisitionRecord = structuredClone(value.acquisitionRecord);
            value.fixturePreparation = structuredClone(value.fixturePreparation);
            value.seal = structuredClone(value.seal);
            mutate(value);
            assert.throws(() => createV161PostReleaseMsiHostBinding({target: value.target,
                harnessContext: value.harness, envelope: value.envelope, acquisitionPlan: value.acquisitionPlan,
                acquisitionRecord: value.acquisitionRecord, preparation: value.preparation,
                fixturePreparation: value.fixturePreparation, baselinePreparation: value.baselinePreparation,
                transport: value.transport, execution: value.execution, installedBaseSeal: value.seal,
                hostRequest: value.host.request}), undefined, `mutation ${mutationIndex} was accepted`);
        }
    });

    it("rejects serialized v2 provenance or row mutations even when the caller recomputes an outer hash", async () => {
        const value = await fixture();
        const bound = createV161PostReleaseMsiHostBinding({target: value.target,
            harnessContext: value.harness, envelope: value.envelope, acquisitionPlan: value.acquisitionPlan,
            acquisitionRecord: value.acquisitionRecord, preparation: value.preparation,
            fixturePreparation: value.fixturePreparation, baselinePreparation: value.baselinePreparation,
            transport: value.transport, execution: value.execution, installedBaseSeal: value.seal,
            hostRequest: value.host.request});
        for (const mutate of [
            request => { request.candidateProvenance.harness.runId = "2"; },
            request => { request.candidateProvenance.acquisition.record.files[0].local.bytes += 1; },
            request => { request.candidateProvenance.installedBase.seal.image.sha256 = "f".repeat(64); },
            request => { const execution = decodedExecution(request.rows[0]);
                execution.tools.msiexec.sha256 = "f".repeat(64);
                const bytes = Buffer.from(JSON.stringify(execution)); request.rows[0].executionManifest.bytes = bytes.length;
                request.rows[0].executionManifest.sha256 = createHash("sha256").update(bytes).digest("hex");
                request.rows[0].executionManifest.bytesBase64 = bytes.toString("base64"); },
            request => { const execution = decodedExecution(request.rows[0]);
                execution.fixture.sourceSha = request.sourceSha;
                const bytes = Buffer.from(JSON.stringify(execution));
                request.rows[0].executionManifest.bytes = bytes.length;
                request.rows[0].executionManifest.sha256 = createHash("sha256").update(bytes).digest("hex");
                request.rows[0].executionManifest.bytesBase64 = bytes.toString("base64"); },
            request => { const execution = decodedExecution(request.rows[0]);
                execution.artifacts[0].sha256 = "f".repeat(64);
                const bytes = Buffer.from(JSON.stringify(execution));
                request.rows[0].executionManifest.bytesBase64 = bytes.toString("base64"); },
            request => { const execution = decodedExecution(request.rows[0]);
                execution.artifacts.find(item => item.bindingId === "authentic-1.1.0-msi").exeSha256
                    = "f".repeat(64);
                const bytes = Buffer.from(JSON.stringify(execution));
                request.rows[0].executionManifest.bytes = bytes.length;
                request.rows[0].executionManifest.sha256 = createHash("sha256").update(bytes).digest("hex");
                request.rows[0].executionManifest.bytesBase64 = bytes.toString("base64"); }
        ]) {
            const request = structuredClone(bound.hostRequest); mutate(request);
            assert.throws(() => validateV161PostReleaseMsiHostProvenance(request.candidateProvenance, request));
        }
    });

    /*
     * The whole path in one pure pass: the observed Windows preparation of this run, the request
     * the production builder derives from it, the exact ordered fourteen rows executed against the
     * real guest row runner, and the retained evidence that comes back. No QEMU, no MSI, no guest -
     * every host operation is an injected double, and every document is validated by the same
     * production inspectors the hosted job would use.
     */
    it("carries preparation through the request and the matrix into retained evidence", async () => {
        const value = await fixture();
        const bound = await buildV161PostReleaseMsiLifecycleHostBinding(lifecycleInput(value,
            decodedExecution(value.host.request.rows[0])));
        const request = bound.hostRequest;
        assert.equal(validateWindowsMsiLifecycleHostRequest(request), request);
        assert.equal(request.rows.length, 14);

        const bootstrapBytes = Buffer.from("function Invoke-MyspeedMsiGuestBootstrap {}", "utf8");
        const rowVectors = new Map(request.rows.map(row => {
            const rowRequest = JSON.parse(Buffer.from(row.rowRequest.bytesBase64, "base64"));
            const executionManifest = JSON.parse(Buffer.from(row.executionManifest.bytesBase64, "base64"));
            const handoff = buildWindowsMsiLifecycleRowActivationHandoff({request, row, bootstrapBytes});
            const overlay = {path: row.overlayPath, format: "qcow2",
                backingBaseSha256: request.baseImage.sha256, createNew: true,
                receiptSha256: rowRequest.guest.overlayReceiptSha256};
            const media = {seed: {path: row.seedIsoPath, bytes: "1048576",
                sha256: createHash("sha256").update(`seed-${row.nonce}`).digest("hex"),
                manifestSha256: request.expected.closureSha256, readOnly: true,
                volumeLabel: "MYSPEEDSEED", activationHandoffSha256: handoff.sha256},
            outputBefore: {path: row.outputDiskPath, bytes: "268435456",
                sha256: createHash("sha256").update(`output-${row.nonce}`).digest("hex"),
                createNew: true, volumeLabel: "MYSPEEDOUT"},
            ovmfVarsSha256: request.toolchain.ovmfVarsTemplate.sha256};
            return [row.scenarioIndex, {row, rowRequest, executionManifest, overlay, media}];
        }));

        const calls = [];
        const base = {...request.baseImage, format: "qcow2", virtualBytes: "68719476736",
            sealedReadOnly: true};
        let now = 0;
        const operations = {
            inspectBase: async ({phase}) => { calls.push(`base:${phase}`); return {...base}; },
            createOverlay: async ({row}) => { calls.push(`overlay:${row.scenarioIndex}`);
                return {...rowVectors.get(row.scenarioIndex).overlay}; },
            prepareMedia: async ({row}) => { calls.push(`media:${row.scenarioIndex}`);
                return structuredClone(rowVectors.get(row.scenarioIndex).media); },
            launchRow: async ({row, overlay, media}) => { calls.push(`launch:${row.scenarioIndex}`);
                now += 11 * 60_000;
                const argv = buildWindowsMsiLifecycleQemuArguments({request, row, overlay, media});
                return {argv, argvSha256: createHash("sha256").update(JSON.stringify(argv)).digest("hex"),
                    loaderPath: request.toolchain.runtimeLoader.path,
                    loaderSha256: request.toolchain.runtimeLoader.sha256,
                    qemuPath: request.toolchain.qemu.path, qemuSha256: request.toolchain.qemu.sha256,
                    pid: 3000 + row.scenarioIndex, startTicks: String(7000 + row.scenarioIndex),
                    processGroupId: 3000 + row.scenarioIndex, exitCode: 0, signal: null, timedOut: false,
                    terminationReason: null, cleanupProven: true, treeGone: true,
                    earlyBoot: earlyBoot(row.rowRoot)}; },
            readGuestResult: async ({row}) => { calls.push(`read:${row.scenarioIndex}`);
                const vector = rowVectors.get(row.scenarioIndex);
                const semanticResult = await createWindowsMsiGuestRowSemanticResult({
                    rowRequest: vector.rowRequest, executionManifest: vector.executionManifest});
                return {bytes: Buffer.from(JSON.stringify(semanticResult), "utf8"),
                    outputAfter: {path: row.outputDiskPath, bytes: "268435456",
                        sha256: createHash("sha256").update(`after-${row.nonce}`).digest("hex")}}; },
            cleanupRow: async ({row, groupZero}) => { calls.push(`cleanup:${row.scenarioIndex}`);
                return {groupZeroBeforeRemoval: groupZero, removed: true}; }
        };

        const result = await runWindowsMsiLifecycleHost(request, operations,
            {monotonicMilliseconds: () => now});

        assert.equal(result.status, "completed");
        assert.equal(result.qualifying, false);
        assert.deepEqual(result.releaseGatesCleared, []);
        assert.equal(result.hostRows.length, 14);

        // The exact ordered fourteen of the contract, with its blocking semantics untouched.
        const contract = createWindowsMsiMatrixContract();
        assert.deepEqual(result.hostRows.map(row => row.scenarioId),
            contract.scenarios.map(scenario => scenario.id));
        assert.deepEqual(result.guestEvidence.rows.map(row => row.scenarioIndex),
            contract.scenarios.map((_scenario, index) => index));
        const nonblocking = contract.scenarios.filter(scenario => scenario.blocking === false);
        assert.deepEqual(nonblocking.map(scenario => scenario.id), ["higher-to-lower-stamp-diagnostic"]);
        assert.equal(result.guestInspection.qualifying, false);
        assert.deepEqual(result.guestInspection.releaseGatesCleared, []);

        // Every row got its own fresh overlay, was read only after group zero, and was cleaned up.
        for (const scenarioIndex of contract.scenarios.keys())
            assert.deepEqual(calls.slice(1 + scenarioIndex * 5, 6 + scenarioIndex * 5),
                [`overlay:${scenarioIndex}`, `media:${scenarioIndex}`, `launch:${scenarioIndex}`,
                    `read:${scenarioIndex}`, `cleanup:${scenarioIndex}`]);
        assert.equal(new Set(result.hostRows.map(row => row.overlay.path)).size, 14);
        assert.ok(result.hostRows.every(row => row.overlayCleanup.removed === true
            && row.overlayCleanup.groupZeroBeforeRemoval === true));
        assert.ok(result.hostRows.every(row => row.qemu.treeGone === true
            && row.qemu.cleanupProven === true));
        assert.deepEqual(result.baseAfter, result.baseBefore);

        // The retained evidence carries the raw bytes an independent consumer replays.
        for (const [index, row] of result.guestEvidence.rows.entries()) {
            const vector = rowVectors.get(index);
            assert.equal(row.rowRequest.sha256, vector.row.rowRequest.sha256);
            assert.equal(row.executionManifest.sha256, vector.row.executionManifest.sha256);
            const replayed = JSON.parse(Buffer.from(row.semanticResult.bytesBase64, "base64"));
            assert.equal(replayed.scenarioId, contract.scenarios[index].id);
            assert.equal(replayed.qualifying, false);
            assert.equal(createHash("sha256").update(Buffer.from(row.semanticResult.bytesBase64, "base64"))
                .digest("hex"), row.semanticResult.sha256);
        }

        // Both prerequisites are the digests of inspected retained evidence, not free input.
        for (const [name, field] of [["rollbackCalibration", "rollbackCalibrationSha256"],
            ["oldContainment", "oldContainmentSha256"]]) {
            const record = request.prerequisiteEvidence[name];
            assert.equal(request.expected[field],
                createHash("sha256").update(Buffer.from(record.document.bytesBase64, "base64"))
                    .digest("hex"));
            assert.ok(record.producer === "hosted-run-artifact" || record.producer === "in-guest-calibration");
        }

        // The whole-job budget observation is sealed with the result and clears nothing.
        assert.equal(result.budget.status, "completed");
        assert.equal(result.budget.rowsCompleted, 14);
        assert.equal(result.budget.refusedScenarioIndex, null);
        assert.deepEqual(result.budget.releaseGatesCleared, []);
        assert.equal(result.budget.elapsedMilliseconds, 14 * 11 * 60_000);
        assert.equal(validateCompletedWindowsMsiLifecycleHostResult(result, request), result);
    });
});
