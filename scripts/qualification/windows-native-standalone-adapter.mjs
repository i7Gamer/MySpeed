import {createHash} from "node:crypto";

const REQUEST_KIND = "myspeed-windows-native-standalone-adapter-request";
const RESULT_KIND = "myspeed-windows-native-standalone-adapter-result";
const BOUNDARY_KIND = "myspeed-windows-offline-boundary-receipt";
const FIXTURE_KIND = "myspeed-windows-standalone-fixture";
const FIXTURE_CLEANUP_KIND = "myspeed-windows-standalone-fixture-cleanup";
const SESSION_KIND = "myspeed-windows-native-owned-session";
const READY_KIND = "myspeed-windows-native-session-ready";
const CLOSED_KIND = "myspeed-windows-native-session-closed";
const ASSERTIONS_KIND = "myspeed-existing-standalone-assertions";
const RESET_NOTHING_TO_DO_EXIT = 113;
const SUCCESS_EXIT = 0;
const MAXIMUM_ASSERTION_ELAPSED_MILLISECONDS = 600_000;
const MAXIMUM_BOUNDARY_BYTES = 262_144;
const MAXIMUM_BOUNDARY_BASE64_CHARACTERS = Math.ceil(MAXIMUM_BOUNDARY_BYTES / 3) * 4;
const MAXIMUM_FAILURE_DETAIL_CHARACTERS = 512;

export const WINDOWS_NATIVE_ALIASES = Object.freeze(["default", "baseline"]);
export const WINDOWS_NATIVE_ARTIFACTS = Object.freeze([
    "MySpeed-windows-x64.exe", "MySpeed-windows-x64-baseline.exe"
]);
export const WINDOWS_NATIVE_SCENARIOS = Object.freeze([
    "populated-first-boot", "populated-restart", "fresh-no-config-reset"
]);

const isObject = value => value !== null && typeof value === "object" && !Array.isArray(value);

const exactKeys = (value, expected, label) => {
    if (!isObject(value)) throw new Error(`${label} must be an object`);
    const actual = Object.keys(value).sort();
    const keys = [...expected].sort();
    if (actual.length !== keys.length || actual.some((key, index) => key !== keys[index]))
        throw new Error(`${label} keys differ`);
    return value;
};
const string = (value, label, pattern) => {
    if (typeof value !== "string" || value.length === 0 || value.length > 512)
        throw new Error(`${label} must be a bounded string`);
    if (pattern) {
        const match = pattern.exec(value);
        if (!match || match.index !== 0 || match[0].length !== value.length) throw new Error(`${label} differs`);
    }
    return value;
};

const boolean = (value, label) => {
    if (typeof value !== "boolean") throw new Error(`${label} must be Boolean`);
    return value;
};

const integer = (value, label, minimum, maximum) => {
    if (!Number.isSafeInteger(value) || value < minimum || value > maximum)
        throw new Error(`${label} must be an integer from ${minimum} through ${maximum}`);
    return value;
};

const hash = (value, label, length = 64) => string(value, label, new RegExp(`^[0-9a-f]{${length}}$`, "u"));
const token = (value, label) => string(value, label, /^[a-z0-9][a-z0-9._-]{0,127}$/u);
const hashJson = value => createHash("sha256").update(Buffer.from(JSON.stringify(value), "utf8")).digest("hex");

