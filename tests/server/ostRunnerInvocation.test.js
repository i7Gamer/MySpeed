import {after, before, describe, it} from "node:test";
import assert from "node:assert/strict";
import {EventEmitter} from "node:events";
import {bootServer} from "../integration/helpers/boot.js";
import {readSource} from "../helpers/source.js";

const RESULT = {type: "result", ping: {mean: 4}, download: {bandwidth: 1}, upload: {bandwidth: 1}};
const SYNTHETIC_PID = 42;
let server;
let speedTest;

before(async () => {
    server = await bootServer();
    ({default: speedTest} = await import("../../server/util/speedtest.js"));
});

after(async () => {
    await server?.close();
});

describe("the OpenSpeedTest runner invocation", () => {
    it("carries the stored HTTPS exception to the child argv", async () => {
        const spawned = [];
        const events = [];
        let releaseEnsure;
        let markEnsureStarted;
        const ensured = new Promise((resolve) => { releaseEnsure = resolve; });
        const ensureStarted = new Promise((resolve) => { markEnsureStarted = resolve; });
        const spawnProcess = (command, args, options) => {
            events.push("spawn");
            const child = new EventEmitter();
            child.pid = SYNTHETIC_PID;
            child.exitCode = null;
            child.signalCode = null;
            child.stdout = new EventEmitter();
            child.stderr = new EventEmitter();
            child.kill = () => true;
            spawned.push({command, args, options});
            process.nextTick(() => {
                child.stdout.emit("data", Buffer.from(JSON.stringify(RESULT)));
                child.exitCode = 0;
                child.emit("close", 0, null);
            });
            return child;
        };

        const running = speedTest("openspeedtest", null, "https://speed.lan:3001", null,
            {ostSkipCertificateVerification: 1}, {
                spawnProcess,
                ensureProviderBinary: async (mode, binaryPath) => {
                    events.push(["ensure", mode, binaryPath]);
                    markEnsureStarted();
                    await ensured;
                }
            });
        await ensureStarted;
        assert.deepEqual(spawned, [], "the CLI spawned before its binary preparation completed");
        releaseEnsure();
        const result = await running;

        assert.equal(result.type, "result");
        assert.equal(spawned.length, 1);
        assert.deepEqual(spawned[0].args, ["--server", "https://speed.lan:3001", "--duration", "15",
            "--json", "--insecure"]);
        assert.deepEqual(spawned[0].options, {windowsHide: true, stdio: ["ignore", "pipe", "pipe"]});
        assert.equal(events[0][0], "ensure");
        assert.equal(events[0][1], "openspeedtest");
        assert.equal(events[0][2], spawned[0].command, "the prepared and spawned binary paths differ");
        assert.equal(events[1], "spawn");
    });

    it("uses the production binary preparer and child-process spawn by default", () => {
        const source = readSource("server/util/speedtest.js");

        assert.match(source, /runtime\?\.ensureProviderBinary \?\? ensureBinary/u);
        assert.match(source, /runtime\?\.spawnProcess \?\? spawn/u);
    });
});
