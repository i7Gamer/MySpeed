import {describe, it} from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {
    assertFullIsolationPlatform,
    runMacosRuntimeIsolation
} from "../../scripts/qualification/check-artifact.mjs";
import {validateProbeResult} from "../../scripts/qualification/macos-isolation.mjs";

const SOURCE_ROOT = path.resolve("synthetic-macos-source");
const SOURCE_SENTINEL = path.join(SOURCE_ROOT, "package.json");
const WORK_ROOT = path.resolve("synthetic-macos-work");
const CHECKER_FILE = fileURLToPath(new URL("../../scripts/qualification/check-artifact.mjs", import.meta.url));
const VALID_DENIAL = {denied: true, code: "EPERM", timedOut: false};
const VALID_PROBE = {
    schemaVersion: 1,
    loopback: {roundTrip: true, host: "127.0.0.1"},
    temporaryFile: {roundTrip: true},
    sourceRoot: VALID_DENIAL,
    sourceSentinel: VALID_DENIAL,
    forbidden: {tcp4: VALID_DENIAL, tcp6: VALID_DENIAL, udp4: VALID_DENIAL, udp6: VALID_DENIAL},
    helper: {
        inherited: true,
        forbidden: {tcp4: VALID_DENIAL, tcp6: VALID_DENIAL, udp4: VALID_DENIAL, udp6: VALID_DENIAL}
    }
};

const handoff = (root = WORK_ROOT) => ({populated: {root}});

describe("full artifact runtime isolation dispatch", () => {
    it("preserves the existing Linux namespace assertion and never loads the macOS probe", () => {
        const calls = [];
        const result = assertFullIsolationPlatform({
            platform: "linux",
            preseededFixtureManifest: null
        }, {
            assertLinuxIsolation: () => calls.push("linux")
        });

        assert.deepEqual(result, {kind: "linux-network-namespace"});
        assert.deepEqual(calls, ["linux"]);
    });

    it("allows Darwin only with a preseeded handoff and rejects every other platform", () => {
        assert.deepEqual(assertFullIsolationPlatform({
            platform: "darwin",
            preseededFixtureManifest: "/fixture/handoff.json"
        }), null);
        assert.throws(() => assertFullIsolationPlatform({
            platform: "darwin",
            preseededFixtureManifest: null
        }), /preseeded fixture/i);
        assert.throws(() => assertFullIsolationPlatform({
            platform: "win32",
            preseededFixtureManifest: "/fixture/handoff.json"
        }), /cannot prove full runtime isolation/i);
    });

    it("runs the Darwin isolation gate before the first full candidate spawn", () => {
        const source = fs.readFileSync(CHECKER_FILE, "utf8");
        const gate = source.indexOf("summary.networkIsolation = await runMacosRuntimeIsolation");
        const firstCandidate = source.indexOf("activeChild = startArtifact({command, args: options.args");
        assert.notEqual(gate, -1);
        assert.notEqual(firstCandidate, -1);
        assert.ok(gate < firstCandidate);
    });
});

