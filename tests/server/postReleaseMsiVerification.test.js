import assert from "node:assert/strict";
import {execFileSync} from "node:child_process";
import {createHash} from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {describe, it} from "node:test";
import {fileURLToPath} from "node:url";

import {createPostReleaseMsiEvidenceFixture, createZipBuffer}
    from "../helpers/post-release-msi-evidence-fixture.mjs";
import {verifyV161PostReleaseMsiEvidence as verifyProductionEvidence, runV161PostReleaseMsiVerificationCli,
    POST_RELEASE_MSI_VERIFICATION_CONSTANTS}
    from "../../scripts/release/post-release-msi-verification.mjs";
import {sealWindowsMsiExecutionClosure, WINDOWS_MSI_CONTROLLER_CLOSURE, WINDOWS_MSI_CONTROLLER_ENTRY,
    WINDOWS_MSI_GUEST_CLOSURE, WINDOWS_MSI_GUEST_ENTRY}
    from "../../scripts/qualification/windows-msi-execution-closure.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI_PATH = path.join(HERE, "..", "..", "scripts", "release", "post-release-msi-verification.mjs");
const EXPECTED_SCENARIO_COUNT = 14;
const NONBLOCKING_SCENARIO_ID = "higher-to-lower-stamp-diagnostic";
const REPOSITORY = "i7Gamer/MySpeed";
const CANDIDATE_SHA = "4fa4dd40a89a062735f98bd85d685e0624ff46a8";
const ORIGINAL_QUALIFICATION_RUN_ID = "34829932391";
const FOREIGN_SHA = "f".repeat(40);
const FOREIGN_DIGEST = "a".repeat(64);

const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
const REPOSITORY_ROOT = path.resolve(HERE, "..", "..");

const sealedClosure = context => {
    const observe = name => { const bytes = fs.readFileSync(path.join(REPOSITORY_ROOT, name));
        return {path: name, bytes: String(bytes.length), sha256: sha256(bytes)}; };
    const closureContext = (({repository, sourceSha, eventSha, runId, runAttempt, nonce}) =>
        ({repository, sourceSha, eventSha, runId, runAttempt, nonce}))(context);
    return sealWindowsMsiExecutionClosure({context: closureContext,
        controller: WINDOWS_MSI_CONTROLLER_CLOSURE.map(observe), guest: WINDOWS_MSI_GUEST_CLOSURE.map(observe),
        controllerEntry: WINDOWS_MSI_CONTROLLER_ENTRY, guestEntry: WINDOWS_MSI_GUEST_ENTRY});
};

/* Test convenience only: production callers must obtain this independently from the Actions API. */
const authenticatedRunRecord = execution => ({id: Number(execution.runId),
    run_attempt: Number(execution.runAttempt), head_sha: execution.sourceSha,
    repository: {full_name: execution.repository}, path: `.github/workflows/${execution.workflow}`});

const verifyV161PostReleaseMsiEvidence = options => verifyProductionEvidence({
    ...options,
    workflowRunRecord: options.workflowRunRecord ?? authenticatedRunRecord(options.expectedExecution)
});

const withTempDir = async fn => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "msi-verify-test-"));
    try {
        return await fn(tempDir);
    } finally {
        fs.rmSync(tempDir, {recursive: true, force: true});
    }
};

