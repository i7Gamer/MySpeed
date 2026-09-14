const SCHEMA_VERSION = 1;
const EXECUTION_KIND = "myspeed-windows-baseline-guest-execution-manifest";
const CONTROLLER_REQUEST_KIND = "myspeed-windows-native-candidate-request";
const CONTROLLER_READY_KIND = "myspeed-windows-native-candidate-ready";
const CONTROLLER_RESULT_KIND = "myspeed-windows-native-candidate-result";
const STOP_KIND = "myspeed-windows-native-candidate-stop";
const ALIAS = "baseline";
const ARTIFACT_LOGICAL_NAME = "MySpeed-windows-x64-baseline.exe";
const RESET_SCENARIO = "fresh-no-config-reset";
const RESET_ARGUMENT = "--reset-password";
const SUCCESS_EXIT_CODE = 0;
const RESET_EXIT_CODE = 113;
const NORMAL_DEADLINE_MILLISECONDS = 300_000;
const HARD_DEADLINE_MILLISECONDS = 310_000;
const STOP_REQUEST_TIMEOUT_MILLISECONDS = 240_000;
const STOP_REQUEST_POLL_MILLISECONDS = 50;
const GRACEFUL_EXIT_TIMEOUT_MILLISECONDS = 30_000;
const FORCED_CLEANUP_TIMEOUT_MILLISECONDS = 10_000;
const MAX_PORT = 65_535;
const MAX_PROCESS_ID = 0xffff_ffff;
const MAX_FAILURE_CHARACTERS = 512;
const REQUIRED_DEPENDENCIES = Object.freeze(["checkPopulated", "checkPopulatedDatabase", "checkResetDatabase",
    "cleanup", "inspectCandidate", "materialize", "observeListener", "observeNetwork", "readReady", "readResult",
    "startController", "waitController", "writeStop"]);

const isObject = value => value !== null && typeof value === "object" && !Array.isArray(value);
const exactKeys = (value, expected, label) => {
    if (!isObject(value) || JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...expected].sort()))
        throw new TypeError(`${label} schema differs`);
};
const exactString = (value, pattern, label) => {
    const match = typeof value === "string" ? pattern.exec(value) : null;
    if (match === null || match.index !== 0 || match[0].length !== value.length)
        throw new TypeError(`${label} differs`);
    return value;
};
const sha256 = (value, label) => exactString(value, /^[0-9a-f]{64}$/u, label);
const clone = value => structuredClone(value);
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const integer = (value, minimum, maximum, label) => {
    if (!Number.isSafeInteger(value) || value < minimum || value > maximum)
        throw new TypeError(`${label} differs`);
    return value;
};

