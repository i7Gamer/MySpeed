import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {spawnSync} from "node:child_process";
import os from "node:os";
import {describe, it} from "node:test";
import {parse} from "yaml";

import {WINDOWS_MSI_CONTROLLER_CLOSURE, WINDOWS_MSI_CONTROLLER_ENTRY, WINDOWS_MSI_GUEST_CLOSURE} from
    "../../scripts/qualification/windows-msi-execution-closure.mjs";
import {WINDOWS_MSI_LIFECYCLE_BUDGET, WINDOWS_MSI_LIFECYCLE_JOB_LIMITS} from "../../scripts/qualification/windows-msi-lifecycle-budget.mjs";
import {POST_RELEASE_MSI_VERIFICATION_CONSTANTS}
    from "../../scripts/release/post-release-msi-verification.mjs";

const PATH = ".github/workflows/post-release-msi-lifecycle.yml";
const TEXT = fs.readFileSync(PATH, "utf8");
const WORKFLOW = parse(TEXT);
const PREPARE_PATH = ".github/workflows/post-release-msi-prepare.yml";
const PREPARE_TEXT = fs.readFileSync(PREPARE_PATH, "utf8");
const PREPARE = parse(PREPARE_TEXT);
const MINUTE_MILLISECONDS = 60_000;
const EVIDENCE_MANIFEST_FILE = "evidence-manifest.json";

const steps = job => WORKFLOW.jobs[job].steps;
const stepNamed = (job, fragment) => steps(job).find(step => step.name.includes(fragment));
const bodyOf = (job, fragment) => stepNamed(job, fragment)?.run ?? "";