describe("v1.6.1 post-release MSI evidence verification", () => {
    it("replays all 14 rows and produces accepted, nonqualifying inspection report", async () => {
        const fixture = await createPostReleaseMsiEvidenceFixture();
        const inspection = await verifyV161PostReleaseMsiEvidence({
            archiveBytes: fixture.archiveBytes,
            artifactMetadata: fixture.artifactMetadata,
            expectedExecution: fixture.expectedExecution
        });

        assert.equal(inspection.schemaVersion, 1);
        assert.equal(inspection.kind, "myspeed-v1.6.1-post-release-msi-evidence-inspection");
        assert.equal(inspection.status, "accepted");
        assert.equal(inspection.qualifying, false);
        assert.equal(inspection.authority, "evidence-inspection-only");
        assert.equal(inspection.candidateSourceSha, CANDIDATE_SHA);
        assert.equal(inspection.harnessSourceSha, fixture.harness.sourceSha);
        assert.equal(inspection.rows.length, EXPECTED_SCENARIO_COUNT);
        assert.deepEqual(inspection.releaseGatesCleared, []);

        const diagnosticRow = inspection.rows.find(row => row.scenarioId === NONBLOCKING_SCENARIO_ID);
        assert.ok(diagnosticRow, "diagnostic row must be present");
        assert.equal(diagnosticRow.blocking, false);
        assert.equal(diagnosticRow.passed, true);
        assert.equal(POST_RELEASE_MSI_VERIFICATION_CONSTANTS.REPOSITORY, REPOSITORY);

        const blockingRows = inspection.rows.filter(row => row.scenarioId !== NONBLOCKING_SCENARIO_ID);
        assert.equal(blockingRows.length, EXPECTED_SCENARIO_COUNT - 1);
        assert.ok(blockingRows.every(row => row.blocking === true && row.passed === true));

        assert.equal(inspection.evidence.hostRequestSha256, sha256(fixture.files.get("msi-host-request.json")));
        assert.equal(inspection.evidence.hostResultSha256, sha256(fixture.files.get("msi-lifecycle-result.json")));
        assert.equal(inspection.artifact.id, String(fixture.artifactMetadata.id));
        assert.equal(inspection.artifact.digest, fixture.artifactMetadata.digest);
        assert.equal(inspection.artifact.name, POST_RELEASE_MSI_VERIFICATION_CONSTANTS.ARTIFACT_NAME);
    });

    it("requires every successful producer member, including empty streams", async () => {
        const fixture = await createPostReleaseMsiEvidenceFixture();
        const expectedMembers = ["msi-host-request.json", "msi-lifecycle-result.json", "controller.stdout",
            "controller.stderr", "transport-summary.json", "msi-execution-closure.json", "evidence-manifest.json"];
        assert.deepEqual([...fixture.files.keys()].sort(), [...expectedMembers].sort());
        assert.equal(fixture.files.get("controller.stdout").length, 0);
        assert.equal(fixture.files.get("controller.stderr").length, 0);
        for (const omitted of expectedMembers) {
            const archiveBytes = createZipBuffer([...fixture.files].filter(([name]) => name !== omitted)
                .map(([name, data]) => ({name, data})));
            await assert.rejects(() => verifyV161PostReleaseMsiEvidence({archiveBytes,
                artifactMetadata: {...fixture.artifactMetadata, size_in_bytes: archiveBytes.length,
                    digest: `sha256:${sha256(archiveBytes)}`}, expectedExecution: fixture.expectedExecution}),
            /successful evidence artifact members differ/i, omitted);
        }
    });

    it("verifies byte-exact equality when both archive and extracted directory are supplied", async () => {
        const fixture = await createPostReleaseMsiEvidenceFixture();
        await withTempDir(async tempDir => {
            const archivePath = path.join(tempDir, "evidence.zip");
            const metaPath = path.join(tempDir, "metadata.json");
            const extractDir = path.join(tempDir, "extracted");
            fs.mkdirSync(extractDir);

            fs.writeFileSync(archivePath, fixture.archiveBytes);
            fs.writeFileSync(metaPath, JSON.stringify(fixture.artifactMetadata));
            for (const [name, data] of fixture.files) {
                fs.writeFileSync(path.join(extractDir, name), data);
            }

            const inspection = await verifyV161PostReleaseMsiEvidence({
                archivePath,
                artifactMetadata: fixture.artifactMetadata,
                expectedExecution: fixture.expectedExecution,
                evidenceDir: extractDir
            });
            assert.equal(inspection.status, "accepted");

            // Negative: alter one file in extracted directory
            fs.writeFileSync(path.join(extractDir, "msi-host-request.json"), Buffer.from("altered"));
            await assert.rejects(
                () => verifyV161PostReleaseMsiEvidence({
                    archivePath,
                    artifactMetadata: fixture.artifactMetadata,
                    expectedExecution: fixture.expectedExecution,
                    evidenceDir: extractDir
                }),
                /extracted directory.*differ/i
            );
        });
    });

    it("runs production CLI successfully with mandatory arguments", async () => {
        const fixture = await createPostReleaseMsiEvidenceFixture();
        await withTempDir(async tempDir => {
            const archivePath = path.join(tempDir, "evidence.zip");
            const metaPath = path.join(tempDir, "metadata.json");
            const runPath = path.join(tempDir, "workflow-run.json");
            const outPath = path.join(tempDir, "inspection.json");

            fs.writeFileSync(archivePath, fixture.archiveBytes);
            fs.writeFileSync(metaPath, JSON.stringify(fixture.artifactMetadata));
            fs.writeFileSync(runPath, JSON.stringify(authenticatedRunRecord(fixture.expectedExecution)));

            const cliArgs = [
                "--evidence-archive", archivePath,
                "--artifact-metadata", metaPath,
                "--workflow-run", runPath,
                "--expected-harness-sha", fixture.harness.sourceSha,
                "--expected-run-id", fixture.harness.runId,
                "--expected-run-attempt", fixture.harness.runAttempt,
                "--expected-artifact-id", String(fixture.artifactMetadata.id),
                "--expected-artifact-name", fixture.artifactMetadata.name,
                "--expected-repository", fixture.harness.repository,
                "--expected-workflow", fixture.expectedExecution.workflow,
                "--output", outPath
            ];

            const result = await runV161PostReleaseMsiVerificationCli(cliArgs);
            assert.equal(result.status, "accepted");
            assert.equal(result.qualifying, false);
            assert.deepEqual(result.releaseGatesCleared, []);

            const written = JSON.parse(fs.readFileSync(outPath, "utf8"));
            assert.equal(written.status, "accepted");

            // Also test via child process
            const stdout = execFileSync("node", [CLI_PATH, ...cliArgs], {encoding: "utf8"});
            const parsedStdout = JSON.parse(stdout);
            assert.equal(parsedStdout.status, "accepted");
            assert.equal(parsedStdout.artifact.id, String(fixture.artifactMetadata.id));
        });
    });

    it("rejects when archive or metadata are omitted in production CLI", async () => {
        const fixture = await createPostReleaseMsiEvidenceFixture();
        await withTempDir(async tempDir => {
            const archivePath = path.join(tempDir, "evidence.zip");
            const metaPath = path.join(tempDir, "metadata.json");
            fs.writeFileSync(archivePath, fixture.archiveBytes);
            fs.writeFileSync(metaPath, JSON.stringify(fixture.artifactMetadata));

            // Missing archive
            await assert.rejects(
                () => runV161PostReleaseMsiVerificationCli([
                    "--artifact-metadata", metaPath,
                    "--expected-harness-sha", fixture.harness.sourceSha,
                    "--expected-run-id", fixture.harness.runId,
                    "--expected-run-attempt", fixture.harness.runAttempt
                ]),
                /evidence-archive.*required/i
            );

            // Missing metadata
            await assert.rejects(
                () => runV161PostReleaseMsiVerificationCli([
                    "--evidence-archive", archivePath,
                    "--expected-harness-sha", fixture.harness.sourceSha,
                    "--expected-run-id", fixture.harness.runId,
                    "--expected-run-attempt", fixture.harness.runAttempt
                ]),
                /artifact-metadata.*required/i
            );

            // Missing expected execution
            await assert.rejects(
                () => runV161PostReleaseMsiVerificationCli([
                    "--evidence-archive", archivePath,
                    "--artifact-metadata", metaPath
                ]),
                /expected.*execution.*required/i
            );
        });
    });

    it("rejects public authentication bypass flags (internalTestSeam, evidenceFiles)", async () => {
        const fixture = await createPostReleaseMsiEvidenceFixture();

        await assert.rejects(
            () => verifyV161PostReleaseMsiEvidence({
                expectedExecution: fixture.expectedExecution,
                internalTestSeam: true,
                evidenceFiles: fixture.files
            }),
            /internal test seams or in-memory evidence maps are not permitted/i
        );

        await assert.rejects(
            () => verifyV161PostReleaseMsiEvidence({
                expectedExecution: fixture.expectedExecution,
                internalTestSeam: true,
                archiveBytes: fixture.archiveBytes,
                artifactMetadata: fixture.artifactMetadata
            }),
            /internal test seams or in-memory evidence maps are not permitted/i
        );
    });

    it("requires an independently supplied authenticated workflow attempt record", async () => {
        const fixture = await createPostReleaseMsiEvidenceFixture();
        await assert.rejects(
            () => verifyProductionEvidence({archiveBytes: fixture.archiveBytes,
                artifactMetadata: fixture.artifactMetadata, expectedExecution: fixture.expectedExecution}),
            /workflow run record must be an object/i
        );
    });

    it("rejects self-authenticated metadata copied inside the archive", async () => {
        const fixture = await createPostReleaseMsiEvidenceFixture({
            mutateFiles: files => {
                files.push({name: "copied-metadata.json", data: Buffer.from("fake-meta")});
            }
        });

        // Archive with unexpected file rejected
        await assert.rejects(
            () => verifyV161PostReleaseMsiEvidence({
                archiveBytes: fixture.archiveBytes,
                artifactMetadata: fixture.artifactMetadata,
                expectedExecution: fixture.expectedExecution
            }),
            /unexpected.*archive member/i
        );
    });

    it("rejects tampered archive digest, length, expired or foreign metadata", async () => {
        const fixture = await createPostReleaseMsiEvidenceFixture();

        // Tampered digest
        const badDigestMeta = {...fixture.artifactMetadata, digest: `sha256:${FOREIGN_DIGEST}`};
        await assert.rejects(
            () => verifyV161PostReleaseMsiEvidence({
                archiveBytes: fixture.archiveBytes,
                artifactMetadata: badDigestMeta,
                expectedExecution: fixture.expectedExecution
            }),
            /digest.*mismatch/i
        );

        // Tampered size
        const badSizeMeta = {...fixture.artifactMetadata, size_in_bytes: fixture.archiveBytes.length + 1};
        await assert.rejects(
            () => verifyV161PostReleaseMsiEvidence({
                archiveBytes: fixture.archiveBytes,
                artifactMetadata: badSizeMeta,
                expectedExecution: fixture.expectedExecution
            }),
            /size.*mismatch/i
        );

        // Expired artifact
        const expiredMeta = {...fixture.artifactMetadata, expired: true};
        await assert.rejects(
            () => verifyV161PostReleaseMsiEvidence({
                archiveBytes: fixture.archiveBytes,
                artifactMetadata: expiredMeta,
                expectedExecution: fixture.expectedExecution
            }),
            /expired/i
        );

        const unknownExpiryMeta = {...fixture.artifactMetadata};
        delete unknownExpiryMeta.expired;
        await assert.rejects(
            () => verifyV161PostReleaseMsiEvidence({archiveBytes: fixture.archiveBytes,
                artifactMetadata: unknownExpiryMeta, expectedExecution: fixture.expectedExecution}),
            /unexpired/i
        );

        // Wrong artifact name
        const wrongNameMeta = {...fixture.artifactMetadata, name: "foreign-evidence-name"};
        await assert.rejects(
            () => verifyV161PostReleaseMsiEvidence({
                archiveBytes: fixture.archiveBytes,
                artifactMetadata: wrongNameMeta,
                expectedExecution: fixture.expectedExecution
            }),
            /artifact name/i
        );

        // Workflow run ID mismatch in metadata
        const wrongRunIdMeta = {
            ...fixture.artifactMetadata,
            workflow_run: {...fixture.artifactMetadata.workflow_run, id: 999999}
        };
        await assert.rejects(
            () => verifyV161PostReleaseMsiEvidence({
                archiveBytes: fixture.archiveBytes,
                artifactMetadata: wrongRunIdMeta,
                expectedExecution: fixture.expectedExecution
            }),
            /run ID.*differ/i
        );

        // Workflow head SHA mismatch in metadata
        const wrongHeadShaMeta = {
            ...fixture.artifactMetadata,
            workflow_run: {...fixture.artifactMetadata.workflow_run, head_sha: FOREIGN_SHA}
        };
        await assert.rejects(
            () => verifyV161PostReleaseMsiEvidence({
                archiveBytes: fixture.archiveBytes,
                artifactMetadata: wrongHeadShaMeta,
                expectedExecution: fixture.expectedExecution
            }),
            /harness.*differ/i
        );
    });

    it("rejects foreign expected execution bindings (runId, runAttempt, artifactId, workflow)", async () => {
        const fixture = await createPostReleaseMsiEvidenceFixture();

        // Mismatched expected run attempt
        await assert.rejects(
            () => verifyV161PostReleaseMsiEvidence({
                archiveBytes: fixture.archiveBytes,
                artifactMetadata: fixture.artifactMetadata,
                expectedExecution: {...fixture.expectedExecution, runAttempt: "99"}
            }),
            /(?:run ID or attempt|run attempt) differs/i
        );

        // Mismatched expected artifact ID
        await assert.rejects(
            () => verifyV161PostReleaseMsiEvidence({
                archiveBytes: fixture.archiveBytes,
                artifactMetadata: fixture.artifactMetadata,
                expectedExecution: {...fixture.expectedExecution, artifactId: "99999999"}
            }),
            /artifact ID mismatch/i
        );

        // Mismatched expected artifact name
        await assert.rejects(
            () => verifyV161PostReleaseMsiEvidence({
                archiveBytes: fixture.archiveBytes,
                artifactMetadata: fixture.artifactMetadata,
                expectedExecution: {...fixture.expectedExecution, artifactName: "myspeed-v1.6.1-post-release-msi-evidence"}
            }),
            /expected artifact name differs/i
        );

        // Mismatched expected digest
        await assert.rejects(
            () => verifyV161PostReleaseMsiEvidence({
                archiveBytes: fixture.archiveBytes,
                artifactMetadata: fixture.artifactMetadata,
                expectedExecution: {...fixture.expectedExecution, archiveDigest: `sha256:${FOREIGN_DIGEST}`}
            }),
            /artifact digest mismatch/i
        );
    });

    it("validates separate workflow run record when supplied", async () => {
        const fixture = await createPostReleaseMsiEvidenceFixture();
        const validRunRecord = {
            id: Number(fixture.harness.runId),
            run_attempt: Number(fixture.harness.runAttempt),
            head_sha: fixture.harness.sourceSha,
            repository: {full_name: fixture.harness.repository},
            path: ".github/workflows/post-release-msi-lifecycle.yml"
        };

        const inspection = await verifyV161PostReleaseMsiEvidence({
            archiveBytes: fixture.archiveBytes,
            artifactMetadata: fixture.artifactMetadata,
            expectedExecution: fixture.expectedExecution,
            workflowRunRecord: validRunRecord
        });
        assert.equal(inspection.status, "accepted");

        // Mismatched attempt in run record
        const badAttemptRecord = {...validRunRecord, run_attempt: 42};
        await assert.rejects(
            () => verifyV161PostReleaseMsiEvidence({
                archiveBytes: fixture.archiveBytes,
                artifactMetadata: fixture.artifactMetadata,
                expectedExecution: fixture.expectedExecution,
                workflowRunRecord: badAttemptRecord
            }),
            /workflow run record attempt differs/i
        );

        await assert.rejects(
            () => verifyV161PostReleaseMsiEvidence({archiveBytes: fixture.archiveBytes,
                artifactMetadata: fixture.artifactMetadata, expectedExecution: fixture.expectedExecution,
                workflowRunRecord: {...validRunRecord, path: ".github/workflows/foreign.yml"}}),
            /workflow run record path differs/i
        );

        const inProgress = {...validRunRecord, status: "in_progress", conclusion: null};
        const inProgressInspection = await verifyV161PostReleaseMsiEvidence({archiveBytes: fixture.archiveBytes,
            artifactMetadata: fixture.artifactMetadata, expectedExecution: fixture.expectedExecution,
            workflowRunRecord: inProgress});
        assert.equal(inProgressInspection.status, "accepted");
    });

    it("rejects coercive expected and API identity values", async () => {
        const fixture = await createPostReleaseMsiEvidenceFixture();
        for (const [field, value] of [["runId", [fixture.expectedExecution.runId]],
            ["runAttempt", {value: fixture.expectedExecution.runAttempt}],
            ["artifactId", [fixture.expectedExecution.artifactId]]]) {
            await assert.rejects(() => verifyV161PostReleaseMsiEvidence({archiveBytes: fixture.archiveBytes,
                artifactMetadata: fixture.artifactMetadata,
                expectedExecution: {...fixture.expectedExecution, [field]: value}}), /must be a string/i);
        }
        for (const mutate of [
            metadata => { metadata.id = [metadata.id]; },
            metadata => { metadata.workflow_run.id = {value: metadata.workflow_run.id}; }
        ]) {
            const metadata = structuredClone(fixture.artifactMetadata);
            mutate(metadata);
            await assert.rejects(() => verifyV161PostReleaseMsiEvidence({archiveBytes: fixture.archiveBytes,
                artifactMetadata: metadata, expectedExecution: fixture.expectedExecution}), /must be a safe integer/i);
        }
        const record = authenticatedRunRecord(fixture.expectedExecution);
        record.run_attempt = [record.run_attempt];
        await assert.rejects(() => verifyV161PostReleaseMsiEvidence({archiveBytes: fixture.archiveBytes,
            artifactMetadata: fixture.artifactMetadata, expectedExecution: fixture.expectedExecution,
            workflowRunRecord: record}), /must be a safe integer/i);
    });

    it("rejects path traversal, absolute paths, and duplicate entries in archive", async () => {
        const fixture = await createPostReleaseMsiEvidenceFixture();

        // Traversal path
        const traversalZip = createZipBuffer([
            {name: "../traversal.json", data: Buffer.from("{}")},
            {name: "msi-host-request.json", data: fixture.files.get("msi-host-request.json")},
            {name: "msi-lifecycle-result.json", data: fixture.files.get("msi-lifecycle-result.json")}
        ]);
        const metaTraversal = {...fixture.artifactMetadata, size_in_bytes: traversalZip.length,
            digest: `sha256:${sha256(traversalZip)}`};
        await assert.rejects(
            () => verifyV161PostReleaseMsiEvidence({
                archiveBytes: traversalZip,
                artifactMetadata: metaTraversal,
                expectedExecution: fixture.expectedExecution
            }),
            /confinement|traversal|path/i
        );

        // Absolute path
        const absoluteZip = createZipBuffer([
            {name: "/absolute.json", data: Buffer.from("{}")},
            {name: "msi-host-request.json", data: fixture.files.get("msi-host-request.json")},
            {name: "msi-lifecycle-result.json", data: fixture.files.get("msi-lifecycle-result.json")}
        ]);
        const metaAbsolute = {...fixture.artifactMetadata, size_in_bytes: absoluteZip.length,
            digest: `sha256:${sha256(absoluteZip)}`};
        await assert.rejects(
            () => verifyV161PostReleaseMsiEvidence({
                archiveBytes: absoluteZip,
                artifactMetadata: metaAbsolute,
                expectedExecution: fixture.expectedExecution
            }),
            /confinement|path/i
        );

        // Duplicate entry
        const duplicateZip = createZipBuffer([
            {name: "msi-host-request.json", data: fixture.files.get("msi-host-request.json")},
            {name: "msi-host-request.json", data: fixture.files.get("msi-host-request.json")},
            {name: "msi-lifecycle-result.json", data: fixture.files.get("msi-lifecycle-result.json")}
        ]);
        const metaDup = {...fixture.artifactMetadata, size_in_bytes: duplicateZip.length,
            digest: `sha256:${sha256(duplicateZip)}`};
        await assert.rejects(
            () => verifyV161PostReleaseMsiEvidence({
                archiveBytes: duplicateZip,
                artifactMetadata: metaDup,
                expectedExecution: fixture.expectedExecution
            }),
            /duplicate|collision/i
        );
    });

    it("rejects symbolic links, directories, encryption, and unsupported compression in archive", async () => {
        const fixture = await createPostReleaseMsiEvidenceFixture();

        // Symlink member (Unix mode 0120777)
        const symlinkZip = createZipBuffer([
            {name: "msi-host-request.json", data: fixture.files.get("msi-host-request.json")},
            {name: "msi-lifecycle-result.json", data: fixture.files.get("msi-lifecycle-result.json")},
            {name: "controller.stdout", data: Buffer.from("symlink-target"), externalAttr: ((0o120777 << 16) >>> 0)}
        ]);
        const metaSymlink = {...fixture.artifactMetadata, size_in_bytes: symlinkZip.length,
            digest: `sha256:${sha256(symlinkZip)}`};
        await assert.rejects(
            () => verifyV161PostReleaseMsiEvidence({
                archiveBytes: symlinkZip,
                artifactMetadata: metaSymlink,
                expectedExecution: fixture.expectedExecution
            }),
            /symbolic link/i
        );

        // Encrypted member (flag bit 0)
        const encryptedZip = createZipBuffer([
            {name: "msi-host-request.json", data: fixture.files.get("msi-host-request.json")},
            {name: "msi-lifecycle-result.json", data: fixture.files.get("msi-lifecycle-result.json"), flags: 1}
        ]);
        const metaEncrypted = {...fixture.artifactMetadata, size_in_bytes: encryptedZip.length,
            digest: `sha256:${sha256(encryptedZip)}`};
        await assert.rejects(
            () => verifyV161PostReleaseMsiEvidence({
                archiveBytes: encryptedZip,
                artifactMetadata: metaEncrypted,
                expectedExecution: fixture.expectedExecution
            }),
            /encrypted/i
        );

        // Unsupported compression method (method 9)
        const unsupportedZip = createZipBuffer([
            {name: "msi-host-request.json", data: fixture.files.get("msi-host-request.json")},
            {name: "msi-lifecycle-result.json", data: fixture.files.get("msi-lifecycle-result.json"), method: 9}
        ]);
        const metaUnsupported = {...fixture.artifactMetadata, size_in_bytes: unsupportedZip.length,
            digest: `sha256:${sha256(unsupportedZip)}`};
        await assert.rejects(
            () => verifyV161PostReleaseMsiEvidence({
                archiveBytes: unsupportedZip,
                artifactMetadata: metaUnsupported,
                expectedExecution: fixture.expectedExecution
            }),
            /unsupported compression method/i
        );
    });

    it("rejects decompression bombs, declared size overflow, and aggregate size overflow", async () => {
        const fixture = await createPostReleaseMsiEvidenceFixture();

        // Declared uncompressed size exceeding 16 MiB bound
        const declaredOverLimitZip = createZipBuffer([
            {name: "msi-host-request.json", data: fixture.files.get("msi-host-request.json")},
            {name: "msi-lifecycle-result.json", data: fixture.files.get("msi-lifecycle-result.json"), declaredSize: 16_777_217}
        ]);
        const metaDeclared = {...fixture.artifactMetadata, size_in_bytes: declaredOverLimitZip.length,
            digest: `sha256:${sha256(declaredOverLimitZip)}`};
        await assert.rejects(
            () => verifyV161PostReleaseMsiEvidence({
                archiveBytes: declaredOverLimitZip,
                artifactMetadata: metaDeclared,
                expectedExecution: fixture.expectedExecution
            }),
            /declared size exceeds maximum bound/i
        );

        // Small compressed data that expands past declared uncompressed size (bomb)
        const raw500Bytes = Buffer.alloc(500, "a");
        const bombZip = createZipBuffer([
            {name: "msi-host-request.json", data: fixture.files.get("msi-host-request.json")},
            {
                name: "msi-lifecycle-result.json",
                data: raw500Bytes,
                deflate: true,
                declaredSize: 50 // claims 50 bytes, expands to 500 bytes
            }
        ]);
        const metaBomb = {...fixture.artifactMetadata, size_in_bytes: bombZip.length,
            digest: `sha256:${sha256(bombZip)}`};
        await assert.rejects(
            () => verifyV161PostReleaseMsiEvidence({
                archiveBytes: bombZip,
                artifactMetadata: metaBomb,
                expectedExecution: fixture.expectedExecution
            }),
            /decompression failed|differs from declared/i
        );
    });

    it("rejects a forged central CRC before accepting a successful artifact", async () => {
        const fixture = await createPostReleaseMsiEvidenceFixture();
        const descriptorZip = createZipBuffer([
            {name: "msi-host-request.json", data: fixture.files.get("msi-host-request.json"), deflate: true,
                dataDescriptor: true},
            {name: "msi-lifecycle-result.json", data: fixture.files.get("msi-lifecycle-result.json"), deflate: true,
                dataDescriptor: true}
        ]);
        const descriptorMetadata = {...fixture.artifactMetadata, size_in_bytes: descriptorZip.length,
            digest: `sha256:${sha256(descriptorZip)}`};
        await assert.rejects(() => verifyV161PostReleaseMsiEvidence({archiveBytes: descriptorZip,
            artifactMetadata: descriptorMetadata, expectedExecution: fixture.expectedExecution}),
        /successful evidence artifact members differ/i);

        const forged = Buffer.from(descriptorZip);
        const centralOffset = forged.lastIndexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
        assert.ok(centralOffset >= 0, "fixture must carry a central directory entry");
        forged.writeUInt32LE(0, centralOffset + 16);
        await assert.rejects(() => verifyV161PostReleaseMsiEvidence({archiveBytes: forged,
            artifactMetadata: {...descriptorMetadata, digest: `sha256:${sha256(forged)}`},
            expectedExecution: fixture.expectedExecution}), /CRC|local header size|data descriptor|successful evidence artifact members differ/i);
    });

    it("rejects member count below minimum, above maximum, and truncated archive", async () => {
        const fixture = await createPostReleaseMsiEvidenceFixture();

        // Member count < 2 (only 1 member)
        const singleFileZip = createZipBuffer([
            {name: "msi-host-request.json", data: fixture.files.get("msi-host-request.json")}
        ]);
        const metaSingle = {...fixture.artifactMetadata, size_in_bytes: singleFileZip.length,
            digest: `sha256:${sha256(singleFileZip)}`};
        await assert.rejects(
            () => verifyV161PostReleaseMsiEvidence({
                archiveBytes: singleFileZip,
                artifactMetadata: metaSingle,
                expectedExecution: fixture.expectedExecution
            }),
            /member count must be between/i
        );

        // Truncated archive (missing EOCD)
        const truncatedBytes = fixture.archiveBytes.subarray(0, fixture.archiveBytes.length - 30);
        const metaTruncated = {...fixture.artifactMetadata, size_in_bytes: truncatedBytes.length,
            digest: `sha256:${sha256(truncatedBytes)}`};
        await assert.rejects(
            () => verifyV161PostReleaseMsiEvidence({
                archiveBytes: truncatedBytes,
                artifactMetadata: metaTruncated,
                expectedExecution: fixture.expectedExecution
            }),
            /End of Central Directory record not found|truncated/i
        );
    });

    /*
     * The shared fixture builds evidence-manifest.json before mutateFiles runs, so a test that adds
     * msi-lifecycle-progress.json to the archive produces a manifest that does not name it. The workflow
     * never packages that shape: its inventory is built from the files actually present in the transport
     * root. These cases package the way the workflow does, so the consumer's progress rules are proven on a
     * well-formed producer archive rather than on one an earlier member-set check would reject first.
     */
    const packageLikeWorkflow = (fixture, {includeResult = true, progressBytes = null} = {}) => {
        const present = new Map();
        for (const name of ["msi-host-request.json", "controller.stdout", "controller.stderr",
            "transport-summary.json", "msi-execution-closure.json"])
            present.set(name, fixture.files.get(name));
        if (includeResult)
            present.set("msi-lifecycle-result.json", fixture.files.get("msi-lifecycle-result.json"));
        if (progressBytes) present.set("msi-lifecycle-progress.json", progressBytes);
        // The workflow's own inventory candidate order, kept in step with it by the lifecycle workflow test.
        const inventory = ["msi-host-request.json", "msi-lifecycle-result.json",
            "msi-lifecycle-progress.json", "transport-summary.json", "msi-execution-closure.json",
            "controller.stdout", "controller.stderr"].flatMap(name => present.has(name)
            ? [{name, bytes: String(present.get(name).length), sha256: sha256(present.get(name))}] : []);
        present.set("evidence-manifest.json", Buffer.from(`${JSON.stringify({schemaVersion: 1,
            kind: "myspeed-windows-msi-lifecycle-evidence-manifest", status: "observed", qualifying: false,
            repository: fixture.expectedExecution.repository, sourceSha: fixture.expectedExecution.sourceSha,
            runId: fixture.expectedExecution.runId, runAttempt: fixture.expectedExecution.runAttempt,
            nonce: fixture.request.context.nonce, files: inventory, releaseGatesCleared: []})}\n`));
        const archiveBytes = createZipBuffer([...present].map(([name, data]) => ({name, data})));
        return {archiveBytes, inventoryNames: inventory.map(entry => entry.name),
            artifactMetadata: {...fixture.artifactMetadata, size_in_bytes: archiveBytes.length,
                digest: `sha256:${sha256(archiveBytes)}`}};
    };

    const failureProgressBytes = Buffer.from(`${JSON.stringify({schemaVersion: 1,
        kind: "myspeed-windows-msi-lifecycle-progress", status: "failed", qualifying: false,
        releaseGatesCleared: [], stage: "row", budget: {status: "refused", rowsCompleted: 3}})}\n`);

    it("accepts the member set the lifecycle workflow actually packages for a completed matrix", async () => {
        const fixture = await createPostReleaseMsiEvidenceFixture({includeEvidenceManifest: true});
        const packed = packageLikeWorkflow(fixture);
        // A completed matrix writes the result and no progress, so the inventory names six members.
        assert.deepEqual(packed.inventoryNames, ["msi-host-request.json", "msi-lifecycle-result.json",
            "transport-summary.json", "msi-execution-closure.json", "controller.stdout", "controller.stderr"]);
        // The mandatory empty streams reach the consumer as zero-byte members rather than being dropped.
        for (const stream of ["controller.stdout", "controller.stderr"])
            assert.equal(fixture.files.get(stream).length, 0, stream);
        const inspection = await verifyV161PostReleaseMsiEvidence({archiveBytes: packed.archiveBytes,
            artifactMetadata: packed.artifactMetadata, expectedExecution: fixture.expectedExecution});
        assert.equal(inspection.status, "accepted");
        assert.equal(inspection.rows.length, EXPECTED_SCENARIO_COUNT);
    });

    it("refuses a workflow-packaged run that retained progress instead of a finished matrix", async () => {
        const fixture = await createPostReleaseMsiEvidenceFixture({includeEvidenceManifest: true});

        // An unsuccessful run writes progress and never a result, so the inventory names progress in the
        // result's place. The consumer must say the finished matrix is missing, not accept the archive.
        const unfinished = packageLikeWorkflow(fixture,
            {includeResult: false, progressBytes: failureProgressBytes});
        assert.ok(unfinished.inventoryNames.includes("msi-lifecycle-progress.json"));
        assert.ok(!unfinished.inventoryNames.includes("msi-lifecycle-result.json"));
        await assert.rejects(() => verifyV161PostReleaseMsiEvidence({archiveBytes: unfinished.archiveBytes,
            artifactMetadata: unfinished.artifactMetadata, expectedExecution: fixture.expectedExecution}),
        /members differ: missing msi-lifecycle-result\.json/iu);

        // A result beside failure progress is contradictory; the rule must fire on a well-formed archive.
        const contradictory = packageLikeWorkflow(fixture, {progressBytes: failureProgressBytes});
        assert.equal(contradictory.inventoryNames.length, 7);
        await assert.rejects(() => verifyV161PostReleaseMsiEvidence({archiveBytes: contradictory.archiveBytes,
            artifactMetadata: contradictory.artifactMetadata, expectedExecution: fixture.expectedExecution}),
        /completed evidence must not retain failure progress/iu);
    });

    it("rejects contradictory progress in msi-lifecycle-progress.json", async () => {
        const fixture = await createPostReleaseMsiEvidenceFixture();

        // Progress with status: 'failed'
        const failedProgressZip = createZipBuffer([
            {name: "msi-host-request.json", data: fixture.files.get("msi-host-request.json")},
            {name: "msi-lifecycle-result.json", data: fixture.files.get("msi-lifecycle-result.json")},
            {name: "msi-lifecycle-progress.json", data: Buffer.from(JSON.stringify({status: "failed", failureCategory: "timeout"}))}
        ]);
        const metaFailed = {...fixture.artifactMetadata, size_in_bytes: failedProgressZip.length,
            digest: `sha256:${sha256(failedProgressZip)}`};
        await assert.rejects(
            () => verifyV161PostReleaseMsiEvidence({
                archiveBytes: failedProgressZip,
                artifactMetadata: metaFailed,
                expectedExecution: fixture.expectedExecution
            }),
            /completed evidence must not retain failure progress|successful evidence artifact members differ/i
        );

        // Progress with refusedScenarioIndex
        const refusedProgressZip = createZipBuffer([
            {name: "msi-host-request.json", data: fixture.files.get("msi-host-request.json")},
            {name: "msi-lifecycle-result.json", data: fixture.files.get("msi-lifecycle-result.json")},
            {name: "msi-lifecycle-progress.json", data: Buffer.from(JSON.stringify({status: "completed", refusedScenarioIndex: 2}))}
        ]);
        const metaRefused = {...fixture.artifactMetadata, size_in_bytes: refusedProgressZip.length,
            digest: `sha256:${sha256(refusedProgressZip)}`};
        await assert.rejects(
            () => verifyV161PostReleaseMsiEvidence({
                archiveBytes: refusedProgressZip,
                artifactMetadata: metaRefused,
                expectedExecution: fixture.expectedExecution
            }),
            /completed evidence must not retain failure progress|successful evidence artifact members differ/i
        );
    });

    it("rejects contradictory transport-summary.json and text streams over 1 MiB", async () => {
        const fixture = await createPostReleaseMsiEvidenceFixture();

        // Transport summary with accepted: false
        const unacceptedSummaryZip = createZipBuffer([
            {name: "msi-host-request.json", data: fixture.files.get("msi-host-request.json")},
            {name: "msi-lifecycle-result.json", data: fixture.files.get("msi-lifecycle-result.json")},
            {
                name: "transport-summary.json",
                data: Buffer.from(JSON.stringify({
                    schemaVersion: 1,
                    kind: "myspeed-windows-msi-lifecycle-transport-summary",
                    accepted: false,
                    controllerExit: 1,
                    qualifying: false,
                    releaseGatesCleared: [],
                    rowsCompleted: 14,
                    refusedScenarioIndex: null,
                    result: {bytes: fixture.files.get("msi-lifecycle-result.json").length, sha256: sha256(fixture.files.get("msi-lifecycle-result.json"))}
                }))
            }
        ]);
        const metaUnaccepted = {...fixture.artifactMetadata, size_in_bytes: unacceptedSummaryZip.length,
            digest: `sha256:${sha256(unacceptedSummaryZip)}`};
        await assert.rejects(
            () => verifyV161PostReleaseMsiEvidence({
                archiveBytes: unacceptedSummaryZip,
                artifactMetadata: metaUnaccepted,
                expectedExecution: fixture.expectedExecution
            }),
            /transport summary|successful evidence artifact members differ/i
        );

        // Stream exceeding 1 MiB bound
        const largeStreamZip = createZipBuffer([
            {name: "msi-host-request.json", data: fixture.files.get("msi-host-request.json")},
            {name: "msi-lifecycle-result.json", data: fixture.files.get("msi-lifecycle-result.json")},
            {name: "controller.stdout", data: Buffer.alloc(1_048_577, "x")}
        ]);
        const metaLargeStream = {...fixture.artifactMetadata, size_in_bytes: largeStreamZip.length,
            digest: `sha256:${sha256(largeStreamZip)}`};
        await assert.rejects(
            () => verifyV161PostReleaseMsiEvidence({
                archiveBytes: largeStreamZip,
                artifactMetadata: metaLargeStream,
                expectedExecution: fixture.expectedExecution
            }),
            /exceeds 1 MiB bound/i
        );
    });

    it("rejects invalid inner inventory manifest (empty files, duplicate, mismatched hash)", async () => {
        const fixture = await createPostReleaseMsiEvidenceFixture();

        // Manifest with empty files: []
        const emptyFilesManifestZip = createZipBuffer([
            {name: "msi-host-request.json", data: fixture.files.get("msi-host-request.json")},
            {name: "msi-lifecycle-result.json", data: fixture.files.get("msi-lifecycle-result.json")},
            {
                name: "evidence-manifest.json",
                data: Buffer.from(JSON.stringify({
                    schemaVersion: 1,
                    kind: "myspeed-v1.6.1-post-release-msi-evidence",
                    status: "completed",
                    qualifying: false,
                    releaseGatesCleared: [],
                    repository: fixture.expectedExecution.repository,
                    runId: fixture.expectedExecution.runId,
                    runAttempt: fixture.expectedExecution.runAttempt,
                    harnessSourceSha: fixture.expectedExecution.sourceSha,
                    files: []
                }))
            }
        ]);
        const metaEmpty = {...fixture.artifactMetadata, size_in_bytes: emptyFilesManifestZip.length,
            digest: `sha256:${sha256(emptyFilesManifestZip)}`};
        await assert.rejects(
            () => verifyV161PostReleaseMsiEvidence({
                archiveBytes: emptyFilesManifestZip,
                artifactMetadata: metaEmpty,
                expectedExecution: fixture.expectedExecution
            }),
            /evidence manifest|successful evidence artifact members differ/i
        );

        // Manifest that lists itself
        const selfReferencingManifestZip = createZipBuffer([
            {name: "msi-host-request.json", data: fixture.files.get("msi-host-request.json")},
            {name: "msi-lifecycle-result.json", data: fixture.files.get("msi-lifecycle-result.json")},
            {
                name: "evidence-manifest.json",
                data: Buffer.from(JSON.stringify({
                    schemaVersion: 1,
                    kind: "myspeed-v1.6.1-post-release-msi-evidence",
                    status: "completed",
                    qualifying: false,
                    releaseGatesCleared: [],
                    repository: fixture.expectedExecution.repository,
                    runId: fixture.expectedExecution.runId,
                    runAttempt: fixture.expectedExecution.runAttempt,
                    harnessSourceSha: fixture.expectedExecution.sourceSha,
                    files: [
                        {name: "msi-host-request.json", bytes: fixture.files.get("msi-host-request.json").length, sha256: sha256(fixture.files.get("msi-host-request.json"))},
                        {name: "evidence-manifest.json", bytes: 10, sha256: "0".repeat(64)}
                    ]
                }))
            }
        ]);
        const metaSelf = {...fixture.artifactMetadata, size_in_bytes: selfReferencingManifestZip.length,
            digest: `sha256:${sha256(selfReferencingManifestZip)}`};
        await assert.rejects(
            () => verifyV161PostReleaseMsiEvidence({
                archiveBytes: selfReferencingManifestZip,
                artifactMetadata: metaSelf,
                expectedExecution: fixture.expectedExecution
            }),
            /evidence manifest|successful evidence artifact members differ/i
        );
    });

    it("accepts the actual producer sidecars and rejects an unsealed closure", async () => {
        const fixture = await createPostReleaseMsiEvidenceFixture({includeEvidenceManifest: true});
        const requestBytes = fixture.files.get("msi-host-request.json");
        const resultBytes = fixture.files.get("msi-lifecycle-result.json");
        const stdoutBytes = Buffer.from("controller started\ncontroller completed successfully\n");
        const stderrBytes = Buffer.from("");
        const closureBytes = Buffer.from(`${JSON.stringify(sealedClosure(fixture.request.context))}\n`);
        const summaryBytes = Buffer.from(JSON.stringify({
            schemaVersion: 1,
            kind: "myspeed-windows-msi-lifecycle-transport-summary",
            status: "observed",
            accepted: true,
            controllerExit: 0,
            qualifying: false,
            releaseGatesCleared: [],
            resultPresent: true,
            progressPresent: false,
            progress: null,
            rowsCompleted: 14,
            refusedScenarioIndex: null,
            result: {bytes: resultBytes.length, sha256: sha256(resultBytes)},
            hostRequestPresent: true,
            hostRequest: {bytes: requestBytes.length, sha256: sha256(requestBytes)},
            streams: [
                {name: "controller.stdout", bytes: stdoutBytes.length, sha256: sha256(stdoutBytes)},
                {name: "controller.stderr", bytes: stderrBytes.length, sha256: sha256(stderrBytes)}
            ]
        }));

        const manifestBytes = Buffer.from(JSON.stringify({
            schemaVersion: 1,
            kind: "myspeed-windows-msi-lifecycle-evidence-manifest",
            status: "observed",
            qualifying: false,
            releaseGatesCleared: [],
            repository: fixture.expectedExecution.repository,
            runId: fixture.expectedExecution.runId,
            runAttempt: fixture.expectedExecution.runAttempt,
            sourceSha: fixture.expectedExecution.sourceSha,
            nonce: fixture.request.context.nonce,
            files: [
                {name: "msi-host-request.json", bytes: String(requestBytes.length), sha256: sha256(requestBytes)},
                {name: "msi-lifecycle-result.json", bytes: String(resultBytes.length), sha256: sha256(resultBytes)},
                {name: "controller.stdout", bytes: String(stdoutBytes.length), sha256: sha256(stdoutBytes)},
                {name: "controller.stderr", bytes: String(stderrBytes.length), sha256: sha256(stderrBytes)},
                {name: "transport-summary.json", bytes: String(summaryBytes.length), sha256: sha256(summaryBytes)},
                {name: "msi-execution-closure.json", bytes: String(closureBytes.length), sha256: sha256(closureBytes)}
            ]
        }));

        const fullZip = createZipBuffer([
            {name: "msi-host-request.json", data: requestBytes},
            {name: "msi-lifecycle-result.json", data: resultBytes},
            {name: "controller.stdout", data: stdoutBytes},
            {name: "controller.stderr", data: stderrBytes},
            {name: "transport-summary.json", data: summaryBytes},
            {name: "msi-execution-closure.json", data: closureBytes},
            {name: "evidence-manifest.json", data: manifestBytes}
        ]);

        const fullMeta = {
            ...fixture.artifactMetadata,
            size_in_bytes: fullZip.length,
            digest: `sha256:${sha256(fullZip)}`
        };

        const inspection = await verifyV161PostReleaseMsiEvidence({
            archiveBytes: fullZip,
            artifactMetadata: fullMeta,
            expectedExecution: fixture.expectedExecution
        });

        assert.equal(inspection.status, "accepted");
        assert.equal(inspection.rows.length, EXPECTED_SCENARIO_COUNT);

        const fakeClosureBytes = Buffer.from('{"files":[]}');
        const fakeManifest = JSON.parse(manifestBytes);
        const closureInventory = fakeManifest.files.find(file => file.name === "msi-execution-closure.json");
        closureInventory.bytes = String(fakeClosureBytes.length);
        closureInventory.sha256 = sha256(fakeClosureBytes);
        const fakeClosureZip = createZipBuffer([
            {name: "msi-host-request.json", data: requestBytes},
            {name: "msi-lifecycle-result.json", data: resultBytes},
            {name: "controller.stdout", data: stdoutBytes},
            {name: "controller.stderr", data: stderrBytes},
            {name: "transport-summary.json", data: summaryBytes},
            {name: "msi-execution-closure.json", data: fakeClosureBytes},
            {name: "evidence-manifest.json", data: Buffer.from(JSON.stringify(fakeManifest))}
        ]);
        await assert.rejects(() => verifyV161PostReleaseMsiEvidence({archiveBytes: fakeClosureZip,
            artifactMetadata: {...fullMeta, size_in_bytes: fakeClosureZip.length,
                digest: `sha256:${sha256(fakeClosureZip)}`}, expectedExecution: fixture.expectedExecution}),
        /MSI execution closure differs/i);
    });

    it("rejects when historical qualification and current execution identities are confused", async () => {
        const fixture = await createPostReleaseMsiEvidenceFixture();

        // Expecting historical qualification run ID as execution run ID
        const confusedExecution = {
            ...fixture.expectedExecution,
            runId: ORIGINAL_QUALIFICATION_RUN_ID
        };
        await assert.rejects(
            () => verifyV161PostReleaseMsiEvidence({
                archiveBytes: fixture.archiveBytes,
                artifactMetadata: fixture.artifactMetadata,
                expectedExecution: confusedExecution
            }),
            /run ID.*differ/i
        );

        // Expecting candidate SHA as harness SHA
        const candidateAsHarness = {
            ...fixture.expectedExecution,
            sourceSha: CANDIDATE_SHA
        };
        await assert.rejects(
            () => verifyV161PostReleaseMsiEvidence({
                archiveBytes: fixture.archiveBytes,
                artifactMetadata: fixture.artifactMetadata,
                expectedExecution: candidateAsHarness
            }),
            /harness.*differ/i
        );
    });

    it("rejects loose, arbitrary prerequisite SHA strings without valid retained evidence", async () => {
        const fixture = await createPostReleaseMsiEvidenceFixture({
            mutateRequest: request => {
                request.prerequisiteEvidence.rollbackCalibration.document.bytesBase64 =
                    Buffer.from(JSON.stringify({fake: true})).toString("base64");
            }
        });

        await assert.rejects(
            () => verifyV161PostReleaseMsiEvidence({
                archiveBytes: fixture.archiveBytes,
                artifactMetadata: fixture.artifactMetadata,
                expectedExecution: fixture.expectedExecution
            }),
            /prerequisite/i
        );
    });

    it("rejects host cleanup failure and base image mutation", async () => {
        // Host cleanup not proven
        const cleanupFailedFixture = await createPostReleaseMsiEvidenceFixture({
            mutateResult: result => {
                result.hostRows[0].overlayCleanup.removed = false;
            }
        });
        await assert.rejects(
            () => verifyV161PostReleaseMsiEvidence({
                archiveBytes: cleanupFailedFixture.archiveBytes,
                artifactMetadata: cleanupFailedFixture.artifactMetadata,
                expectedExecution: cleanupFailedFixture.expectedExecution
            }),
            /cleanup/i
        );

        // Group zero before removal false
        const groupZeroFailedFixture = await createPostReleaseMsiEvidenceFixture({
            mutateResult: result => {
                result.hostRows[0].overlayCleanup.groupZeroBeforeRemoval = false;
            }
        });
        await assert.rejects(
            () => verifyV161PostReleaseMsiEvidence({
                archiveBytes: groupZeroFailedFixture.archiveBytes,
                artifactMetadata: groupZeroFailedFixture.artifactMetadata,
                expectedExecution: groupZeroFailedFixture.expectedExecution
            }),
            /cleanup/i
        );

        // Base image mutated
        const baseMutatedFixture = await createPostReleaseMsiEvidenceFixture({
            mutateResult: result => {
                result.baseAfter.sha256 = FOREIGN_DIGEST;
            }
        });
        await assert.rejects(
            () => verifyV161PostReleaseMsiEvidence({
                archiveBytes: baseMutatedFixture.archiveBytes,
                artifactMetadata: baseMutatedFixture.artifactMetadata,
                expectedExecution: baseMutatedFixture.expectedExecution
            }),
            /base image (?:changed|differs)/i
        );
    });

    it("rejects omitted, duplicated, or reordered matrix rows", async () => {
        // Omitted row (13 rows)
        const omittedRowFixture = await createPostReleaseMsiEvidenceFixture({
            mutateResult: result => {
                result.hostRows.pop();
                result.guestEvidence.rows.pop();
            }
        });
        await assert.rejects(
            () => verifyV161PostReleaseMsiEvidence({
                archiveBytes: omittedRowFixture.archiveBytes,
                artifactMetadata: omittedRowFixture.artifactMetadata,
                expectedExecution: omittedRowFixture.expectedExecution
            }),
            /count differs/i
        );

        // Reordered rows
        const reorderedRowsFixture = await createPostReleaseMsiEvidenceFixture({
            mutateResult: result => {
                result.hostRows.reverse();
            }
        });
        await assert.rejects(
            () => verifyV161PostReleaseMsiEvidence({
                archiveBytes: reorderedRowsFixture.archiveBytes,
                artifactMetadata: reorderedRowsFixture.artifactMetadata,
                expectedExecution: reorderedRowsFixture.expectedExecution
            }),
            /index|proof/i
        );
    });

    it("rejects guest semantic failure or failed blocking scenario", async () => {
        const semanticFailedFixture = await createPostReleaseMsiEvidenceFixture({
            mutateResult: result => {
                const row0 = result.guestEvidence.rows[0];
                const semantic = JSON.parse(Buffer.from(row0.semanticResult.bytesBase64, "base64"));
                semantic.matrixPassed = false;
                semantic.rowResult.rowPassed = false;
                const encoded = Buffer.from(JSON.stringify(semantic), "utf8");
                row0.semanticResult = {
                    bytes: encoded.length,
                    sha256: sha256(encoded),
                    bytesBase64: encoded.toString("base64")
                };
                result.hostRows[0].guestSemanticSha256 = row0.semanticResult.sha256;
            }
        });

        await assert.rejects(
            () => verifyV161PostReleaseMsiEvidence({
                archiveBytes: semanticFailedFixture.archiveBytes,
                artifactMetadata: semanticFailedFixture.artifactMetadata,
                expectedExecution: semanticFailedFixture.expectedExecution
            }),
            /did not pass|result status differs/i
        );
    });

    it("rejects status-only or malformed JSON in evidence members", async () => {
        const statusOnlyZip = createZipBuffer([
            {name: "msi-host-request.json", data: Buffer.from('{"status":"accepted"}')},
            {name: "msi-lifecycle-result.json", data: Buffer.from('{"status":"accepted"}')}
        ]);
        const fixture = await createPostReleaseMsiEvidenceFixture();
        const meta = {...fixture.artifactMetadata, size_in_bytes: statusOnlyZip.length,
            digest: `sha256:${sha256(statusOnlyZip)}`};

        await assert.rejects(
            () => verifyV161PostReleaseMsiEvidence({
                archiveBytes: statusOnlyZip,
                artifactMetadata: meta,
                expectedExecution: fixture.expectedExecution
            }),
            /keys differ|request|successful evidence artifact members differ/i
        );
    });

    it("rejects multiple ambiguous request or result files in the archive", async () => {
        const fixture = await createPostReleaseMsiEvidenceFixture({
            mutateFiles: files => {
                const existingResult = files.find(f => f.name === "msi-lifecycle-result.json");
                files.push({name: "msi-host-result.json", data: existingResult.data});
            }
        });

        await assert.rejects(
            () => verifyV161PostReleaseMsiEvidence({
                archiveBytes: fixture.archiveBytes,
                artifactMetadata: fixture.artifactMetadata,
                expectedExecution: fixture.expectedExecution
            }),
            /unexpected archive member: msi-host-result\.json/i
        );
    });
});