function validateExecution(value, request) {
    exactKeys(value, ["candidateController", "candidateSource", "cleanStopController", "eventSha", "fixtureBundle",
        "imageVersion", "kind", "manifestSha256", "nonce", "runAttempt", "runId", "schemaVersion", "sourceSha"],
    "baseline guest execution manifest");
    if (value.schemaVersion !== SCHEMA_VERSION || value.kind !== EXECUTION_KIND)
        throw new TypeError("baseline guest execution manifest header differs");
    for (const [name, expected] of [["sourceSha", request.context.sourceSha], ["eventSha", request.context.eventSha],
        ["runId", request.context.runId], ["runAttempt", request.context.runAttempt], ["nonce", request.context.nonce]])
        if (value[name] !== expected) throw new TypeError(`baseline guest execution ${name} differs`);
    exactString(value.imageVersion, /^[0-9A-Za-z._-]{1,128}$/u, "baseline guest image version");
    sha256(value.manifestSha256, "baseline guest manifest SHA");
    for (const [name, record] of [["candidate source", value.candidateSource],
        ["candidate controller", value.candidateController], ["clean-stop controller", value.cleanStopController],
        ["fixture bundle", value.fixtureBundle]]) {
        exactKeys(record, ["bytes", "path", "sha256"], `baseline ${name}`);
        exactString(record.path, /^[A-Za-z]:\\[^\x00-\x1f\x7f:*?"<>|]+$/u, `baseline ${name} path`);
        exactString(record.bytes, /^[1-9][0-9]*$/u, `baseline ${name} bytes`);
        sha256(record.sha256, `baseline ${name} SHA`);
    }
    if (value.candidateSource.sha256 !== request.candidate.sha256 ||
        value.candidateSource.bytes !== request.candidate.bytes || !same(value.fixtureBundle, request.fixture))
        throw new TypeError("baseline guest execution input identity differs");
    return clone(value);
}

function validateDependencies(value) {
    if (!isObject(value) || REQUIRED_DEPENDENCIES.some(name => typeof value[name] !== "function"))
        throw new TypeError("baseline guest native dependencies are incomplete");
    return value;
}

function controllerPaths(request, scenario) {
    const root = `${request.paths.taskRoot}\\session-${scenario}`;
    return {root, stdout: `${root}\\candidate.stdout.log`, stderr: `${root}\\candidate.stderr.log`,
        ready: `${root}\\candidate.ready.json`, stop: `${root}\\candidate.stop.json`,
        result: `${root}\\candidate.result.json`, request: `${root}\\candidate.request.json`};
}

function buildControllerRequest(request, execution, scenario, port, candidateIdentity) {
    const paths = controllerPaths(request, scenario);
    return {schemaVersion: SCHEMA_VERSION, kind: CONTROLLER_REQUEST_KIND,
        expectedRunId: request.context.runId, expectedRunAttempt: request.context.runAttempt,
        expectedEventSha: request.context.eventSha, expectedSourceSha: request.context.sourceSha,
        expectedImageVersion: execution.imageVersion, nonce: request.context.nonce,
        manifestSha256: execution.manifestSha256, alias: ALIAS, artifactLogicalName: ARTIFACT_LOGICAL_NAME, scenario,
        taskRoot: request.paths.taskRoot, candidatePath: request.candidate.path, candidateSha256: request.candidate.sha256,
        candidateVolumeSerial: candidateIdentity.volumeSerial, candidateFileId: candidateIdentity.fileId,
        workingDirectory: scenario === RESET_SCENARIO ? request.paths.resetWork : request.paths.populatedWork,
        arguments: scenario === RESET_SCENARIO ? [RESET_ARGUMENT] : [], environment: {
            PATH: `${process.env.SystemRoot ?? "C:\\Windows"}\\System32`, SystemRoot: process.env.SystemRoot ?? "C:\\Windows",
            NODE_ENV: "production", DB_TYPE: "sqlite", SERVER_HOST: "127.0.0.1", SERVER_PORT: String(port),
            RUN_TEST_ON_STARTUP: "false"}, stdoutPath: paths.stdout, stderrPath: paths.stderr,
        readyPath: paths.ready, stopRequestPath: paths.stop, resultPath: paths.result,
        controllerPath: `${request.paths.taskRoot}\\windows-clean-stop-controller.ps1`,
        controllerSha256: execution.cleanStopController.sha256, normalDeadlineMs: NORMAL_DEADLINE_MILLISECONDS,
        hardDeadlineMs: HARD_DEADLINE_MILLISECONDS, stopRequestTimeoutMs: STOP_REQUEST_TIMEOUT_MILLISECONDS,
        stopRequestPollMs: STOP_REQUEST_POLL_MILLISECONDS,
        gracefulExitTimeoutMs: GRACEFUL_EXIT_TIMEOUT_MILLISECONDS,
        forcedCleanupTimeoutMs: FORCED_CLEANUP_TIMEOUT_MILLISECONDS};
}

const validateCandidateIdentity = value => {
    exactKeys(value, ["fileId", "volumeSerial"], "baseline candidate file identity");
    return {volumeSerial: exactString(value.volumeSerial, /^[0-9a-f]{8}$/u, "baseline candidate volume serial"),
        fileId: exactString(value.fileId, /^[0-9a-f]{16}$/u, "baseline candidate file ID")};
};

const validateControllerExit = value => {
    exactKeys(value, ["exitCode", "signal"], "baseline controller process result");
    if (value.exitCode !== SUCCESS_EXIT_CODE || value.signal !== null)
        throw new Error("baseline candidate controller process failed");
};

function validateReady(value, request) {
    exactKeys(value, ["schemaVersion", "kind", "nonce", "manifestSha256", "alias", "scenario",
        "artifactLogicalName", "candidateSha256", "candidatePid", "candidateCreationTime",
        "retainedHandleAuthority", "jobAssignedBeforeResume", "handleListConfigured"], "baseline candidate ready");
    if (value.schemaVersion !== SCHEMA_VERSION || value.kind !== CONTROLLER_READY_KIND ||
        value.nonce !== request.nonce || value.manifestSha256 !== request.manifestSha256 ||
        value.alias !== request.alias || value.scenario !== request.scenario ||
        value.artifactLogicalName !== request.artifactLogicalName || value.candidateSha256 !== request.candidateSha256)
        throw new TypeError("baseline candidate ready identity differs");
    integer(value.candidatePid, 1, MAX_PROCESS_ID, "baseline candidate ready PID");
    exactString(value.candidateCreationTime, /^[0-9a-f]{16}$/u, "baseline candidate ready creation time");
    for (const name of ["retainedHandleAuthority", "jobAssignedBeforeResume", "handleListConfigured"])
        if (value[name] !== true) throw new TypeError(`baseline candidate ready proof differs: ${name}`);
    return clone(value);
}

function validateCandidateResult(value, request, ready) {
    exactKeys(value, ["schemaVersion", "kind", "status", "qualifying", "releaseGatesCleared", "alias",
        "artifactLogicalName", "scenario", "stopKind", "candidatePid", "candidateCreationTime",
        "candidateExited", "exitCode", "forced", "jobActiveProcesses", "handleCleanupAttempted", "handlesClosed",
        "processTreeExitProven", "listenerGone", "elapsedMs", "failures"], "baseline candidate result");
    const reset = request.scenario === RESET_SCENARIO;
    if (value.schemaVersion !== SCHEMA_VERSION || value.kind !== CONTROLLER_RESULT_KIND ||
        value.status !== "completed" || value.qualifying !== false || !Array.isArray(value.releaseGatesCleared) ||
        value.releaseGatesCleared.length !== 0 || value.alias !== request.alias ||
        value.artifactLogicalName !== request.artifactLogicalName || value.scenario !== request.scenario ||
        value.stopKind !== (reset ? "observed-exit" : "ctrl-c") || value.candidatePid !== ready.candidatePid ||
        value.candidateCreationTime !== ready.candidateCreationTime)
        throw new TypeError("baseline candidate result identity differs");
    integer(value.candidatePid, 1, MAX_PROCESS_ID, "baseline candidate result PID");
    exactString(value.candidateCreationTime, /^[0-9a-f]{16}$/u, "baseline candidate result creation time");
    integer(value.exitCode, 0, MAX_PROCESS_ID, "baseline candidate result exit code");
    integer(value.jobActiveProcesses, 0, 0, "baseline candidate result active process count");
    integer(value.elapsedMs, 0, NORMAL_DEADLINE_MILLISECONDS, "baseline candidate result elapsed time");
    for (const name of ["candidateExited", "handleCleanupAttempted", "handlesClosed", "processTreeExitProven"])
        if (value[name] !== true) throw new TypeError(`baseline candidate result proof differs: ${name}`);
    if (value.exitCode !== (reset ? RESET_EXIT_CODE : SUCCESS_EXIT_CODE) || value.forced !== false ||
        value.listenerGone !== false || !Array.isArray(value.failures) || value.failures.length !== 0)
        throw new TypeError("baseline candidate result cleanup differs");
    return clone(value);
}

function validateAbsentListener(value) {
    exactKeys(value, ["listenerGone"], "baseline absent listener observation");
    if (value.listenerGone !== true) throw new TypeError("baseline listener remained after candidate exit");
}

const failureMessage = error => (error instanceof Error ? error.message : String(error))
    .replace(/[\x00-\x1f\x7f]+/gu, " ").slice(0, MAX_FAILURE_CHARACTERS) || "unspecified failure";

export function createWindowsBaselineGuestOperations({request, execution, dependencies}) {
    if (!isObject(request) || request.profile !== "baseline-cpu")
        throw new TypeError("baseline guest request differs");
    const checkedExecution = validateExecution(execution, request);
    const io = validateDependencies(dependencies);
    const sessions = new Map();
    let fixtureState = null;
    return Object.freeze({
        async prepareFixture(input) {
            if (!same(input.fixture, request.fixture) || !same(input.paths, request.paths))
                throw new TypeError("baseline fixture operation input differs");
            fixtureState = await io.materialize({request: clone(request), execution: clone(checkedExecution)});
            exactKeys(fixtureState, ["expected", "initialDatabase"], "baseline materialized fixture");
            return clone(fixtureState);
        },
        async observeNetwork() { return clone(await io.observeNetwork({request: clone(request)})); },
        async openScenario({scenario, port}) {
            if (!request.scenarios.some(value => value.scenario === scenario && value.port === port))
                throw new TypeError("baseline controller scenario differs");
            if (sessions.has(scenario)) throw new Error("baseline controller scenario was already opened");
            const candidateIdentity = validateCandidateIdentity(await io.inspectCandidate({request: clone(request),
                execution: clone(checkedExecution)}));
            const controllerRequest = buildControllerRequest(request, checkedExecution, scenario, port, candidateIdentity);
            const state = {scenario, port, request: controllerRequest, started: null, ready: null,
                startAttempted: true};
            sessions.set(scenario, state);
            state.started = await io.startController({request: clone(controllerRequest),
                requestPath: controllerPaths(request, scenario).request,
                controller: clone(checkedExecution.candidateController)});
            return state;
        },
        async awaitReady({session}) {
            const state = sessions.get(session.scenario);
            if (state !== session) throw new TypeError("baseline controller session differs");
            state.ready = validateReady(await io.readReady({request: clone(state.request), started: state.started}),
                state.request);
            return clone(state.ready);
        },
        async checkPopulated({session, port}) {
            if (sessions.get(session.scenario) !== session || session.ready === null)
                throw new TypeError("baseline running session differs");
            return clone(await io.checkPopulated({origin: `http://127.0.0.1:${port}`, port,
                candidatePid: session.ready.candidatePid}));
        },
        async closeScenario({session, scenario}) {
            const state = sessions.get(scenario);
            if (state !== session) throw new TypeError("baseline closing session differs");
            if (state.ready !== null && scenario !== RESET_SCENARIO) await io.writeStop({request: clone(state.request),
                value: {schemaVersion: SCHEMA_VERSION, kind: STOP_KIND, nonce: request.context.nonce,
                    manifestSha256: checkedExecution.manifestSha256, alias: ALIAS, scenario,
                    candidatePid: state.ready.candidatePid,
                    candidateCreationTime: state.ready.candidateCreationTime}});
            validateControllerExit(await io.waitController({request: clone(state.request), started: state.started}));
            const result = validateCandidateResult(await io.readResult({request: clone(state.request),
                started: state.started}), state.request, state.ready);
            validateAbsentListener(await io.observeListener({port: state.port, candidatePid: state.ready.candidatePid,
                candidateCreationTime: state.ready.candidateCreationTime, request: clone(state.request)}));
            sessions.delete(scenario);
            return {scenario, controllerLifecyclePassed: true,
                candidateExited: result.candidateExited, candidateExitCode: result.exitCode, forced: result.forced,
                jobActiveProcesses: result.jobActiveProcesses, handlesClosed: result.handlesClosed};
        },
        async checkPopulatedDatabase({scenario}) {
            return clone(await io.checkPopulatedDatabase({work: request.paths.populatedWork, scenario,
                expected: clone(fixtureState.expected)}));
        },
        async checkResetDatabase({scenario}) {
            return clone(await io.checkResetDatabase({work: request.paths.resetWork, scenario}));
        },
        async cleanupFixture({openAttempted}) {
            try { return clone(await io.cleanup({request: clone(request), execution: clone(checkedExecution),
                sessions: [...sessions.values()], fixtureState, openAttempted})); }
            catch (error) { return {cleanupProven: false, failure: failureMessage(error)}; }
        }
    });
}

export const WINDOWS_BASELINE_GUEST_OPERATION_CONSTANTS = Object.freeze({ALIAS, ARTIFACT_LOGICAL_NAME,
    EXECUTION_KIND, HARD_DEADLINE_MILLISECONDS, NORMAL_DEADLINE_MILLISECONDS});

