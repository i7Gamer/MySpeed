import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { REGISTRY, descriptor, providerIds, LIBRE_DURATION_SECONDS, IPERF_DURATION_SECONDS,
    IPERF_MAX_DURATION_SECONDS, IPERF_MAX_STREAMS, IPERF_MIN_DURATION_SECONDS, IPERF_MIN_STREAMS,
    IPERF_STREAMS } from "../../server/util/providers/registry.js";

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
        assert.deepEqual(providerIds(), ["ookla", "libre", "cloudflare", "iperf3"]);
    });

    it("names the server list only for providers that have one", () => {
        assert.equal(REGISTRY.ookla.serverList, "ookla");
        assert.equal(REGISTRY.libre.serverList, "libre");
        assert.equal(REGISTRY.cloudflare.serverList, null);
        // An iperf3 server is a host the operator runs, named on the target
        // itself - there is no fleet to list.
        assert.equal(REGISTRY.iperf3.serverList, null);
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

/**
 * The bounds a target's own iperf3 tuning is held to.
 *
 * They live beside the defaults they bound because the same numbers are read
 * three times: here to judge a write, in the runner to build the argv, and in
 * the dialog, which mirrors them to grey the Save button rather than earning a
 * red toast. The values are pinned as literals because that mirror is a copy -
 * the parity the client suite asserts is against these exact numbers.
 */
describe("the iperf3 tuning bounds", () => {
    it("names the range a target may measure over", () => {
        assert.equal(IPERF_MIN_DURATION_SECONDS, 5);
        assert.equal(IPERF_MAX_DURATION_SECONDS, 60);
    });

    it("names the range of streams a transfer may be carried over", () => {
        assert.equal(IPERF_MIN_STREAMS, 1);
        assert.equal(IPERF_MAX_STREAMS, 32);
    });

    /**
     * The shipped default is what a target inherits by leaving the field unset,
     * and it is judged by nothing - so a later edit that moved a default outside
     * its own bounds would leave every untuned target running a value the dialog
     * refuses to let anyone type.
     */
    it("keeps each shipped default inside its own bounds", () => {
        assert.ok(IPERF_MIN_DURATION_SECONDS <= IPERF_DURATION_SECONDS
            && IPERF_DURATION_SECONDS <= IPERF_MAX_DURATION_SECONDS,
        `the default ${IPERF_DURATION_SECONDS}s duration is outside its own bounds`);

        assert.ok(IPERF_MIN_STREAMS <= IPERF_STREAMS && IPERF_STREAMS <= IPERF_MAX_STREAMS,
            `the default ${IPERF_STREAMS} streams is outside its own bounds`);
    });

    // Whole seconds and whole streams, which is all iperf3 takes - and what the
    // validation refuses anything else on behalf of.
    it("bounds them with whole numbers", () => {
        for (const bound of [IPERF_MIN_DURATION_SECONDS, IPERF_MAX_DURATION_SECONDS,
            IPERF_MIN_STREAMS, IPERF_MAX_STREAMS])
            assert.ok(Number.isInteger(bound), `${bound} is not a whole number`);
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
