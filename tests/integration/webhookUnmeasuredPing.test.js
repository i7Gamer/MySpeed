import {after, before, describe, it} from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import childProcess from "node:child_process";
import {syncBuiltinESMExports} from "node:module";
import {EventEmitter} from "node:events";
import {PassThrough} from "node:stream";
import {bootServer, api, seedTarget, waitFor} from "./helpers/boot.js";

let server;
let task;
let binary;
const INTERFACE = "test-interface";
const MEASURED_PING = 0.25;

before(async () => {
    server = await bootServer();
    task = await import("../../server/tasks/speedtest.js");
    const loader = await import("../../server/util/loadInterfaces.js");
    loader.interfaces[INTERFACE] = "192.0.2.10";
    await server.config.updateValue("interface", INTERFACE);
    const registry = await import("../../server/util/providers/registry.js");
    binary = registry.binaryPath("cloudflare");
    fs.mkdirSync(path.dirname(binary), {recursive: true});
    fs.writeFileSync(binary, "test transport replaces spawning this file");
    await seedTarget({provider: "cloudflare"});
    const created = await api(server.baseUrl, "/integrations/webhook", {
        method: "PUT", body: JSON.stringify({url: "https://hooks.example.invalid/test",
            integration_name: "ping", send_finished: true}),
        headers: {"content-type": "application/json"}
    });
    assert.equal(created.status, 200);
});
after(async () => { await new Promise(setImmediate); await server?.close(); });

describe("the task's outbound ping", () => {
    for (const ping of [null, MEASURED_PING]) {
        it(`stores the provider reading and sends ${ping === null ? "null for missing latency" : "measured latency unchanged"}`, async (t) => {
            let spawned = 0;
            const sent = [];
            const realFetch = globalThis.fetch;
            t.mock.method(globalThis, "fetch", async (url, init) => {
                if (String(url).startsWith(server.baseUrl)) return realFetch(url, init);
                sent.push(JSON.parse(init.body));
                return new Response("{}", {status: 200});
            });
            const spawn = t.mock.method(childProcess, "spawn", (file) => {
                assert.equal(file, binary);
                spawned++;
                const child = new EventEmitter();
                child.stdout = new PassThrough();
                child.stderr = new PassThrough();
                child.exitCode = null;
                child.signalCode = null;
                child.kill = () => {};
                queueMicrotask(() => {
                    child.stdout.emit("data", Buffer.from(JSON.stringify({
                        latency_measurement: ping === null ? {} : {avg_latency_ms: ping},
                        speed_measurements: [
                            {test_type: "Download", max: 100}, {test_type: "Upload", max: 50}
                        ]
                    })));
                    child.exitCode = 0;
                    child.emit("close", 0, null);
                });
                return child;
            });
            syncBuiltinESMExports();
            try {
                await task.create("manual");
                const finished = await waitFor(() => sent.find((entry) => entry.event === "TEST_FINISHED"));
                assert.equal(spawned, 1, "the test never reached the CLI execution branch");
                const stored = await server.tests.findByPk(finished.data.id);
                assert.equal(stored.ping, ping ?? 0);
                assert.equal(finished.data.ping, ping);
                assert.equal(stored.download, finished.data.download);
            } finally {
                spawn.mock.restore();
                syncBuiltinESMExports();
            }
        });
    }
});
