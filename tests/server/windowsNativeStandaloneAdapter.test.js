import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {describe, it} from "node:test";

import {
    WINDOWS_NATIVE_ALIASES,
    WINDOWS_NATIVE_SCENARIOS,
    assertWindowsNativeBoundaryEvidence,
    assertWindowsNativeAdapterRequest,
    runWindowsNativeStandaloneAdapter
} from "../../scripts/qualification/windows-native-standalone-adapter.mjs";

const SOURCE_SHA = "a".repeat(40);
const EVENT_SHA = "b".repeat(40);
const NONCE = "c".repeat(32);
const HASH = "d".repeat(64);
const summarySha = value => createHash("sha256").update(Buffer.from(JSON.stringify(value), "utf8")).digest("hex");
const OFFLINE_EVIDENCE = {schemaVersion: 1,
    providers: {adapters: true, ipInterfaces: true, ipAddresses: true, routes: true},
    adapters: [{interfaceGuid: "{11111111-1111-1111-1111-111111111111}", netLuid: "0000000000000001",
        hidden: false, interfaceType: 6, interfaceAdminStatus: 2, status: "Disabled", interfaceIndex: 4,
        loopback: false, enabled: false}],
    ipState: ["address", "interface", "route"].map(kind => ({kind, compartmentId: 1, loopback: false,
        routable: false}))};
const OFFLINE_BYTES = Buffer.from(JSON.stringify(OFFLINE_EVIDENCE), "utf8");
const OFFLINE_SHA = createHash("sha256").update(OFFLINE_BYTES).digest("hex");
const OFFLINE_BASE64 = OFFLINE_BYTES.toString("base64");

const request = () => ({
    schemaVersion: 1,
    kind: "myspeed-windows-native-standalone-adapter-request",
    qualifying: false,
    expectedRunId: "12345",
    expectedRunAttempt: "2",
    expectedSourceSha: SOURCE_SHA,
    expectedEventSha: EVENT_SHA,
    expectedImageVersion: "20260913.1",
    nonce: NONCE,
    aliases: WINDOWS_NATIVE_ALIASES.map((alias, index) => ({
        alias,
        candidateSha256: String(index + 1).repeat(64),
        artifactLogicalName: alias === "default" ? "MySpeed-windows-x64.exe" : "MySpeed-windows-x64-baseline.exe"
    }))
});
const makeHarness = ({failAt = null, badPostStop = false} = {}) => {
    const events = [];
    let sessionOrdinal = 0;
    const fail = stage => {
        events.push(stage);
        if (stage === failAt) throw new Error(`injected ${stage}`);
    };
    const bound = (alias, scenario = null) => ({
        expectedRunId: "12345", expectedRunAttempt: "2", expectedSourceSha: SOURCE_SHA,
        expectedEventSha: EVENT_SHA, nonce: NONCE, alias, ...(scenario ? {scenario} : {})
    });
    const operations = {
        observeOffline: async ({alias, phase, scenario}) => {
            fail(`offline:${alias}:${phase}${scenario ? `:${scenario}` : ""}`);
            return {schemaVersion: 1, kind: "myspeed-windows-offline-boundary-receipt", qualifying: false,
                ...bound(alias, scenario), phase, boundarySha256: OFFLINE_SHA, boundaryBase64: OFFLINE_BASE64,
                offlineBoundaryPassed: badPostStop && phase === "after-stop" ? false : true};
        },
        prepareFixture: async ({alias, ownership}) => {
            fail(`fixture:${alias}:prepare`);
            return {schemaVersion: 1, kind: "myspeed-windows-standalone-fixture", ...bound(alias),
                fixtureId: ownership.fixtureId, manifestSha256: HASH, prepared: true};
        },
        openOwnedSession: async ({alias, scenario, candidateSha256, artifactLogicalName, ownership}) => {
            sessionOrdinal += 1;
            const session = {schemaVersion: 1, kind: "myspeed-windows-native-owned-session",
                ...bound(alias, scenario), sessionId: ownership.sessionId, candidateSha256, artifactLogicalName,
                ownershipEstablished: true};
            fail(`session:${alias}:${scenario}:open`);
            return session;
        },
        launchOwnedSession: async ({session}) => {
            fail(`session:${session.alias}:${session.scenario}:launch`);
            return {schemaVersion: 1, kind: "myspeed-windows-native-session-ready", ...bound(session.alias, session.scenario),
                sessionId: session.sessionId, candidateSha256: session.candidateSha256, candidatePid: 4000 + sessionOrdinal,
                artifactLogicalName: session.artifactLogicalName,
                candidateCreationTime: sessionOrdinal.toString(16).padStart(16, "0"), retainedHandleAuthority: true,
                jobAssignedBeforeResume: true, handleListConfigured: true};
        },
        runExistingAssertions: async ({session, stage}) => {
            fail(`assert:${session.alias}:${session.scenario}:${stage}`);
            const summary = stage === "running" ? {elapsedMs: 1}
                : session.scenario === "fresh-no-config-reset" ? {integrity: "ok", configTable: false}
                    : {ping: "synthetic", resultId: "synthetic", passwordValueSha256: HASH};
            return {schemaVersion: 1, kind: "myspeed-existing-standalone-assertions", ...bound(session.alias, session.scenario),
                sessionId: session.sessionId, stage, status: "passed", summary, summarySha256: summarySha(summary)};
        },
        closeOwnedSession: async ({session, ownership}) => {
            const observed = session ?? ownership;
            fail(`session:${observed.alias}:${observed.scenario}:close`);
            const reset = observed.scenario === "fresh-no-config-reset";
            const candidateStarted = session !== null;
            return {schemaVersion: 1, kind: "myspeed-windows-native-session-closed", ...bound(observed.alias, observed.scenario),
                sessionId: ownership.sessionId, artifactLogicalName: ownership.artifactLogicalName,
                status: "completed", stopKind: candidateStarted ? (reset ? "observed-exit" : "ctrl-c") : "cleanup",
                candidateStarted, candidateExited: candidateStarted, exitCode: candidateStarted ? (reset ? 113 : 0) : null,
                processTreeExitProven: true,
                jobActiveProcesses: 0, handlesClosed: true, listenerGone: true, forced: false};
        },
        cleanupFixture: async ({fixture, ownership}) => {
            const alias = fixture?.alias ?? ownership.alias;
            fail(`fixture:${alias}:cleanup`);
            return {schemaVersion: 1, kind: "myspeed-windows-standalone-fixture-cleanup", ...bound(alias),
                fixtureId: ownership.fixtureId, cleanupProven: true};
        }
    };
    return {events, operations};
};

