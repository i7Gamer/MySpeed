const SCHEMA_VERSION = 1;
const REQUEST_KIND = "myspeed-windows-baseline-guest-request";
const PROFILE = "baseline-cpu";
const ARTIFACT_NAME = "MySpeed-windows-x64-baseline.exe";
const RESET_EXIT_CODE = 113;
const SUCCESS_EXIT_CODE = 0;
const MAX_PORT = 65_535;
const MAX_PROCESS_ID = 0xffff_ffff;
const MAX_FAILURE_CHARACTERS = 512;
const MAX_OPEN_GRAPH_ELAPSED_MILLISECONDS = 120_000;
const MAX_SUMMARY_STRING_CHARACTERS = 256;
const EXPECTED_SCENARIOS = Object.freeze(["populated-first-boot", "populated-restart", "fresh-no-config-reset"]);
const OPERATION_NAMES = Object.freeze(["awaitOwnedListener", "awaitReady", "checkPopulated", "checkPopulatedDatabase",
    "checkResetDatabase", "cleanupFixture", "closeScenario", "observeNetwork", "openScenario", "prepareFixture"]);

const isObject = value => value !== null && typeof value === "object" && !Array.isArray(value);
const exactKeys = (value, expected, label) => {
    if (!isObject(value) || JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...expected].sort()))
        throw new TypeError(`${label} schema differs`);
};
const exactString = (value, pattern, label) => {
    if (typeof value !== "string" || !pattern.test(value)) throw new TypeError(`${label} differs`);
    return value;
};
const decimal = (value, label) => exactString(value, /^[1-9][0-9]*$/u, label);
const sha256 = (value, label) => exactString(value, /^[0-9a-f]{64}$/u, label);
const windowsPath = (value, label) => {
    exactString(value, /^[A-Za-z]:\\[^\x00-\x1f\x7f:*?"<>|]*$/u, label);
    const normalized = value.replaceAll("/", "\\");
    if (normalized.includes("\\.\\") || normalized.includes("\\..\\") || normalized.endsWith("\\.") ||
        normalized.endsWith("\\..")) throw new TypeError(`${label} differs`);
    return value;
};
const clone = value => structuredClone(value);
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);

function boundedSummaryString(value, label) {
    if (typeof value !== "string" || value.length < 1 || value.length > MAX_SUMMARY_STRING_CHARACTERS ||
        /[\x00-\x1f\x7f]/u.test(value)) throw new TypeError(`${label} differs`);
    return value;
}

function validatePopulatedDatabase(value, expected, label) {
    exactKeys(value, ["passwordValueSha256", "ping", "resultId"], label);
    const checked = {ping: boundedSummaryString(value.ping, `${label} ping`),
        resultId: boundedSummaryString(value.resultId, `${label} result ID`),
        passwordValueSha256: sha256(value.passwordValueSha256, `${label} password fingerprint`)};
    if (expected !== null && !same(checked, expected)) throw new TypeError(`${label} differs`);
    return clone(checked);
}

function validateResetDatabase(value) {
    exactKeys(value, ["configTable", "integrity"], "baseline reset database receipt");
    if (value.integrity !== "ok" || value.configTable !== false)
        throw new TypeError("baseline reset database receipt differs");
    return clone(value);
}

function validatePopulated(value) {
    exactKeys(value, ["elapsedMs"], "baseline populated HTTP receipt");
    if (!Number.isInteger(value.elapsedMs) || value.elapsedMs < 0 ||
        value.elapsedMs > MAX_OPEN_GRAPH_ELAPSED_MILLISECONDS)
        throw new TypeError("baseline populated HTTP receipt differs");
    return clone(value);
}

function validateRequest(value) {
    exactKeys(value, ["candidate", "context", "fixture", "kind", "paths", "profile", "qualifying", "scenarios",
        "schemaVersion"], "baseline guest request");
    if (value.schemaVersion !== SCHEMA_VERSION || value.kind !== REQUEST_KIND || value.profile !== PROFILE ||
        value.qualifying !== false) throw new TypeError("baseline guest request header differs");
    exactKeys(value.context, ["eventSha", "nonce", "runAttempt", "runId", "sourceSha"], "baseline guest context");
    exactString(value.context.sourceSha, /^[0-9a-f]{40}$/u, "baseline source SHA");
    exactString(value.context.eventSha, /^[0-9a-f]{40}$/u, "baseline event SHA");
    exactString(value.context.runId, /^[1-9][0-9]{0,19}$/u, "baseline run ID");
    exactString(value.context.runAttempt, /^[1-9][0-9]{0,9}$/u, "baseline run attempt");
    exactString(value.context.nonce, /^[0-9a-f]{32}$/u, "baseline nonce");
    exactKeys(value.candidate, ["artifactName", "bytes", "path", "sha256"], "baseline candidate");
    if (value.candidate.artifactName !== ARTIFACT_NAME) throw new TypeError("baseline artifact name differs");
    windowsPath(value.candidate.path, "baseline candidate path");
    decimal(value.candidate.bytes, "baseline candidate bytes"); sha256(value.candidate.sha256, "baseline candidate SHA");
    exactKeys(value.fixture, ["bytes", "path", "sha256"], "baseline fixture");
    windowsPath(value.fixture.path, "baseline fixture path"); decimal(value.fixture.bytes, "baseline fixture bytes");
    sha256(value.fixture.sha256, "baseline fixture SHA");
    exactKeys(value.paths, ["populatedWork", "resetWork", "taskRoot"], "baseline paths");
    for (const name of Object.keys(value.paths)) windowsPath(value.paths[name], `baseline ${name}`);
    const prefix = `${value.paths.taskRoot.replace(/\\+$/u, "")}\\`.toLowerCase();
    if (![value.paths.populatedWork, value.paths.resetWork].every(item => item.toLowerCase().startsWith(prefix)) ||
        value.paths.populatedWork.toLowerCase() === value.paths.resetWork.toLowerCase())
        throw new TypeError("baseline work paths differ");
    if (!Array.isArray(value.scenarios) || value.scenarios.length !== EXPECTED_SCENARIOS.length)
        throw new TypeError("baseline scenarios differ");
    const ports = new Set();
    value.scenarios.forEach((scenario, index) => {
        exactKeys(scenario, ["port", "scenario"], "baseline scenario");
        if (scenario.scenario !== EXPECTED_SCENARIOS[index] || !Number.isInteger(scenario.port) ||
            scenario.port < 1 || scenario.port > MAX_PORT || ports.has(scenario.port))
            throw new TypeError("baseline scenario differs");
        ports.add(scenario.port);
    });
    return clone(value);
}

function validateOperations(value) {
    exactKeys(value, OPERATION_NAMES, "baseline guest operations");
    for (const name of OPERATION_NAMES)
        if (typeof value[name] !== "function") throw new TypeError(`baseline guest operation ${name} is absent`);
    return value;
}

function validateNetwork(value) {
    exactKeys(value, ["enabledNonLoopbackInterfaces", "hardwareNics", "nonLoopbackRoutes"], "baseline network");
    for (const name of Object.keys(value))
        if (value[name] !== 0) throw new TypeError("baseline guest network is not isolated");
    return clone(value);
}

function validateClose(value, scenario) {
    exactKeys(value, ["candidateExitCode", "candidateExited", "controllerLifecyclePassed", "forced", "handlesClosed",
        "jobActiveProcesses", "scenario"], "baseline close proof");
    const expectedExit = scenario === "fresh-no-config-reset" ? RESET_EXIT_CODE : SUCCESS_EXIT_CODE;
    if (value.scenario !== scenario || value.controllerLifecyclePassed !== true || value.candidateExited !== true ||
        value.candidateExitCode !== expectedExit || value.forced !== false || value.jobActiveProcesses !== 0 ||
        value.handlesClosed !== true) throw new TypeError("baseline close proof differs");
    return clone(value);
}

function validateOwnedListener(value, ready, port) {
    exactKeys(value, ["candidateCreationTime", "candidatePid", "listenerOwned", "port"],
        "baseline owned listener receipt");
    if (value.listenerOwned !== true || value.candidatePid !== ready.candidatePid ||
        value.candidateCreationTime !== ready.candidateCreationTime || value.port !== port)
        throw new TypeError("baseline owned listener receipt differs");
    return clone(value);
}

function failureMessage(error, maxCharacters = MAX_FAILURE_CHARACTERS) {
    const text = (error instanceof Error ? error.message : String(error)).replace(/[\x00-\x1f\x7f]+/gu, " ")
        .slice(0, maxCharacters);
    return text || "unspecified failure";
}

function combinedFailureMessage(primary, secondary, label) {
    const separator = `; ${label}: `;
    const partCharacters = Math.max(1, Math.floor((MAX_FAILURE_CHARACTERS - separator.length) / 2));
    return `${failureMessage(primary, partCharacters)}${separator}${failureMessage(secondary, partCharacters)}`
        .slice(0, MAX_FAILURE_CHARACTERS);
}

export async function runWindowsBaselineGuest(input, operationValue) {
    let request;
    let operations;
    try { request = validateRequest(input); operations = validateOperations(operationValue); }
    catch (error) { return {schemaVersion: SCHEMA_VERSION, status: "failed", profile: PROFILE, cleanupProven: false,
        failure: failureMessage(error)}; }
    const processes = [], databaseChecks = [], openGraphChecks = [], shutdownProofs = [];
    let currentSession = null;
    let openAttempted = false;
    let cleanupProven = true;
    let failure = null;
    let fixture = null;
    let network = null;
    try {
        fixture = await operations.prepareFixture({request: clone(request), fixture: clone(request.fixture),
            paths: clone(request.paths)});
        exactKeys(fixture, ["expected", "initialDatabase"], "baseline fixture preparation");
        const expected = validatePopulatedDatabase(fixture.expected, null, "baseline fixture expectation");
        const initialDatabase = validatePopulatedDatabase(fixture.initialDatabase, expected,
            "baseline initial database receipt");
        databaseChecks.push({scenario: "preseeded-input", ...initialDatabase});
        network = validateNetwork(await operations.observeNetwork({request: clone(request)}));
        for (const scenario of request.scenarios) {
            openAttempted = true;
            let scenarioFailure = null;
            try {
                currentSession = await operations.openScenario({request: clone(request), fixture: clone(fixture),
                    scenario: scenario.scenario, port: scenario.port});
                if (!isObject(currentSession)) throw new TypeError("baseline scenario session differs");
                const ready = await operations.awaitReady({request: clone(request), session: currentSession,
                    scenario: scenario.scenario, port: scenario.port});
                if (!isObject(ready) || !Number.isInteger(ready.candidatePid) || ready.candidatePid < 1 ||
                    ready.candidatePid > MAX_PROCESS_ID ||
                    typeof ready.candidateCreationTime !== "string" || !/^[0-9a-f]{16}$/u.test(ready.candidateCreationTime))
                    throw new TypeError("baseline scenario readiness differs");
                if (scenario.scenario !== "fresh-no-config-reset")
                    validateOwnedListener(await operations.awaitOwnedListener({request: clone(request),
                        session: currentSession, ready: clone(ready), scenario: scenario.scenario, port: scenario.port}),
                    ready, scenario.port);
                processes.push({scenario: scenario.scenario, pid: ready.candidatePid});
                if (scenario.scenario !== "fresh-no-config-reset") {
                    const checked = await operations.checkPopulated({request: clone(request), session: currentSession,
                        ready: clone(ready), scenario: scenario.scenario, port: scenario.port});
                    openGraphChecks.push({scenario: scenario.scenario, ...validatePopulated(checked)});
                }
            } catch (error) {
                scenarioFailure = error;
                throw error;
            } finally {
                if (currentSession !== null) {
                    try {
                        const closed = validateClose(await operations.closeScenario({request: clone(request),
                            fixture: clone(fixture), session: currentSession, scenario: scenario.scenario}),
                        scenario.scenario);
                        shutdownProofs.push(closed);
                    } catch (error) {
                        cleanupProven = false;
                        if (scenarioFailure !== null)
                            throw new Error(combinedFailureMessage(scenarioFailure, error, "closeScenario"));
                        throw error;
                    }
                    finally { currentSession = null; }
                }
            }
            if (scenario.scenario === "fresh-no-config-reset") {
                const checked = await operations.checkResetDatabase({request: clone(request), fixture: clone(fixture),
                    scenario: scenario.scenario});
                databaseChecks.push({scenario: scenario.scenario, ...validateResetDatabase(checked)});
            } else {
                const checked = await operations.checkPopulatedDatabase({request: clone(request), fixture: clone(fixture),
                    scenario: scenario.scenario});
                databaseChecks.push({scenario: scenario.scenario === "populated-first-boot" ?
                    "after-first-shutdown" : "after-second-shutdown",
                ...validatePopulatedDatabase(checked, expected, "baseline populated database receipt")});
            }
        }
    } catch (error) { failure = error; }
    finally {
        try {
            const cleaned = await operations.cleanupFixture({request: clone(request), fixture, openAttempted});
            if (!isObject(cleaned) || cleaned.cleanupProven !== true) {
                cleanupProven = false;
                const cleanupFailure = isObject(cleaned) && Object.hasOwn(cleaned, "failure") ?
                    new Error(failureMessage(cleaned.failure)) : null;
                if (cleanupFailure !== null)
                    failure = failure === null ? cleanupFailure :
                        new Error(combinedFailureMessage(failure, cleanupFailure, "cleanupFixture"));
            }
        } catch (error) {
            cleanupProven = false;
            failure = failure === null ? error : new Error(combinedFailureMessage(failure, error, "cleanupFixture"));
        }
    }
    if (failure !== null || !cleanupProven) return {schemaVersion: SCHEMA_VERSION, status: "failed", profile: PROFILE,
        cleanupProven, failure: failureMessage(failure ?? new Error("baseline cleanup is incomplete"))};
    const summary = {status: "passed", exit: SUCCESS_EXIT_CODE, mode: "full", sourceSha: request.context.sourceSha,
        artifactSha256: request.candidate.sha256, platform: "win32", architecture: "x64",
        command: [request.candidate.path], processes, databaseChecks, openGraphChecks,
        networkIsolation: {kind: "qemu-nic-none-windows-guest", ...network}, shutdownProofs};
    return {schemaVersion: SCHEMA_VERSION, status: "observed", profile: PROFILE, cleanupProven: true, summary};
}

export const WINDOWS_BASELINE_GUEST_CONSTANTS = Object.freeze({ARTIFACT_NAME, EXPECTED_SCENARIOS,
    MAX_FAILURE_CHARACTERS, PROFILE, REQUEST_KIND});