describe("post-release v1.6.1 MSI lifecycle workflow", () => {
    it("is manual, nonqualifying, read-only and pinned", () => {
        assert.deepEqual(Object.keys(WORKFLOW.on), ["workflow_dispatch"]);
        assert.deepEqual(WORKFLOW.permissions, {actions: "read", contents: "read"});
        assert.deepEqual(Object.keys(WORKFLOW.jobs), ["prepare", "seal", "execute"]);
        for (const job of Object.values(WORKFLOW.jobs))
            assert.match(job.if, /github\.repository == 'i7Gamer\/MySpeed'/u);
        for (const match of TEXT.matchAll(/uses: ([^\s@]+)@([^\s]+)/gu))
            assert.ok(match[1].startsWith("./") || /^[0-9a-f]{40}$/u.test(match[2]),
                `${match[1]} is not pinned to a commit`);
        assert.doesNotMatch(TEXT, /contents: write|packages: write|gh release|workflow_dispatch:\s*\n\s*repository/u);
    });

    /*
     * The preparation has to be a job of this same run, because the Linux job binds the preparation
     * artifact's run id, attempt and head SHA to its own hosted context. A separate dispatch of the
     * preparation workflow would produce an artifact from a different run and be rejected.
     */
    it("calls the existing preparation workflow in this same run without disturbing its dispatch path", () => {
        assert.equal(WORKFLOW.jobs.prepare.uses, "./.github/workflows/post-release-msi-prepare.yml");
        assert.deepEqual(Object.keys(PREPARE.on).sort(), ["workflow_call", "workflow_dispatch"]);
        assert.equal(PREPARE.on.workflow_dispatch, null);
        assert.equal(PREPARE.jobs.prepare["runs-on"], "windows-2025");
        assert.ok(PREPARE_TEXT.includes("post-release-v1.6.1-msi-appassets"));
        assert.equal(WORKFLOW.env.PREPARATION_ARTIFACT_NAME, "post-release-v1.6.1-msi-appassets");
    });

    it("checks out only in the seal job and executes a verified sealed closure", () => {
        const checkouts = step => String(step.uses ?? "").includes("actions/checkout");
        assert.equal(steps("seal").filter(checkouts).length, 1);
        assert.equal(steps("execute").some(checkouts), false);
        const verify = bodyOf("execute", "Verify every sealed closure member");
        assert.match(verify, /myspeed-windows-msi-execution-closure/u);
        assert.match(verify, /sealed closure member differs/u);
        assert.match(verify, /sealed closure carries source nobody bound a hash to/u);
        assert.match(verify, /EXPECTED_CLOSURE_SHA256/u);
        const seal = bodyOf("seal", "Seal the exact controller and guest closures");
        assert.match(seal, /sealWindowsMsiExecutionClosure/u);
        assert.match(seal, /WINDOWS_MSI_CONTROLLER_CLOSURE/u);
        assert.match(seal, /WINDOWS_MSI_GUEST_CLOSURE/u);
    });

    /*
     * The installed base receipt binds same-job file identity. Sealing the base in one job and
     * running rows in another would hand the rows a portable copy of a receipt about a file they
     * never observed, so both have to be steps of the one Linux job.
     */
    it("seals the installed base and runs every row in the one Linux job", () => {
        const lifecycle = bodyOf("execute", "Seal the installed base and run the exact fourteen rows");
        assert.match(lifecycle, /post-release-msi-linux-controller\.mjs" run/u);
        assert.match(lifecycle, /installedBaseHelperSource/u);
        assert.match(lifecycle, /--progress "\$task_root\/msi-lifecycle-progress\.json"/u);
        assert.match(lifecycle, /stage2Paths/u);
        assert.equal(WORKFLOW.jobs.execute["runs-on"], "ubuntu-24.04");
        assert.deepEqual(WORKFLOW.jobs.execute.needs, ["prepare", "seal"]);
        assert.doesNotMatch(TEXT, /system\.qcow2[\s\S]{0,200}upload-artifact/u);
        const upload = steps("execute").find(step => String(step.uses ?? "").includes("upload-artifact"));
        for (const line of String(upload.with.path).split("\n").filter(Boolean))
            assert.match(line.trim(), /\.(?:json|stdout|stderr)$/u, line);
    });

    it("bounds the whole job inside the hosted limit and admits rows against measured time", () => {
        assert.ok(WORKFLOW.jobs.execute["timeout-minutes"] * MINUTE_MILLISECONDS
            <= WINDOWS_MSI_LIFECYCLE_BUDGET.hostedJobLimitMilliseconds);
        assert.ok(WORKFLOW.jobs.seal["timeout-minutes"] > 0);
        assert.equal(stepNamed("execute", "Record the job start").run.includes("date -u +%s"), true);
        const lifecycle = bodyOf("execute", "Seal the installed base and run the exact fourteen rows");
        assert.match(lifecycle, /jobBudgetMilliseconds/u);
        assert.match(lifecycle, /rowAllowanceMilliseconds/u);
        assert.match(lifecycle, /rowCleanupMarginMilliseconds/u);
        assert.match(lifecycle, /finalMarginMilliseconds/u);
        /*
         * The measured setup is subtracted by the same module the controller admits rows with, rather
         * than by arithmetic written twice.
         */
        assert.match(lifecycle, /admitWindowsMsiLifecycleSetup/u);
        assert.match(lifecycle, /windows-msi-lifecycle-budget\.mjs/u);
        for (const name of ["job_budget_minutes", "row_allowance_minutes"])
            assert.equal(WORKFLOW.on.workflow_dispatch.inputs[name].required, true);
    });

    /*
     * The job stops at its own `timeout-minutes`, not at the platform limit, and the last minutes of
     * it belong to bounding and uploading the evidence. A dispatched budget that reaches into that
     * reserve is refused before Stage 2 runs, not after it.
     */
    it("reserves enforceable time for retention and checks it before the expensive setup", () => {
        assert.equal(Number(WORKFLOW.env.JOB_TIMEOUT_MINUTES),
            WORKFLOW.jobs.execute["timeout-minutes"]);
        assert.equal(Number(WORKFLOW.env.JOB_TIMEOUT_MINUTES) * MINUTE_MILLISECONDS,
            WINDOWS_MSI_LIFECYCLE_JOB_LIMITS.jobTimeoutMilliseconds);
        assert.equal(Number(WORKFLOW.env.RETENTION_RESERVE_MINUTES) * MINUTE_MILLISECONDS,
            WINDOWS_MSI_LIFECYCLE_JOB_LIMITS.retentionReserveMilliseconds);
        const validate = bodyOf("execute", "Validate the dispatched budget before the expensive setup");
        assert.match(validate, /validateWindowsMsiLifecycleJobBudget/u);
        assert.match(validate, /admitWindowsMsiLifecycleSetup/u);
        const names = WORKFLOW.jobs.execute.steps.map(step => step.name);
        assert.ok(names.indexOf("Validate the dispatched budget before the expensive setup")
            < names.indexOf("Build the exact Stage 2 request and calibrate the base image"));
    });

    /*
     * Stage 2's validator names its own closure root, its own ordered eight files and its own staged
     * input root. Handing it the MSI closure or the MSI input root is refused by Stage 2 itself -
     * which `tests/server/windowsMsiStage2Request.test.js` proves by feeding the request this step
     * builds to the real validator.
     */
    it("gives Stage 2 its own sealed closure and its own staged inputs", () => {
        const stage2 = bodyOf("execute", "Build the exact Stage 2 request and calibrate the base image");
        assert.match(stage2, /myspeed-stage2-closure-\$EXPECTED_NONCE/u);
        assert.match(stage2, /myspeed-stage2-input-\$EXPECTED_NONCE/u);
        assert.match(stage2, /buildWindowsMsiStage2Request/u);
        assert.match(stage2, /EXPECTED_STAGE2_SHA256/u);
        assert.match(stage2, /sealed Stage 2 closure carries source nobody bound a hash to/u);
        /* The Stage 2 controller that runs is the copy inside the Stage 2 tree, not the MSI one. */
        assert.match(stage2,
            /\$stage2_root\/scripts\/qualification\/linux-windows-cpu-floor-stage2-controller\.mjs/u);
        assert.equal(/closure: \{root: closureRoot/u.test(stage2), false);
        const acquire = bodyOf("execute", "Acquire the exact prior Windows probe artifact");
        assert.match(acquire, /myspeed-stage2-input-\$EXPECTED_NONCE/u);
        assert.equal(WORKFLOW.jobs.seal.outputs.stage2_sha256 !== undefined, true);
    });

    /*
     * The KVM contract pins its own closure root, so the job carries duplicate copies of two modules
     * that also live in the verified MSI closure - beside manifests they would otherwise validate
     * themselves against. The digest that authenticates them leaves the seal job as a job output.
     */
    it("authenticates the KVM copies it invokes against a digest sealed outside their tree", () => {
        assert.equal(WORKFLOW.jobs.seal.outputs.kvm_sha256 !== undefined, true);
        assert.equal(WORKFLOW.jobs.execute.env.EXPECTED_KVM_SHA256 !== undefined, true);
        const verify = bodyOf("execute", "Verify the invoked KVM subtree against the digest sealed outside it");
        assert.match(verify, /verifyWindowsMsiKvmSubtree/u);
        assert.match(verify, /EXPECTED_KVM_SHA256/u);
        assert.match(verify, /KVM subtree copy differs from the sealed member/u);
        const names = WORKFLOW.jobs.execute.steps.map(step => step.name);
        assert.ok(names.indexOf("Verify the invoked KVM subtree against the digest sealed outside it")
            < names.indexOf("Repeat ordinary and reviewed privileged KVM observation"));
        assert.match(bodyOf("seal", "Seal the exact controller and guest closures"),
            /sealWindowsMsiKvmSubtree/u);
    });

    /*
     * A prerequisite is the producer's own retained document, inspected here. A bare digest or the
     * SHA-256 of the helper that would do the work is code provenance and proves no execution.
     */
    it("replays the rollback prerequisite here and leaves containment to its producer", () => {
        const assemble = bodyOf("execute", "Assemble the typed prerequisite evidence");
        assert.match(assemble, /inspectWindowsMsiPrerequisiteEvidence/u);
        assert.match(assemble, /rollback-result\.json/u);
        assert.match(assemble, /rollback-launcher\.json/u);
        assert.match(assemble, /hosted-run-artifact/u);
        assert.match(assemble, /officialArtifactDigest/u);
        assert.doesNotMatch(TEXT, /rollbackCalibrationSha256|oldContainmentSha256/u);
        const acquire = bodyOf("execute", "Acquire the accepted rollback calibration evidence");
        assert.match(acquire, /artifact metadata identity differs/u);
        assert.match(acquire, /artifact archive digest differs/u);
        /*
         * The producer that actually exists: its artifact, its workflow, its attempt, and the
         * platform's own digest compared with the dispatch pin before a byte is downloaded.
         */
        assert.equal(WORKFLOW.env.ROLLBACK_ARTIFACT_NAME, "windows-msi-sacrificial-executor-boundary");
        assert.equal(WORKFLOW.env.ROLLBACK_WORKFLOW, "windows-msi-rollback-calibration.yml");
        assert.match(acquire, /official artifact digest differs from the dispatch pin/u);
        assert.match(acquire, /runValue\.path !== /u);
        assert.match(acquire, /runValue\.run_attempt/u);
        assert.match(acquire, /for member in result\.json launcher\.json/u);
        /*
         * The producer records a source SHA and an event SHA that genuinely differ on a PR run. The
         * run API reports the head as the source SHA and never reports the event SHA, so the event
         * cannot come from the run metadata - and it must not come from the dispatch either: a
         * caller-supplied SHA is only checked to be *a* merge of that head, which any other merge of
         * the same head also satisfies. It is derived instead from the two documents the producer
         * itself retained, which have to agree with each other and with the authenticated run.
         */
        assert.equal(Object.hasOwn(WORKFLOW.on.workflow_dispatch.inputs, "rollback_event_sha"), false);
        assert.doesNotMatch(acquire, /inputs\.rollback_event_sha/u);
        assert.doesNotMatch(acquire, /PRODUCER_EVENT_SHA_PATH, .\$\{runValue\.head_sha\}/u);
        /* The derivation reads the extracted producer documents, after they are extracted. */
        assert.ok(acquire.indexOf("for member in result.json launcher.json")
            < acquire.indexOf("rollback-launcher.json"), "the event SHA is derived after extraction");
        assert.match(acquire, /rollback-result\.json/u);
        assert.match(acquire, /-InputJson/u);
        assert.match(acquire, /producer launch arguments do not carry exactly one input document/u);
        assert.match(acquire, /producer documents disagree about the run they belong to/u);
        assert.match(acquire, /producer document does not belong to the authenticated run/u);
        assert.match(acquire, /producer event commit is not a merge of the producer source commit/u);
        assert.match(acquire, /pull-request producer event SHA cannot equal its source SHA/u);
        assert.match(acquire, /PRODUCER_EVENT_SHA_PATH/u);
    });

    /*
     * The consumer requires `msi-host-request.json`: the outer controller input is taken before the
     * base seal, the fixture and the source observations exist, so it is not the document a result
     * can be replayed against.
     */
    it("retains the final host request beside the result for the consumer", () => {
        const lifecycle = bodyOf("execute", "Seal the installed base and run the exact fourteen rows");
        assert.match(lifecycle, /--host-request "\$task_root\/msi-host-request\.json"/u);
        const bound = bodyOf("execute", "Bound the retained text evidence");
        assert.match(bound, /msi-host-request\.json/u);
        assert.match(bound, /hostRequest\.identity !== null/u);
        assert.match(bound, /myspeed-windows-msi-lifecycle-evidence-manifest/u);
        const uploaded = stepNamed("execute", "Upload the bounded nonqualifying MSI lifecycle evidence")
            .with.path.trim().split("\n").map(line => line.trim().split("/").pop());
        /* The closure manifest is retained evidence, so the inventory has to name it too. */
        assert.match(bound, /msi-execution-closure\.json/u);
        assert.match(bound, /"msi-execution-closure\.json",\s*$/mu);
        assert.deepEqual(uploaded, ["msi-host-request.json", "evidence-manifest.json",
            "msi-lifecycle-result.json", "msi-lifecycle-progress.json", "transport-summary.json",
            "controller.stdout", "controller.stderr", "msi-execution-closure.json"]);
        /* Nothing outside the agreed inventory, and no media, disk or tree. */
        for (const name of uploaded)
            assert.ok(/\.(?:json|stdout|stderr)$/u.test(name), name);
    });

    it("retains bounded typed evidence and clears no gate whatever the outcome", () => {
        const bound = bodyOf("execute", "Bound the retained text evidence");
        assert.match(bound, /msi-lifecycle-progress\.json/u);
        assert.match(bound, /msi-lifecycle-result\.json/u);
        assert.match(bound, /releaseGatesCleared/u);
        assert.match(bound, /hostRows\.length === 14/u);
        assert.match(bound, /rowsCompleted === 14/u);
        assert.equal(stepNamed("execute", "Bound the retained text evidence").if, "always()");
        const gate = stepNamed("execute", "Require an accepted nonqualifying lifecycle observation");
        assert.equal(gate.if, "always()");
        assert.match(gate.run, /steps\.bound\.outputs\.accepted/u);
        assert.doesNotMatch(TEXT, /qualifying: true|releaseGateCleared: true/u);
    });

    /*
     * Nothing else binds what this workflow uploads to what the independent consumer will look for. Both
     * lists are literal text in their own file, so a rename or an added member on either side would only
     * surface on a hosted run, where the evidence is already spent.
     */
    it("packages exactly the member set the independent evidence consumer accepts", () => {
        const {ALL_ALLOWED_FILES, REQUIRED_FILES} = POST_RELEASE_MSI_VERIFICATION_CONSTANTS;
        const upload = steps("execute").find(step => typeof step.uses === "string"
            && step.uses.startsWith("actions/upload-artifact")
            && step.with?.name === "post-release-v1.6.1-msi-lifecycle-evidence");
        assert.ok(upload, "the lifecycle evidence upload step must exist");
        assert.equal(upload.with["if-no-files-found"], "error");
        const uploaded = String(upload.with.path).split("\n").map(line => line.trim()).filter(Boolean)
            .map(line => path.posix.basename(line));
        assert.equal(uploaded.length, new Set(uploaded).size);
        // Every member is uploaded from one directory, so each lands at the archive root under the bare
        // name the consumer looks for.
        const transport = String(upload.with.path).split("\n").map(line => line.trim()).filter(Boolean)
            .map(line => path.posix.dirname(line));
        assert.equal(new Set(transport).size, 1);
        assert.deepEqual([...uploaded].sort(), [...ALL_ALLOWED_FILES].sort());
        for (const required of REQUIRED_FILES) assert.ok(uploaded.includes(required), required);

        // The retained inventory must be able to name every uploaded member except itself; a member the
        // manifest cannot describe reaches the consumer unbound to what this job wrote.
        const bound = bodyOf("execute", "Bound the retained text evidence");
        const inventory = /const inventory = \[([\s\S]*?)\]\.flatMap/u.exec(bound);
        assert.ok(inventory, "the packaging step must build a named inventory");
        const inventoryNames = [...inventory[1].matchAll(/"([^"]+)"/gu)].map(match => match[1]);
        assert.equal(inventoryNames.length, new Set(inventoryNames).size);
        assert.deepEqual([...inventoryNames].sort(),
            ALL_ALLOWED_FILES.filter(name => name !== EVIDENCE_MANIFEST_FILE).sort());
    });

    it("seals every declared closure member and nothing else", () => {
        assert.ok(WINDOWS_MSI_CONTROLLER_CLOSURE.includes(WINDOWS_MSI_CONTROLLER_ENTRY));
        const sealed = new Set([...WINDOWS_MSI_CONTROLLER_CLOSURE, ...WINDOWS_MSI_GUEST_CLOSURE]);
        for (const member of sealed) assert.ok(fs.existsSync(member), member);
        const tests = bodyOf("seal", "Run the pure execution-side tests");
        for (const name of ["windowsMsiExecutionClosure", "windowsMsiLifecycleBudget",
            "windowsMsiPrerequisiteEvidence", "linuxWindowsMsiLifecycleHost", "postReleaseMsiHostRequest",
            "postReleaseMsiHostBridge", "postReleaseMsiLinuxController", "postReleaseMsiLifecycleWorkflow",
            "windowsMsiStage2Request", "windowsMsiContainmentPreflight"])
            assert.ok(tests.includes(`tests/server/${name}.test.js`), name);
    });
});

/*
 * The rollback event SHA is derived by a script that only ever runs inside the workflow, so it is
 * lifted out of the step and executed here against synthetic producer documents. A structural match
 * on the YAML would only prove the text is present; these cases prove what it decides.
 */
describe("Post-release MSI lifecycle rollback event SHA derivation", () => {
    const RUN_ID = "34817703654";
    const RUN_ATTEMPT = "1";
    const SOURCE_SHA = "92f0ff3eab126271548684a5384c7b2ff2213655";
    const EVENT_SHA = "0a85c86194d74164b50f9a64bcd3a4213f6b60da";
    const OTHER_MERGE_SHA = "5c1d0f7a1b2c3d4e5f60718293a4b5c6d7e8f901";
    const NONCE = "4c4d25645801462792f17a660934e138";

    const script = () => {
        const step = WORKFLOW.jobs.execute.steps.find(value =>
            value.name === "Acquire the accepted rollback calibration evidence");
        const lines = step.run.split("\n");
        const opened = lines.lastIndexOf("node --input-type=module - <<'NODE'");
        assert.notEqual(opened, -1, "the derivation runs as its own inline module");
        const closed = lines.indexOf("NODE", opened);
        assert.ok(closed > opened, "the inline module is terminated");
        return lines.slice(opened + 1, closed).join("\n");
    };

    const producerResult = (overrides = {}) => ({schemaVersion: 1,
        kind: "myspeed-msi-sacrificial-native-calibration", status: "observed", qualifying: false,
        sourceSha: SOURCE_SHA, eventSha: EVENT_SHA, runId: RUN_ID, runAttempt: RUN_ATTEMPT,
        nonce: NONCE, releaseGatesCleared: [], ...overrides});

    const producerLauncher = (launched = {}, overrides = {}) => ({schemaVersion: 1,
        kind: "myspeed-owned-job-observed-launch", status: "completed",
        arguments: ["-NoLogo", "-NoProfile", "-File", "windows-msi-rollback-native.ps1",
            "-Mode", "InvokeHostedCalibration", "-InputJson", JSON.stringify({runId: RUN_ID,
                runAttempt: RUN_ATTEMPT, eventSha: EVENT_SHA, sourceSha: SOURCE_SHA, nonce: NONCE,
                ...launched})],
        exitCode: 0, ...overrides});

    /*
     * The platform is answered by a stub so the case under test is the decision, not the network.
     * It records what was asked for, which is how "the SHA came from the producer's own documents"
     * is checked rather than assumed.
     */
    const derive = ({result = producerResult(), launcher = producerLauncher(),
        producerEvent = "pull_request", commit = {sha: EVENT_SHA, parents: [{sha: SOURCE_SHA}]},
        ok = true} = {}) => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), "myspeed-rollback-derivation-"));
        try {
            const inputRoot = path.join(root, `myspeed-msi-input-${NONCE}`);
            fs.mkdirSync(inputRoot);
            fs.writeFileSync(path.join(inputRoot, "rollback-result.json"), JSON.stringify(result));
            fs.writeFileSync(path.join(inputRoot, "rollback-launcher.json"), JSON.stringify(launcher));
            const runEventPath = path.join(inputRoot, "rollback-producer-run-event.txt");
            const eventShaPath = path.join(inputRoot, "rollback-producer-event-sha.txt");
            const askedPath = path.join(root, "asked.txt");
            fs.writeFileSync(runEventPath, `${producerEvent}\n`);
            const module = path.join(root, "derive.mjs");
            fs.writeFileSync(module, [
                `globalThis.fetch = async url => { `
                    + `(await import("node:fs")).appendFileSync(${JSON.stringify(askedPath)}, url + "\\n"); `
                    + `return {ok: ${ok}, json: async () => (${JSON.stringify(commit)})}; };`,
                script()].join("\n"));
            const completed = spawnSync(process.execPath, [module], {encoding: "utf8",
                env: {...process.env, RUNNER_TEMP: root, EXPECTED_NONCE: NONCE, TARGET_RUN_ID: RUN_ID,
                    TARGET_RUN_ATTEMPT: RUN_ATTEMPT, TARGET_SOURCE_SHA: SOURCE_SHA,
                    PRODUCER_RUN_EVENT_PATH: runEventPath, PRODUCER_EVENT_SHA_PATH: eventShaPath,
                    GH_TOKEN: "x".repeat(16)}});
            return {status: completed.status, stderr: completed.stderr,
                asked: fs.existsSync(askedPath) ? fs.readFileSync(askedPath, "utf8") : "",
                derived: fs.existsSync(eventShaPath)
                    ? fs.readFileSync(eventShaPath, "utf8").trim() : null};
        } finally { fs.rmSync(root, {recursive: true, force: true}); }
    };

    it("takes the event SHA from the producer's own retained documents", () => {
        const observed = derive();
        assert.equal(observed.status, 0, observed.stderr);
        assert.equal(observed.derived, EVENT_SHA);
        /* The commit that was looked up is the one the documents named, not one a caller chose. */
        assert.match(observed.asked, new RegExp(`/commits/${EVENT_SHA}$`, "mu"));
    });

    /*
     * The failure the dispatch input had: any other merge of the same head satisfied "is a merge of
     * this head". It cannot be reached any more, because the SHA is no longer something a caller
     * supplies - but a commit that is not a merge of this producer's source is still refused.
     */
    it("refuses an arbitrary merge that is not this producer's event commit", () => {
        const foreign = derive({commit: {sha: OTHER_MERGE_SHA, parents: [{sha: SOURCE_SHA}]}});
        assert.notEqual(foreign.status, 0);
        assert.match(foreign.stderr, /is not a merge of the producer source commit/u);
        const unrelated = derive({commit: {sha: EVENT_SHA, parents: [{sha: OTHER_MERGE_SHA}]}});
        assert.notEqual(unrelated.status, 0);
        assert.match(unrelated.stderr, /is not a merge of the producer source commit/u);
        const missing = derive({ok: false});
        assert.notEqual(missing.status, 0);
        assert.match(missing.stderr, /producer event commit request failed/u);
        /* Nothing is written on any of those paths. */
        for (const observed of [foreign, unrelated, missing]) assert.equal(observed.derived, null);
    });

    it("refuses producer documents that disagree about the run they belong to", () => {
        for (const [name, launched] of Object.entries({
            "a different event SHA": {eventSha: OTHER_MERGE_SHA},
            "a different source SHA": {sourceSha: OTHER_MERGE_SHA},
            "a different run": {runId: "34900000001"},
            "a different attempt": {runAttempt: "2"},
            "a different nonce": {nonce: "f".repeat(32)}})) {
            const observed = derive({launcher: producerLauncher(launched)});
            assert.notEqual(observed.status, 0, name);
            assert.match(observed.stderr, /producer documents disagree/u, name);
        }
    });

    it("refuses documents that belong to a run other than the authenticated one", () => {
        for (const overrides of [{runId: "34900000001"}, {runAttempt: "2"},
            {sourceSha: OTHER_MERGE_SHA}]) {
            const launched = {...overrides};
            const observed = derive({result: producerResult(overrides),
                launcher: producerLauncher(launched)});
            assert.notEqual(observed.status, 0, JSON.stringify(overrides));
            assert.match(observed.stderr, /does not belong to the authenticated run/u,
                JSON.stringify(overrides));
        }
    });

    it("refuses a launch vector that does not name exactly one input document", () => {
        const none = derive({launcher: producerLauncher({}, {arguments: ["-NoLogo", "-Mode", "X"]})});
        assert.notEqual(none.status, 0);
        assert.match(none.stderr, /exactly one input document/u);
        const twice = derive({launcher: producerLauncher({},
            {arguments: ["-InputJson", "{}", "-InputJson", "{}"]})});
        assert.notEqual(twice.status, 0);
        assert.match(twice.stderr, /exactly one input document/u);
        const empty = derive({launcher: producerLauncher({}, {arguments: ["-InputJson"]})});
        assert.notEqual(empty.status, 0);
        assert.match(empty.stderr, /exactly one input document/u);
    });

    /*
     * Off a pull request the producer's two roles are the same commit, so there is no merge to look
     * for and no lookup is made; a document claiming otherwise is refused.
     */
    it("requires the two roles to coincide when the producer did not run on a pull request", () => {
        const same = derive({producerEvent: "workflow_dispatch",
            result: producerResult({eventSha: SOURCE_SHA}),
            launcher: producerLauncher({eventSha: SOURCE_SHA})});
        assert.equal(same.status, 0, same.stderr);
        assert.equal(same.derived, SOURCE_SHA);
        assert.equal(same.asked, "");
        const differing = derive({producerEvent: "workflow_dispatch"});
        assert.notEqual(differing.status, 0);
        assert.match(differing.stderr, /differs from the run the platform reports/u);
        /* And on a pull request they may not coincide, which is what the old step forced. */
        const forced = derive({result: producerResult({eventSha: SOURCE_SHA}),
            launcher: producerLauncher({eventSha: SOURCE_SHA})});
        assert.notEqual(forced.status, 0);
        assert.match(forced.stderr, /cannot equal its source SHA/u);
    });
});

