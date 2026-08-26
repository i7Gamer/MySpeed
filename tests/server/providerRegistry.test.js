import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { REGISTRY, descriptor, providerIds, LIBRE_DURATION_SECONDS } from "../../server/util/providers/registry.js";

/**
 * One descriptor per provider, replacing the if/else chains that named the
 * providers in twelve places. The registry is the contract: a provider that
 * exists here can be spawned, parsed and downloaded, and a mode that does not
 * exist here throws by name instead of silently borrowing cfspeedtest's
 * binary path, which is what the old ternary's else branch did.
 */
describe("the provider registry", () => {
    it("carries every part a provider needs", () => {
        for (const [id, entry] of Object.entries(REGISTRY)) {
            assert.equal(typeof entry.binaryName, "string", `${id} names no binary`);
            assert.equal(typeof entry.loader?.load, "function", `${id} has no loader`);
            assert.equal(typeof entry.buildArgs, "function", `${id} builds no args`);
            assert.equal(typeof entry.isResult, "function", `${id} cannot recognise a result`);
            assert.equal(typeof entry.listName, "string", `${id} has no download-failure name`);
        }
    });

    it("throws by name for a provider it does not know", () => {
        assert.throws(() => descriptor("bogus"), /bogus/);
    });

    it("lists the shipped providers", () => {
        assert.deepEqual(providerIds(), ["ookla", "libre", "cloudflare"]);
    });

    it("names the server list only for providers that have one", () => {
        assert.equal(REGISTRY.ookla.serverList, "ookla");
        assert.equal(REGISTRY.libre.serverList, "libre");
        assert.equal(REGISTRY.cloudflare.serverList, null);
    });

    it("streams progress only where the CLI reports it", () => {
        assert.equal(REGISTRY.ookla.streamsProgress, true);
        assert.equal(REGISTRY.libre.streamsProgress, false);
        assert.equal(REGISTRY.cloudflare.streamsProgress, false);
    });
});

const IFACE = {name: "eth0", address: "192.168.1.2"};

describe("ookla arguments", () => {
    const build = (target, platform) => REGISTRY.ookla.buildArgs(target, IFACE, {platform});

    it("binds by address on windows and by name elsewhere", () => {
        assert.ok(build({}, "win32").args.includes("--ip=192.168.1.2"));
        assert.ok(build({}, "linux").args.includes("--interface=eth0"));
    });

    it("pins the server only when one is chosen", () => {
        assert.ok(build({serverId: "1234"}, "linux").args.includes("--server-id=1234"));
        assert.ok(!build({}, "linux").args.some((arg) => arg.startsWith("--server-id")));
    });

    it("asks for the streaming record format", () => {
        assert.ok(build({}, "linux").args.includes("--format=jsonl"));
    });
});

describe("libre arguments", () => {
    const build = (target) => REGISTRY.libre.buildArgs(target, IFACE, {platform: "linux"});

    it("runs at the named duration from the bound address", () => {
        const {args} = build({});

        assert.ok(args.includes(`--duration=${LIBRE_DURATION_SECONDS}`));
        assert.ok(args.includes("--source=192.168.1.2"));
    });

    it("hands a custom backend over as a server file to write", () => {
        const {args, temporaryServer} = build({endpoint: "https://speed.example.net"});

        assert.ok(temporaryServer.path.includes("libre_custom"));
        assert.match(temporaryServer.content, /"server":\s*"https:\/\/speed\.example\.net"/);
        assert.ok(args.includes(`--local-json=${temporaryServer.path}`));
        assert.ok(args.includes("--server=1"));
    });

    it("pins a listed server when no custom backend is set", () => {
        const {args, temporaryServer} = build({serverId: "7"});

        assert.equal(temporaryServer, null);
        assert.ok(args.includes("--server=7"));
    });

    it("lets the custom backend win over a stale server id", () => {
        const {args} = build({serverId: "7", endpoint: "https://speed.example.net"});

        assert.ok(args.includes("--server=1"));
        assert.ok(!args.includes("--server=7"));
    });
});

describe("cloudflare arguments", () => {
    it("binds the family the address belongs to", () => {
        const v4 = REGISTRY.cloudflare.buildArgs({}, IFACE, {platform: "linux"});
        const v6 = REGISTRY.cloudflare.buildArgs({}, {name: "eth0", address: "fd00::2"}, {platform: "linux"});

        assert.ok(v4.args.includes("--ipv4=192.168.1.2"));
        assert.ok(v6.args.includes("--ipv6=fd00::2"));
    });
});

describe("result recognition", () => {
    it("keeps each CLI's own rule", () => {
        assert.equal(REGISTRY.ookla.isResult({type: "result"}), true);
        assert.equal(REGISTRY.ookla.isResult({type: "download"}), false);
        assert.equal(REGISTRY.cloudflare.isResult({metadata: {}}), true);
        assert.equal(REGISTRY.cloudflare.isResult([1, 2]), false);
        assert.equal(REGISTRY.libre.isResult({anything: true}), true);
    });
});