describe("Windows native standalone adapter", () => {
    it("recomputes raw offline provider evidence instead of trusting its pass Boolean", () => {
        assert.deepEqual(assertWindowsNativeBoundaryEvidence(OFFLINE_BASE64, OFFLINE_SHA), OFFLINE_EVIDENCE);
        for (const mutate of [
            value => { value.adapters[0].enabled = true; },
            value => { value.ipState[0].routable = true; },
            value => { value.ipState = value.ipState.filter(entry => entry.kind !== "route"); },
            value => { value.providers.routes = false; },
            value => { value.adapters[0].extra = true; }
        ]) {
            const changed = structuredClone(OFFLINE_EVIDENCE);
            mutate(changed);
            const bytes = Buffer.from(JSON.stringify(changed), "utf8");
            const digest = createHash("sha256").update(bytes).digest("hex");
            assert.throws(() => assertWindowsNativeBoundaryEvidence(bytes.toString("base64"), digest));
        }
    });

    it("drives both aliases through the exact existing full-mode scenario sequence", async () => {
        const harness = makeHarness();
        const result = await runWindowsNativeStandaloneAdapter(request(), harness.operations);
        assert.equal(result.status, "completed");
        assert.equal(result.qualifying, false);
        assert.deepEqual(result.releaseGatesCleared, []);
        assert.deepEqual(result.aliases.map(({alias}) => alias), WINDOWS_NATIVE_ALIASES);
        assert.deepEqual(result.aliases.map(({artifactLogicalName}) => artifactLogicalName),
            ["MySpeed-windows-x64.exe", "MySpeed-windows-x64-baseline.exe"]);
        for (const alias of result.aliases) {
            assert.deepEqual(alias.scenarios.map(({scenario}) => scenario), WINDOWS_NATIVE_SCENARIOS);
            assert.ok(alias.scenarios.every(({passed}) => passed));
        }
        const expectedEvents = WINDOWS_NATIVE_ALIASES.flatMap(alias => [
            `offline:${alias}:before-fixture`,
            `fixture:${alias}:prepare`,
            ...WINDOWS_NATIVE_SCENARIOS.flatMap(scenario => [
                `offline:${alias}:before-launch:${scenario}`,
                `session:${alias}:${scenario}:open`,
                `session:${alias}:${scenario}:launch`,
                ...(scenario === "fresh-no-config-reset" ? [] : [`assert:${alias}:${scenario}:running`]),
                `session:${alias}:${scenario}:close`,
                `offline:${alias}:after-stop:${scenario}`,
                `assert:${alias}:${scenario}:post-stop`
            ]),
            `fixture:${alias}:cleanup`
        ]);
        assert.deepEqual(harness.events, expectedEvents);
    });

    it("closes the owned session, rechecks offline state, and cleans the fixture after an assertion failure", async () => {
        const harness = makeHarness({failAt: "assert:default:populated-first-boot:running"});
        const result = await runWindowsNativeStandaloneAdapter(request(), harness.operations);
        assert.equal(result.status, "failed");
        assert.deepEqual(result.failures[0], {stage: "running-assertions", classification: "failed"});
        assert.ok(harness.events.includes("session:default:populated-first-boot:close"));
        assert.ok(harness.events.includes("offline:default:after-stop:populated-first-boot"));
        assert.equal(harness.events.at(-1), "fixture:default:cleanup");
        assert.ok(!harness.events.some(event => event.startsWith("fixture:baseline")));
    });

    it("cleans a partially launched owned session", async () => {
        const harness = makeHarness({failAt: "session:default:populated-first-boot:launch"});
        const result = await runWindowsNativeStandaloneAdapter(request(), harness.operations);
        assert.equal(result.status, "failed");
        assert.ok(harness.events.includes("session:default:populated-first-boot:close"));
        assert.ok(harness.events.includes("offline:default:after-stop:populated-first-boot"));
        assert.equal(harness.events.at(-1), "fixture:default:cleanup");
    });

    it("still rechecks the boundary and fixture cleanup when owned-session close fails", async () => {
        const harness = makeHarness({failAt: "session:default:populated-first-boot:close"});
        const result = await runWindowsNativeStandaloneAdapter(request(), harness.operations);
        assert.equal(result.status, "failed");
        assert.deepEqual(result.failures[0], {stage: "close-owned-session", classification: "failed"});
        assert.ok(harness.events.includes("offline:default:after-stop:populated-first-boot"));
        assert.equal(harness.events.at(-1), "fixture:default:cleanup");
    });

    it("rejects every false successful close proof while retaining cleanup", async () => {
        const mutations = [
            value => Object.assign(value, {stopKind: "cleanup", candidateStarted: false,
                candidateExited: false, exitCode: null}),
            value => { value.stopKind = "cleanup"; },
            value => { value.candidateExited = false; },
            value => { value.exitCode = 1; },
            value => { value.forced = true; },
            value => { value.jobActiveProcesses = 1; },
            value => { value.processTreeExitProven = false; },
            value => { value.handlesClosed = false; },
            value => { value.listenerGone = false; },
            value => { value.sessionId = "e".repeat(32); },
            value => { value.artifactLogicalName = "MySpeed-windows-x64-baseline.exe"; },
            value => { value.status = "failed"; }
        ];
        for (const mutate of mutations) {
            const harness = makeHarness();
            const close = harness.operations.closeOwnedSession;
            harness.operations.closeOwnedSession = async input => {
                const value = await close(input);
                mutate(value);
                return value;
            };
            const result = await runWindowsNativeStandaloneAdapter(request(), harness.operations);
            assert.equal(result.status, "failed");
            assert.deepEqual(result.failures[0], {stage: "close-owned-session", classification: "failed"});
            assert.ok(harness.events.includes("offline:default:after-stop:populated-first-boot"));
            assert.equal(harness.events.at(-1), "fixture:default:cleanup");
        }
    });

    it("rejects every false never-started close proof and permits a proven forced partial launch", async () => {
        const neverStartedMutations = [
            value => { value.candidateStarted = true; },
            value => { value.stopKind = "ctrl-c"; },
            value => { value.candidateExited = true; },
            value => { value.exitCode = 0; },
            value => { value.forced = true; },
            value => { value.jobActiveProcesses = 1; },
            value => { value.processTreeExitProven = false; },
            value => { value.handlesClosed = false; },
            value => { value.listenerGone = false; },
            value => { value.sessionId = "e".repeat(32); },
            value => { value.artifactLogicalName = "MySpeed-windows-x64-baseline.exe"; },
            value => { value.status = "failed"; }
        ];
        for (const mutate of neverStartedMutations) {
            const neverStarted = makeHarness();
            neverStarted.operations.openOwnedSession = async ({alias, scenario}) => {
                neverStarted.events.push(`session:${alias}:${scenario}:open`);
                return {malformed: true};
            };
            const invalidClose = neverStarted.operations.closeOwnedSession;
            neverStarted.operations.closeOwnedSession = async input => {
                const value = await invalidClose(input);
                mutate(value);
                return value;
            };
            const neverStartedResult = await runWindowsNativeStandaloneAdapter(request(), neverStarted.operations);
            assert.deepEqual(neverStartedResult.failures.map(({stage}) => stage),
                ["open-owned-session", "close-owned-session"]);
            assert.equal(neverStarted.events.at(-1), "fixture:default:cleanup");
        }

        const partial = makeHarness({failAt: "session:default:populated-first-boot:launch"});
        const partialClose = partial.operations.closeOwnedSession;
        partial.operations.closeOwnedSession = async input => ({...await partialClose(input),
            candidateStarted: true, candidateExited: true, exitCode: 197, forced: true});
        const partialResult = await runWindowsNativeStandaloneAdapter(request(), partial.operations);
        assert.deepEqual(partialResult.failures, [{stage: "launch-owned-session", classification: "failed"}]);
        assert.equal(partial.events.at(-1), "fixture:default:cleanup");
    });

    it("uses prevalidated ownership to clean malformed prepare and open results", async () => {
        const malformedFixture = makeHarness();
        malformedFixture.operations.prepareFixture = async ({alias}) => {
            malformedFixture.events.push(`fixture:${alias}:prepare`);
            return {malformed: true};
        };
        const fixtureResult = await runWindowsNativeStandaloneAdapter(request(), malformedFixture.operations);
        assert.equal(fixtureResult.status, "failed");
        assert.deepEqual(malformedFixture.events.slice(-2), ["fixture:default:prepare", "fixture:default:cleanup"]);

        const malformedSession = makeHarness();
        malformedSession.operations.openOwnedSession = async ({alias, scenario}) => {
            malformedSession.events.push(`session:${alias}:${scenario}:open`);
            return {malformed: true};
        };
        const sessionResult = await runWindowsNativeStandaloneAdapter(request(), malformedSession.operations);
        assert.equal(sessionResult.status, "failed");
        assert.ok(malformedSession.events.includes("session:default:populated-first-boot:close"));
        assert.ok(malformedSession.events.includes("offline:default:after-stop:populated-first-boot"));
        assert.equal(malformedSession.events.at(-1), "fixture:default:cleanup");
    });

    it("fails when the mandatory post-stop offline proof is absent or negative", async () => {
        const negative = makeHarness({badPostStop: true});
        const result = await runWindowsNativeStandaloneAdapter(request(), negative.operations);
        assert.equal(result.status, "failed");
        assert.deepEqual(result.failures[0], {stage: "offline-after-stop", classification: "failed"});
        assert.equal(negative.events.at(-1), "fixture:default:cleanup");

        const missing = makeHarness();
        const observeOffline = missing.operations.observeOffline;
        missing.operations.observeOffline = async request => request.phase === "after-stop"
            ? null
            : observeOffline(request);
        const absent = await runWindowsNativeStandaloneAdapter(request(), missing.operations);
        assert.equal(absent.status, "failed");
        assert.deepEqual(absent.failures[0], {stage: "offline-after-stop", classification: "failed"});
        assert.equal(missing.events.at(-1), "fixture:default:cleanup");
    });

    it("rejects stale identities, alias drift, extra keys, and malformed operations", async () => {
        for (const mutate of [
            value => { value.qualifying = true; },
            value => { value.aliases.reverse(); },
            value => { value.aliases[0].candidateSha256 = `${"1".repeat(63)}\n`; },
            value => { value.aliases[0].artifactLogicalName = "windows-default"; },
            value => { value.extra = true; }
        ]) {
            const changed = structuredClone(request());
            mutate(changed);
            assert.throws(() => assertWindowsNativeAdapterRequest(changed));
        }
        const harness = makeHarness();
        delete harness.operations.closeOwnedSession;
        await assert.rejects(() => runWindowsNativeStandaloneAdapter(request(), harness.operations), /operation/i);

        const duplicateBytes = request();
        duplicateBytes.aliases[1].candidateSha256 = duplicateBytes.aliases[0].candidateSha256;
        assert.doesNotThrow(() => assertWindowsNativeAdapterRequest(duplicateBytes));
    });
});