export const assertWindowsNativeBoundaryEvidence = (encoded, expectedSha256) => {
    if (typeof encoded !== "string" || encoded.length < 4 || encoded.length > MAXIMUM_BOUNDARY_BASE64_CHARACTERS)
        throw new Error("Offline boundary bytes must be bounded Base64");
    const bytes = Buffer.from(encoded, "base64");
    if (bytes.length < 2 || bytes.length > MAXIMUM_BOUNDARY_BYTES || bytes.toString("base64") !== encoded
        || createHash("sha256").update(bytes).digest("hex") !== hash(expectedSha256, "Offline boundary SHA"))
        throw new Error("Offline boundary bytes differ");
    let value;
    try { value = JSON.parse(bytes.toString("utf8")); } catch { throw new Error("Offline boundary JSON differs"); }
    exactKeys(value, ["schemaVersion", "providers", "adapters", "ipState"], "Offline boundary evidence");
    integer(value.schemaVersion, "Offline boundary evidence schema", 1, 1);
    exactKeys(value.providers, ["adapters", "ipInterfaces", "ipAddresses", "routes"],
        "Offline boundary providers");
    for (const [name, passed] of Object.entries(value.providers))
        if (!boolean(passed, `Offline boundary provider ${name}`)) throw new Error("Offline boundary provider failed");
    if (!Array.isArray(value.adapters) || value.adapters.length < 1 || value.adapters.length > 256)
        throw new Error("Offline boundary adapters differ");
    const guids = new Set();
    const luids = new Set();
    const indexes = new Set();
    value.adapters.forEach(adapter => {
        exactKeys(adapter, ["interfaceGuid", "netLuid", "hidden", "interfaceType", "interfaceAdminStatus",
            "status", "interfaceIndex", "loopback", "enabled"], "Offline boundary adapter");
        const guid = string(adapter.interfaceGuid, "Offline boundary adapter GUID",
            /^\{[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\}$/u);
        const luid = string(adapter.netLuid, "Offline boundary adapter LUID", /^(?!0{16})[0-9a-f]{16}$/u);
        integer(adapter.interfaceType, "Offline boundary adapter type", 1, 0xffff_ffff);
        integer(adapter.interfaceAdminStatus, "Offline boundary adapter admin status", 1, 2);
        string(adapter.status, "Offline boundary adapter status");
        const index = integer(adapter.interfaceIndex, "Offline boundary adapter index", 1, 0xffff_ffff);
        boolean(adapter.hidden, "Offline boundary adapter hidden");
        const loopback = boolean(adapter.loopback, "Offline boundary adapter loopback");
        const enabled = boolean(adapter.enabled, "Offline boundary adapter enabled");
        if (guids.has(guid) || luids.has(luid) || indexes.has(index))
            throw new Error("Offline boundary adapter identity is duplicated");
        guids.add(guid); luids.add(luid); indexes.add(index);
        if (!loopback && enabled) throw new Error("Offline boundary retained an enabled non-loopback adapter");
    });
    if (!Array.isArray(value.ipState) || value.ipState.length < 3 || value.ipState.length > 4096)
        throw new Error("Offline boundary IP state differs");
    const kinds = new Set();
    value.ipState.forEach(state => {
        exactKeys(state, ["kind", "compartmentId", "loopback", "routable"], "Offline boundary IP state");
        const kind = string(state.kind, "Offline boundary IP kind", /^(?:address|interface|route)$/u);
        kinds.add(kind);
        integer(state.compartmentId, "Offline boundary compartment", 0, 0xffff_ffff);
        const loopback = boolean(state.loopback, "Offline boundary IP loopback");
        const routable = boolean(state.routable, "Offline boundary IP routable");
        if (!loopback && routable) throw new Error("Offline boundary retained non-loopback routable state");
    });
    if (["address", "interface", "route"].some(kind => !kinds.has(kind)))
        throw new Error("Offline boundary IP state is incomplete");
    return value;
};

const assertBindings = (value, request, alias, scenario, label) => {
    const expected = {
        expectedRunId: request.expectedRunId,
        expectedRunAttempt: request.expectedRunAttempt,
        expectedSourceSha: request.expectedSourceSha,
        expectedEventSha: request.expectedEventSha,
        nonce: request.nonce,
        alias
    };
    if (scenario !== null) expected.scenario = scenario;
    for (const [name, expectedValue] of Object.entries(expected))
        if (string(value[name], `${label} ${name}`) !== expectedValue) throw new Error(`${label} binding differs: ${name}`);
};

export const assertWindowsNativeAdapterRequest = value => {
    exactKeys(value, ["schemaVersion", "kind", "qualifying", "expectedRunId", "expectedRunAttempt",
        "expectedSourceSha", "expectedEventSha", "expectedImageVersion", "nonce", "aliases"], "Adapter request");
    integer(value.schemaVersion, "Adapter request schema", 1, 1);
    if (string(value.kind, "Adapter request kind") !== REQUEST_KIND) throw new Error("Adapter request kind differs");
    if (boolean(value.qualifying, "Adapter request qualifying")) throw new Error("Adapter request must remain nonqualifying");
    string(value.expectedRunId, "Adapter request run ID", /^[1-9][0-9]{0,19}$/u);
    string(value.expectedRunAttempt, "Adapter request run attempt", /^[1-9][0-9]{0,9}$/u);
    hash(value.expectedSourceSha, "Adapter request source SHA", 40);
    hash(value.expectedEventSha, "Adapter request event SHA", 40);
    token(value.expectedImageVersion, "Adapter request image version");
    hash(value.nonce, "Adapter request nonce", 32);
    if (!Array.isArray(value.aliases) || value.aliases.length !== WINDOWS_NATIVE_ALIASES.length)
        throw new Error("Adapter request aliases differ");
    value.aliases.forEach((entry, index) => {
        exactKeys(entry, ["alias", "candidateSha256", "artifactLogicalName"], "Adapter alias");
        if (token(entry.alias, "Adapter alias name") !== WINDOWS_NATIVE_ALIASES[index])
            throw new Error("Adapter request alias order differs");
        hash(entry.candidateSha256, "Adapter candidate SHA");
        if (string(entry.artifactLogicalName, "Adapter artifact logical name") !== WINDOWS_NATIVE_ARTIFACTS[index])
            throw new Error("Adapter artifact logical identity differs");
    });
    if (new Set(value.aliases.map(({artifactLogicalName}) => artifactLogicalName)).size !== value.aliases.length)
        throw new Error("Adapter artifact logical names must be distinct");
    return value;
};

const assertOperations = operations => {
    const names = ["observeOffline", "prepareFixture", "openOwnedSession", "launchOwnedSession",
        "runExistingAssertions", "closeOwnedSession", "cleanupFixture"];
    exactKeys(operations, names, "Adapter operations");
    for (const name of names) if (typeof operations[name] !== "function") throw new Error(`Adapter operation ${name} is absent`);
};

const assertBoundary = (value, request, alias, scenario, phase) => {
    const keys = ["schemaVersion", "kind", "qualifying", "expectedRunId", "expectedRunAttempt",
        "expectedSourceSha", "expectedEventSha", "nonce", "alias", "phase", "boundarySha256", "boundaryBase64",
        "offlineBoundaryPassed"];
    if (scenario !== null) keys.push("scenario");
    exactKeys(value, keys, "Offline boundary receipt");
    integer(value.schemaVersion, "Offline boundary schema", 1, 1);
    if (string(value.kind, "Offline boundary kind") !== BOUNDARY_KIND) throw new Error("Offline boundary kind differs");
    if (boolean(value.qualifying, "Offline boundary qualifying")) throw new Error("Offline boundary must remain nonqualifying");
    assertBindings(value, request, alias, scenario, "Offline boundary");
    if (string(value.phase, "Offline boundary phase") !== phase) throw new Error("Offline boundary phase differs");
    assertWindowsNativeBoundaryEvidence(value.boundaryBase64, value.boundarySha256);
    if (!boolean(value.offlineBoundaryPassed, "Offline boundary result")) throw new Error("Offline boundary did not pass");
    return value;
};

const assertFixture = (value, request, ownership) => {
    exactKeys(value, ["schemaVersion", "kind", "expectedRunId", "expectedRunAttempt", "expectedSourceSha",
        "expectedEventSha", "nonce", "alias", "fixtureId", "manifestSha256", "prepared"], "Fixture receipt");
    integer(value.schemaVersion, "Fixture schema", 1, 1);
    if (string(value.kind, "Fixture kind") !== FIXTURE_KIND) throw new Error("Fixture kind differs");
    assertBindings(value, request, ownership.alias, null, "Fixture");
    if (token(value.fixtureId, "Fixture ID") !== ownership.fixtureId) throw new Error("Fixture ownership differs");
    hash(value.manifestSha256, "Fixture manifest SHA");
    if (!boolean(value.prepared, "Fixture prepared")) throw new Error("Fixture was not prepared");
    return value;
};

const assertSession = (value, request, aliasRecord, scenario, ownership) => {
    exactKeys(value, ["schemaVersion", "kind", "expectedRunId", "expectedRunAttempt", "expectedSourceSha",
        "expectedEventSha", "nonce", "alias", "scenario", "sessionId", "candidateSha256", "artifactLogicalName",
        "ownershipEstablished"],
    "Owned session");
    integer(value.schemaVersion, "Owned session schema", 1, 1);
    if (string(value.kind, "Owned session kind") !== SESSION_KIND) throw new Error("Owned session kind differs");
    assertBindings(value, request, aliasRecord.alias, scenario, "Owned session");
    if (hash(value.sessionId, "Owned session ID", 32) !== ownership.sessionId)
        throw new Error("Owned session identity differs");
    if (hash(value.candidateSha256, "Owned session candidate SHA") !== aliasRecord.candidateSha256)
        throw new Error("Owned session candidate differs");
    if (string(value.artifactLogicalName, "Owned session artifact logical name") !== aliasRecord.artifactLogicalName)
        throw new Error("Owned session artifact identity differs");
    if (!boolean(value.ownershipEstablished, "Owned session ownership")) throw new Error("Owned session ownership is absent");
    return value;
};

const assertReady = (value, request, session) => {
    exactKeys(value, ["schemaVersion", "kind", "expectedRunId", "expectedRunAttempt", "expectedSourceSha",
        "expectedEventSha", "nonce", "alias", "scenario", "sessionId", "candidateSha256", "artifactLogicalName", "candidatePid",
        "candidateCreationTime", "retainedHandleAuthority", "jobAssignedBeforeResume", "handleListConfigured"],
    "Session readiness");
    integer(value.schemaVersion, "Session readiness schema", 1, 1);
    if (string(value.kind, "Session readiness kind") !== READY_KIND) throw new Error("Session readiness kind differs");
    assertBindings(value, request, session.alias, session.scenario, "Session readiness");
    if (hash(value.sessionId, "Session readiness ID", 32) !== session.sessionId
        || hash(value.candidateSha256, "Session readiness candidate SHA") !== session.candidateSha256)
        throw new Error("Session readiness identity differs");
    if (string(value.artifactLogicalName, "Session readiness artifact logical name") !== session.artifactLogicalName)
        throw new Error("Session readiness artifact identity differs");
    integer(value.candidatePid, "Session readiness PID", 1, 0xffff_ffff);
    hash(value.candidateCreationTime, "Session readiness creation time", 16);
    for (const name of ["retainedHandleAuthority", "jobAssignedBeforeResume", "handleListConfigured"])
        if (!boolean(value[name], `Session readiness ${name}`)) throw new Error(`Session readiness proof failed: ${name}`);
    return value;
};

const assertAssertions = (value, request, session, stage) => {
    exactKeys(value, ["schemaVersion", "kind", "expectedRunId", "expectedRunAttempt", "expectedSourceSha",
        "expectedEventSha", "nonce", "alias", "scenario", "sessionId", "stage", "status", "summary", "summarySha256"],
    "Existing assertion receipt");
    integer(value.schemaVersion, "Existing assertion schema", 1, 1);
    if (string(value.kind, "Existing assertion kind") !== ASSERTIONS_KIND) throw new Error("Existing assertion kind differs");
    assertBindings(value, request, session.alias, session.scenario, "Existing assertions");
    if (hash(value.sessionId, "Existing assertion session ID", 32) !== session.sessionId
        || string(value.stage, "Existing assertion stage", /^(running|post-stop)$/u) !== stage
        || string(value.status, "Existing assertion status", /^passed$/u) !== "passed")
        throw new Error("Existing assertions did not pass for this session");
    exactKeys(value.summary, stage === "running" ? ["elapsedMs"]
        : session.scenario === "fresh-no-config-reset" ? ["integrity", "configTable"]
            : ["ping", "resultId", "passwordValueSha256"], "Existing assertion summary");
    if (stage === "running") integer(value.summary.elapsedMs, "Existing assertion elapsed time", 0,
        MAXIMUM_ASSERTION_ELAPSED_MILLISECONDS);
    else if (session.scenario === "fresh-no-config-reset") {
        if (value.summary.integrity !== "ok" || boolean(value.summary.configTable, "Reset database config table"))
            throw new Error("Reset database assertion summary differs");
    } else {
        string(value.summary.ping, "Populated database ping");
        string(value.summary.resultId, "Populated database result ID");
        hash(value.summary.passwordValueSha256, "Populated database password fingerprint");
    }
    if (hash(value.summarySha256, "Existing assertion summary SHA") !== hashJson(value.summary))
        throw new Error("Existing assertion summary SHA differs");
    return value;
};

const assertClosed = (value, request, ownership, ready, sessionEstablished, launchAttempted) => {
    exactKeys(value, ["schemaVersion", "kind", "expectedRunId", "expectedRunAttempt", "expectedSourceSha",
        "expectedEventSha", "nonce", "alias", "scenario", "sessionId", "artifactLogicalName", "status", "stopKind", "candidateStarted",
        "candidateExited", "exitCode", "processTreeExitProven", "jobActiveProcesses", "handlesClosed", "listenerGone", "forced"],
    "Closed session");
    integer(value.schemaVersion, "Closed session schema", 1, 1);
    if (string(value.kind, "Closed session kind") !== CLOSED_KIND) throw new Error("Closed session kind differs");
    assertBindings(value, request, ownership.alias, ownership.scenario, "Closed session");
    if (hash(value.sessionId, "Closed session ID", 32) !== ownership.sessionId
        || string(value.status, "Closed session status", /^completed$/u) !== "completed")
        throw new Error("Closed session identity or status differs");
    if (string(value.artifactLogicalName, "Closed session artifact logical name") !== ownership.artifactLogicalName)
        throw new Error("Closed session artifact identity differs");
    const reset = ownership.scenario === "fresh-no-config-reset";
    const candidateStarted = boolean(value.candidateStarted, "Closed session candidate started");
    if ((!sessionEstablished || !launchAttempted) && candidateStarted)
        throw new Error("Unused owned session was reported started at close");
    if (ready !== null && !candidateStarted) throw new Error("Ready session was not reported started at close");
    const expectedStop = candidateStarted ? (reset ? "observed-exit" : "ctrl-c") : "cleanup";
    if (string(value.stopKind, "Closed session stop kind") !== expectedStop)
        throw new Error("Closed session stop behavior differs");
    const candidateExited = boolean(value.candidateExited, "Closed session candidate exited");
    const forced = boolean(value.forced, "Closed session forced");
    if (!candidateStarted) {
        if (candidateExited || value.exitCode !== null || forced) throw new Error("Closed unused session evidence differs");
    } else {
        if (!candidateExited) throw new Error("Closed session candidate exit was not proven");
        const exitCode = integer(value.exitCode, "Closed session exit code", 0, 0xffff_ffff);
        if (ready !== null && (exitCode !== (reset ? RESET_NOTHING_TO_DO_EXIT : SUCCESS_EXIT) || forced))
            throw new Error("Closed session stop behavior differs");
    }
    for (const name of ["processTreeExitProven", "handlesClosed", "listenerGone"])
        if (!boolean(value[name], `Closed session ${name}`)) throw new Error(`Closed session proof failed: ${name}`);
    if (integer(value.jobActiveProcesses, "Closed session active process count", 0, 0xffff_ffff) !== 0)
        throw new Error("Closed session retained processes");
    return value;
};

const assertFixtureCleanup = (value, request, ownership) => {
    exactKeys(value, ["schemaVersion", "kind", "expectedRunId", "expectedRunAttempt", "expectedSourceSha",
        "expectedEventSha", "nonce", "alias", "fixtureId", "cleanupProven"], "Fixture cleanup");
    integer(value.schemaVersion, "Fixture cleanup schema", 1, 1);
    if (string(value.kind, "Fixture cleanup kind") !== FIXTURE_CLEANUP_KIND) throw new Error("Fixture cleanup kind differs");
    assertBindings(value, request, ownership.alias, null, "Fixture cleanup");
    if (token(value.fixtureId, "Fixture cleanup ID") !== ownership.fixtureId
        || !boolean(value.cleanupProven, "Fixture cleanup proof")) throw new Error("Fixture cleanup was not proven");
    return value;
};

const failureDetail = error => {
    const message = error instanceof Error ? error.message : String(error);
    const normalized = message.replace(/[\u0000-\u001f\u007f]+/gu, " ").replace(/\s+/gu, " ").trim();
    return (normalized || "Unknown failure").slice(0, MAXIMUM_FAILURE_DETAIL_CHARACTERS);
};
const failure = (stage, error) => ({stage, classification: "failed", detail: failureDetail(error)});
const ownershipId = (...parts) => createHash("sha256").update(parts.join("\0"), "utf8").digest("hex").slice(0, 32);

export const runWindowsNativeStandaloneAdapter = async (input, operations) => {
    const request = assertWindowsNativeAdapterRequest(input);
    assertOperations(operations);
    const failures = [];
    const aliases = [];

    for (const aliasRecord of request.aliases) {
        if (failures.length > 0) break;
        const aliasResult = {alias: aliasRecord.alias, artifactLogicalName: aliasRecord.artifactLogicalName,
            candidateSha256: aliasRecord.candidateSha256, beforeFixtureBoundary: null, fixture: null,
            scenarios: [], fixtureCleanup: null};
        aliases.push(aliasResult);
        const fixtureOwnership = {alias: aliasRecord.alias,
            fixtureId: `${request.nonce}-${aliasRecord.alias}`};
        let fixture = null;
        let fixtureCleanupRequired = false;
        let aliasStage = "offline-before-fixture";
        try {
            aliasResult.beforeFixtureBoundary = structuredClone(assertBoundary(await operations.observeOffline(
                {alias: aliasRecord.alias, phase: "before-fixture", scenario: null}),
            request, aliasRecord.alias, null, "before-fixture"));
            fixtureCleanupRequired = true;
            aliasStage = "prepare-fixture";
            fixture = assertFixture(await operations.prepareFixture({alias: aliasRecord.alias,
                ownership: fixtureOwnership}), request, fixtureOwnership);
            aliasResult.fixture = structuredClone(fixture);

            for (const scenario of WINDOWS_NATIVE_SCENARIOS) {
                if (failures.length > 0) break;
                const scenarioResult = {scenario, beforeLaunchBoundary: null, session: null, ready: null,
                    assertions: [], closed: null, afterStopBoundary: null, passed: false};
                aliasResult.scenarios.push(scenarioResult);
                let session = null;
                const sessionOwnership = {alias: aliasRecord.alias, scenario,
                    sessionId: ownershipId(request.nonce, aliasRecord.alias, scenario),
                    candidateSha256: aliasRecord.candidateSha256,
                    artifactLogicalName: aliasRecord.artifactLogicalName};
                let sessionCleanupRequired = false;
                let launchAttempted = false;
                let ready = null;
                let runningAssertionsPassed = false;
                let scenarioStage = "offline-before-launch";
                try {
                    scenarioResult.beforeLaunchBoundary = structuredClone(assertBoundary(await operations.observeOffline(
                        {alias: aliasRecord.alias, scenario, phase: "before-launch"}),
                    request, aliasRecord.alias, scenario, "before-launch"));
                    sessionCleanupRequired = true;
                    scenarioStage = "open-owned-session";
                    session = assertSession(await operations.openOwnedSession({alias: aliasRecord.alias, scenario,
                        candidateSha256: aliasRecord.candidateSha256, artifactLogicalName: aliasRecord.artifactLogicalName,
                        fixture, ownership: sessionOwnership}),
                    request, aliasRecord, scenario, sessionOwnership);
                    scenarioResult.session = structuredClone(session);
                    scenarioStage = "launch-owned-session";
                    launchAttempted = true;
                    ready = assertReady(await operations.launchOwnedSession({session, fixture}), request, session);
                    scenarioResult.ready = structuredClone(ready);
                    if (scenario !== "fresh-no-config-reset") {
                        scenarioStage = "running-assertions";
                        scenarioResult.assertions.push(structuredClone(assertAssertions(
                            await operations.runExistingAssertions({session, fixture, stage: "running"}),
                            request, session, "running")));
                    }
                    runningAssertionsPassed = true;
                } catch (error) {
                    failures.push(failure(scenarioStage, error));
                } finally {
                    if (sessionCleanupRequired) {
                        try { scenarioResult.closed = structuredClone(assertClosed(await operations.closeOwnedSession({session, fixture,
                            ownership: sessionOwnership}), request, sessionOwnership, ready,
                        session !== null, launchAttempted)); }
                        catch (error) { failures.push(failure("close-owned-session", error)); }
                        try {
                            scenarioResult.afterStopBoundary = structuredClone(assertBoundary(await operations.observeOffline(
                                {alias: aliasRecord.alias, scenario, phase: "after-stop"}),
                            request, aliasRecord.alias, scenario, "after-stop"));
                        } catch (error) { failures.push(failure("offline-after-stop", error)); }
                    }
                }
                if (runningAssertionsPassed && failures.length === 0) {
                    try {
                        scenarioResult.assertions.push(structuredClone(assertAssertions(
                            await operations.runExistingAssertions({session, fixture, stage: "post-stop"}),
                            request, session, "post-stop")));
                        scenarioResult.passed = true;
                    } catch (error) { failures.push(failure("post-stop-assertions", error)); }
                }
            }
        } catch (error) {
            failures.push(failure(aliasStage, error));
        } finally {
            if (fixtureCleanupRequired) {
                try { aliasResult.fixtureCleanup = structuredClone(assertFixtureCleanup(
                    await operations.cleanupFixture({fixture, ownership: fixtureOwnership}),
                    request, fixtureOwnership)); }
                catch (error) { failures.push(failure("cleanup-fixture", error)); }
            }
        }
    }

    const completed = failures.length === 0 && aliases.length === WINDOWS_NATIVE_ALIASES.length
        && aliases.every(alias => alias.scenarios.length === WINDOWS_NATIVE_SCENARIOS.length
            && alias.scenarios.every(scenario => scenario.passed));
    return {
        schemaVersion: 1,
        kind: RESULT_KIND,
        status: completed ? "completed" : "failed",
        qualifying: false,
        adapterPassed: completed,
        sourceSha: request.expectedSourceSha,
        eventSha: request.expectedEventSha,
        runId: request.expectedRunId,
        runAttempt: request.expectedRunAttempt,
        imageVersion: request.expectedImageVersion,
        nonce: request.nonce,
        aliases,
        failures,
        releaseGatesCleared: []
    };
};

export const assertWindowsNativeAdapterResult = (value, requestValue) => {
    const request = assertWindowsNativeAdapterRequest(requestValue);
    exactKeys(value, ["schemaVersion", "kind", "status", "qualifying", "adapterPassed", "sourceSha", "eventSha",
        "runId", "runAttempt", "imageVersion", "nonce", "aliases", "failures", "releaseGatesCleared"],
    "Adapter result");
    integer(value.schemaVersion, "Adapter result schema", 1, 1);
    if (string(value.kind, "Adapter result kind") !== RESULT_KIND || value.status !== "completed"
        || boolean(value.qualifying, "Adapter result qualifying") || !boolean(value.adapterPassed, "Adapter result pass"))
        throw new Error("Adapter result did not complete");
    const bindings = {sourceSha: request.expectedSourceSha, eventSha: request.expectedEventSha,
        runId: request.expectedRunId, runAttempt: request.expectedRunAttempt,
        imageVersion: request.expectedImageVersion, nonce: request.nonce};
    for (const [name, expected] of Object.entries(bindings))
        if (string(value[name], `Adapter result ${name}`) !== expected) throw new Error(`Adapter result binding differs: ${name}`);
    if (!Array.isArray(value.failures) || value.failures.length !== 0 || !Array.isArray(value.releaseGatesCleared)
        || value.releaseGatesCleared.length !== 0) throw new Error("Adapter result retained a failure or release gate");
    if (!Array.isArray(value.aliases) || value.aliases.length !== WINDOWS_NATIVE_ALIASES.length)
        throw new Error("Adapter result aliases differ");
    value.aliases.forEach((alias, aliasIndex) => {
        const aliasRequest = request.aliases[aliasIndex];
        exactKeys(alias, ["alias", "artifactLogicalName", "candidateSha256", "beforeFixtureBoundary", "fixture",
            "scenarios", "fixtureCleanup"], "Adapter result alias");
        if (alias.alias !== aliasRequest.alias || alias.artifactLogicalName !== aliasRequest.artifactLogicalName
            || alias.candidateSha256 !== aliasRequest.candidateSha256) throw new Error("Adapter result alias binding differs");
        assertBoundary(alias.beforeFixtureBoundary, request, alias.alias, null, "before-fixture");
        const fixtureOwnership = {alias: alias.alias, fixtureId: `${request.nonce}-${alias.alias}`};
        assertFixture(alias.fixture, request, fixtureOwnership);
        if (!Array.isArray(alias.scenarios) || alias.scenarios.length !== WINDOWS_NATIVE_SCENARIOS.length)
            throw new Error("Adapter result scenarios differ");
        alias.scenarios.forEach((scenario, scenarioIndex) => {
            const expectedScenario = WINDOWS_NATIVE_SCENARIOS[scenarioIndex];
            exactKeys(scenario, ["scenario", "beforeLaunchBoundary", "session", "ready", "assertions", "closed",
                "afterStopBoundary", "passed"], "Adapter result scenario");
            if (scenario.scenario !== expectedScenario || !boolean(scenario.passed, "Adapter result scenario pass"))
                throw new Error("Adapter result scenario differs");
            assertBoundary(scenario.beforeLaunchBoundary, request, alias.alias, expectedScenario, "before-launch");
            const ownership = {alias: alias.alias, scenario: expectedScenario,
                sessionId: ownershipId(request.nonce, alias.alias, expectedScenario),
                candidateSha256: alias.candidateSha256, artifactLogicalName: alias.artifactLogicalName};
            assertSession(scenario.session, request, aliasRequest, expectedScenario, ownership);
            assertReady(scenario.ready, request, scenario.session);
            const expectedStages = expectedScenario === "fresh-no-config-reset" ? ["post-stop"] : ["running", "post-stop"];
            if (!Array.isArray(scenario.assertions) || scenario.assertions.length !== expectedStages.length)
                throw new Error("Adapter result assertion receipts differ");
            scenario.assertions.forEach((receipt, index) =>
                assertAssertions(receipt, request, scenario.session, expectedStages[index]));
            assertClosed(scenario.closed, request, ownership, scenario.ready, true, true);
            assertBoundary(scenario.afterStopBoundary, request, alias.alias, expectedScenario, "after-stop");
        });
        assertFixtureCleanup(alias.fixtureCleanup, request, fixtureOwnership);
    });
    return value;
};