describe("Darwin in-band runtime isolation", () => {
    it("proves source denial and the owned handoff work root before returning evidence", async () => {
        const calls = [];
        const result = await runMacosRuntimeIsolation({
            platform: "darwin",
            originalBuildRoot: SOURCE_ROOT,
            sourceSentinel: SOURCE_SENTINEL,
            work: WORK_ROOT,
            handoff: handoff()
        }, {
            assertSourceUnavailable: root => calls.push(["source", root]),
            loadIsolationProbe: async () => ({
                runIsolationProbe: async options => {
                    calls.push(["probe", options]);
                    return VALID_PROBE;
                },
                validateProbeResult
            })
        });

        assert.deepEqual(calls, [
            ["source", SOURCE_ROOT],
            ["probe", {sourceRoot: SOURCE_ROOT, sourceSentinel: SOURCE_SENTINEL, workRoot: WORK_ROOT}]
        ]);
        assert.deepEqual(result, {
            kind: "macos-seatbelt",
            sourceRoot: SOURCE_ROOT,
            sourceSentinel: SOURCE_SENTINEL,
            workRoot: WORK_ROOT,
            probe: VALID_PROBE
        });
    });

    it("is a no-op off Darwin and does not load the macOS module", async () => {
        let loaded = false;
        assert.equal(await runMacosRuntimeIsolation({platform: "linux"}, {
            loadIsolationProbe: async () => {
                loaded = true;
                throw new Error("must not load");
            }
        }), null);
        assert.equal(loaded, false);
    });

    it("rejects missing, aliased, escaping, or unowned isolation paths before loading the probe", async () => {
        const base = {
            platform: "darwin",
            originalBuildRoot: SOURCE_ROOT,
            sourceSentinel: SOURCE_SENTINEL,
            work: WORK_ROOT,
            handoff: handoff()
        };
        const cases = [
            [{...base, originalBuildRoot: undefined}, /original-build-root/i],
            [{...base, originalBuildRoot: `${SOURCE_ROOT}${path.sep}nested${path.sep}..`}, /original-build-root/i],
            [{...base, sourceSentinel: undefined}, /source-sentinel/i],
            [{...base,
                sourceSentinel: `${SOURCE_ROOT}${path.sep}nested${path.sep}..${path.sep}package.json`},
            /source-sentinel/i],
            [{...base, sourceSentinel: path.join(SOURCE_ROOT, "..", "outside.json")}, /descendant/i],
            [{...base, sourceSentinel: SOURCE_ROOT}, /descendant/i],
            [{...base, work: path.resolve("different-work")}, /owned.*work/i],
            [{...base, handoff: null}, /owned.*work/i],
            [{...base, work: path.join(SOURCE_ROOT, "work"), handoff: handoff(path.join(SOURCE_ROOT, "work"))},
                /separate directory trees/i]
        ];
        for (const [options, pattern] of cases) {
            let loaded = false;
            await assert.rejects(runMacosRuntimeIsolation(options, {
                assertSourceUnavailable: () => undefined,
                loadIsolationProbe: async () => {
                    loaded = true;
                    return {runIsolationProbe: async () => VALID_PROBE, validateProbeResult};
                }
            }), pattern);
            assert.equal(loaded, false);
        }
    });

    it("fails closed when source access remains or the probe module is malformed", async () => {
        await assert.rejects(runMacosRuntimeIsolation({
            platform: "darwin",
            originalBuildRoot: SOURCE_ROOT,
            sourceSentinel: SOURCE_SENTINEL,
            work: WORK_ROOT,
            handoff: handoff()
        }, {
            assertSourceUnavailable: () => {
                throw new Error("source still readable");
            },
            loadIsolationProbe: async () => ({runIsolationProbe: async () => VALID_PROBE, validateProbeResult})
        }), /source still readable/i);

        await assert.rejects(runMacosRuntimeIsolation({
            platform: "darwin",
            originalBuildRoot: SOURCE_ROOT,
            sourceSentinel: SOURCE_SENTINEL,
            work: WORK_ROOT,
            handoff: handoff()
        }, {
            assertSourceUnavailable: () => undefined,
            loadIsolationProbe: async () => ({})
        }), /probe module/i);
        await assert.rejects(runMacosRuntimeIsolation({
            platform: "darwin",
            originalBuildRoot: SOURCE_ROOT,
            sourceSentinel: SOURCE_SENTINEL,
            work: WORK_ROOT,
            handoff: handoff()
        }, {
            assertSourceUnavailable: () => undefined,
            loadIsolationProbe: async () => ({runIsolationProbe: async () => VALID_PROBE})
        }), /validateProbeResult/i);
    });

    it("independently rejects incomplete or regressed probe results", async () => {
        const base = {
            platform: "darwin",
            originalBuildRoot: SOURCE_ROOT,
            sourceSentinel: SOURCE_SENTINEL,
            work: WORK_ROOT,
            handoff: handoff()
        };
        for (const result of [
            {},
            {...structuredClone(VALID_PROBE), forbidden: {}},
            {...structuredClone(VALID_PROBE), helper: {...structuredClone(VALID_PROBE.helper), inherited: false}}
        ])
            await assert.rejects(runMacosRuntimeIsolation(base, {
                assertSourceUnavailable: () => undefined,
                loadIsolationProbe: async () => ({
                    runIsolationProbe: async () => result,
                    validateProbeResult
                })
            }), /probe|denial|helper/i);
    });
});