/*
 * The containment prerequisite used to be an unconditional stop: the job demanded the calibration
 * before it invoked the controller that produces it. Now only the rollback record - whose producer
 * genuinely ran in another run, at another commit - is supplied from outside.
 */
describe("Post-release MSI lifecycle containment prerequisite", () => {
    const assemble = () => bodyOf("execute", "Assemble the typed prerequisite evidence");
    const lifecycle = () => bodyOf("execute", "Seal the installed base and run the exact fourteen rows");

    it("supplies the rollback record and lets the controller produce the containment one", () => {
        const body = assemble();
        /* The failure that stopped every run before the producer existed is gone. */
        assert.doesNotMatch(body, /Missing producer for authentic-old-ifeo-containment/u);
        assert.doesNotMatch(body, /containment-calibration\.json/u);
        assert.doesNotMatch(body, /oldContainment/u);
        /* What it assembles is exactly one record, and it is the rollback one. */
        assert.match(body, /rollbackCalibration/u);
        assert.match(body, /rollback-producer-event-sha\.txt/u);
        assert.match(body, /prerequisite-evidence\.json/u);
    });

    it("hands the controller the preflight runner it stages into its own guest", () => {
        /* The controller entry is unchanged; what changed is what it does between its own steps. */
        assert.match(lifecycle(), /msi-lifecycle-request\.json/u);
        assert.match(lifecycle(), /--host-request/u);
        /* The preflight executor is a sealed closure member like every other executed file. */
        assert.ok(WINDOWS_MSI_CONTROLLER_CLOSURE.includes(
            "scripts/qualification/windows-msi-guest-containment-preflight-executor.mjs"));
        assert.ok(WINDOWS_MSI_CONTROLLER_CLOSURE.includes(
            "scripts/qualification/windows-msi-containment-preflight-host.mjs"));
    });

    /*
     * A preflight that fails has to look like a failed run, not like a run with no containment
     * evidence: the bounded progress is retained, the result is not, and nothing is uploaded that a
     * consumer could mistake for an accepted calibration.
     */
    it("retains a failed preflight as bounded progress and never as accepted evidence", () => {
        const body = lifecycle();
        /* Both documents are named on the controller command line, and only one is ever written. */
        assert.match(body, /--result/u);
        assert.match(body, /--progress/u);
        assert.match(body, /msi-lifecycle-progress\.json/u);
        assert.match(body, /msi-lifecycle-result\.json/u);
        /*
         * The upload carries the progress document, so a run that stopped inside the preflight is
         * retained as the failure it was rather than vanishing. The acceptance gate is a separate
         * step that requires the result, which such a run never writes.
         */
        assert.match(bodyOf("execute", "Bound the retained text evidence"),
            /msi-lifecycle-progress\.json/u);
        const bound = bodyOf("execute", "Bound the retained text evidence");
        /* Acceptance is derived from the result document alone; progress never sets it. */
        assert.match(bound, /const accepted = exit === 0/u);
        assert.match(bound, /progressPresent: progress\.identity !== null/u);
        assert.match(bodyOf("execute", "Require an accepted nonqualifying lifecycle observation"),
            /steps\.bound\.outputs\.accepted/u);
    });
});
