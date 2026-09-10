import assert from "node:assert/strict";
import {spawn} from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const HOST = "outbound-fixture.invalid";
const LOCAL = "127.0.0.1";
const CHILD_TIMEOUT_MS = 9000;
const SHORT_REQUEST_MS = 150;
const IDLE_LEASE_LIMIT = 16;
const SOCKETS_PER_TUNNEL = 3;
const REUSE_REQUESTS = 3;
const IPV4 = {address: LOCAL, family: 4};
const FIRST_IPV4 = {address: "127.0.0.2", family: 4};
const BLOCKED = {address: "169.254.169.254", family: 4};
const BODY = "Grüezi 🌍 synthetic notification";
const PROXY_ENV = /^(?:https?_proxy|all_proxy|no_proxy)$/i;
const compiled = Boolean(process.versions.bun) && !/^bun(?:-debug)?(?:\.exe)?$/i.test(path.basename(process.execPath));
const directory = () => process.env.OUTBOUND_HTTP_FIXTURE_DIR || path.resolve("tests/fixtures/outbound-transport/http");

function cleanEnvironment() {
    return Object.fromEntries(Object.entries(process.env).filter(([key]) => !PROXY_ENV.test(key)));
}

async function startPeer(options) {
    const peer = spawn("node", [path.join(directory(), "peer.mjs")], {
        windowsHide: true, stdio: ["ignore", "ignore", "pipe", "ipc"],
        env: {...cleanEnvironment(), OUTBOUND_HTTP_PEER_OPTIONS: JSON.stringify(options)}
    });
    let stderr = "";
    peer.stderr.on("data", chunk => {stderr += chunk;});
    let sequence = 0;
    const pending = new Map();
    const wait = key => new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            pending.delete(key);
            peer.kill();
            reject(new Error(`HTTP peer deadline: ${stderr}`));
        }, CHILD_TIMEOUT_MS);
        pending.set(key, {resolve, reject, timer});
    });
    const ready = wait("ready");
    const fail = error => {
        for (const task of pending.values()) {clearTimeout(task.timer); task.reject(error);}
        pending.clear();
    };
    peer.on("error", fail);
    peer.on("exit", code => fail(new Error(`HTTP peer exited ${code}: ${stderr}`)));
    peer.on("message", message => {
        const key = message.ready ? "ready" : message.id;
        const task = pending.get(key);
        if (!task) return;
        pending.delete(key);
        clearTimeout(task.timer);
        task.resolve(message.ready ? message : message.result);
    });
    const rpc = command => {
        const id = ++sequence;
        const result = wait(id);
        peer.send({id, command});
        return result;
    };
    try {
        return {...await ready, snapshot: () => rpc("snapshot"), close: async () => {
            try {await rpc("close");} finally {peer.disconnect(); peer.kill();}
        }};
    } catch (error) {peer.kill(); throw error;}
}

async function withScenario(options, check) {
    const peer = await startPeer(options);
    let child;
    try {
        const certificateDir = process.env.OUTBOUND_TLS_FIXTURE_DIR || path.resolve("tests/fixtures/outbound-tls");
        const certificate = path.join(certificateDir, options.ipCertificate ? "ip-cert.pem" : "cert.pem");
        assert.ok(fs.existsSync(certificate), "HTTP fixture certificate is required");
        const proxyHost = options.proxyHostname || (options.secureProxy ? HOST : LOCAL);
        const proxy = `${options.secureProxy ? "https" : "http"}://${options.proxyAuth ? options.proxyAuth + "@" : ""}${proxyHost}:${peer.proxyPort}`;
        const env = {...cleanEnvironment(), OUTBOUND_HTTP_CASE: JSON.stringify({...options, originPort: peer.originPort}),
            NODE_EXTRA_CA_CERTS: certificate, HTTPS_PROXY: proxy};
        if (options.noProxy) env.NO_PROXY = options.noProxy;
        if (options.withoutProxy) delete env.HTTPS_PROXY;
        if (options.untrusted) delete env.NODE_EXTRA_CA_CERTS;
        child = spawn(process.execPath, compiled ? [] : [path.join(directory(), "client.mjs")], {
            windowsHide: true, stdio: ["ignore", "pipe", "pipe"], env
        });
        let stderr = "";
        child.stderr.on("data", chunk => {stderr += chunk;});
        const result = await new Promise((resolve, reject) => {
            let output = "";
            const timer = setTimeout(() => reject(new Error(`HTTP client deadline: ${output} ${stderr}`)), CHILD_TIMEOUT_MS);
            const fail = error => {clearTimeout(timer); reject(error);};
            child.on("error", fail);
            child.on("exit", code => fail(new Error(`HTTP client exited ${code}: ${output} ${stderr}`)));
            child.stdout.on("data", chunk => {
                output += chunk;
                const line = output.split("\n").find(item => item.startsWith("{"));
                if (!line) return;
                try {const parsed = JSON.parse(line); clearTimeout(timer); resolve(parsed);} catch { /* wait for complete JSON */ }
            });
        });
        const seen = await peer.snapshot();
        assert.equal(stderr, "", "HTTP child emitted an unhandled error or warning");
        assert.deepEqual(seen.unsafe, [], "fixture intercepted an unsafe proxy destination");
        await check(result, seen, peer);
    } finally {
        child?.kill();
        await peer.close();
    }
}

export const httpScenarios = [];
const scenario = (name, options, check) => httpScenarios.push({name: `http ${name}`, run: async () => {
    try {await withScenario(options, check);}
    catch (error) {throw new Error(`http ${name}: ${error.message}`, {cause: error});}
}});

scenario("custom-port proxy preserves strict SNI and original Host", {strictSni: true}, ({results}, seen, peer) => {
    assert.equal(results[0].status, 200);
    assert.deepEqual(seen.connects.map(item => item.path), [`${LOCAL}:${peer.originPort}`]);
    assert.equal(seen.posts[0].headers.host, `${HOST}:${peer.originPort}`);
    assert.equal(seen.posts[0].servername, HOST);
});

scenario("hostname NO_PROXY bypass is selected before numeric rewriting", {noProxy: HOST}, ({results}, seen) => {
    assert.equal(results[0].status, 200);
    assert.equal(seen.connects.length, 0);
    assert.equal(seen.posts.length, 1);
});

scenario("HTTPS proxy and origin both use trusted names", {secureProxy: true}, ({results}, seen, peer) => {
    assert.equal(results[0].status, 200);
    assert.equal(seen.connects[0].path, `${LOCAL}:${peer.originPort}`);
    assert.equal(seen.posts[0].servername, HOST);
});

scenario("default HTTPS port keeps bare Host and SNI", {defaultPort: true}, ({results}, seen) => {
    assert.equal(results[0].status, 200);
    assert.equal(seen.connects[0].path, `${LOCAL}:443`);
    assert.equal(seen.posts[0].headers.host, HOST);
    assert.equal(seen.posts[0].servername, HOST);
});

scenario("unconfigured proxy keeps native direct delivery", {withoutProxy: true}, ({results}, seen) => {
    assert.equal(results[0].status, 200);
    assert.equal(seen.connects.length, 0);
    assert.equal(seen.posts[0].body, BODY);
});

for (const [label, proxyAuth, credentials] of [
    ["escaped credentials", "synthetic%20user:synthetic%3Apass", "synthetic user:synthetic:pass"],
    ["username only", "synthetic", "synthetic:"]
]) scenario(`proxy Basic authentication handles ${label} without leaking to origin`, {proxyAuth}, ({results}, seen) => {
    assert.equal(results[0].status, 200);
    assert.equal(seen.connects[0].headers["proxy-authorization"], `Basic ${Buffer.from(credentials).toString("base64")}`);
    assert.equal(seen.posts[0].headers["proxy-authorization"], undefined);
    assert.equal(seen.posts[0].body, BODY);
});

scenario("mixed DNS answers pin only approved destination", {answers: [BLOCKED, IPV4]}, ({results}, seen, peer) => {
    assert.equal(results[0].status, 200);
    assert.deepEqual(seen.connects.map(item => item.path), [`${LOCAL}:${peer.originPort}`]);
});

scenario("all blocked answers stop before proxy contact", {answers: [BLOCKED]}, ({results}, seen) => {
    assert.equal(results[0].error, "EBLOCKEDADDRESS");
    assert.equal(seen.connects.length, 0);
    assert.equal(seen.posts.length, 0);
    assert.equal(seen.openSockets, 0);
});

scenario("proxy-only DNS remains a locally filtered failure", {dnsError: true}, ({results}, seen) => {
    assert.equal(results[0].error, "ENOTFOUND");
    assert.equal(seen.connects.length, 0);
    assert.equal(seen.openSockets, 0);
});

for (const [name, options] of [
    ["target DNS", {holdDns: true}],
    ["proxy DNS", {holdProxyDns: true, proxyHostname: "proxy-fixture.invalid"}],
    ["proxy TLS", {secureProxy: true, stallProxyTls: true}],
    ["CONNECT", {stallConnect: true}],
    ["TLS", {stallTls: true}],
    ["headers", {pathname: "/stall-headers"}]
]) scenario(`deadline during ${name} closes owned sockets`, {...options, timeout: SHORT_REQUEST_MS}, ({results}, seen) => {
    assert.ok(results[0].error, "deadline must settle before response headers");
    assert.equal(seen.openSockets, 0, "child is still alive when socket closure is checked");
});

for (const status of [201, 407, 502]) scenario(`CONNECT ${status} never counts as delivery or retries candidates`,
    {connectStatus: status, answers: [FIRST_IPV4, IPV4]}, ({results}, seen) => {
        assert.equal(results[0].status, status);
        assert.equal(results[0].ok, false);
        assert.equal(seen.connects.length, 1);
        assert.equal(seen.posts.length, 0);
        assert.equal(seen.openSockets, 0);
    });

scenario("malformed CONNECT is a contained failure", {malformedConnect: true}, ({results}, seen) => {
    assert.ok(results[0].error);
    assert.equal(seen.posts.length, 0);
    assert.equal(seen.openSockets, 0);
});

const certificateFailure = ({results}, seen) => {
    assert.match(`${results[0].error} ${results[0].message}`, /cert|self.signed|hostname|PRX_TLS/i);
    assert.equal(seen.posts.length, 0);
    assert.equal(seen.openSockets, 0);
};
scenario("origin certificate name is verified", {hostname: "wrong-fixture.invalid"}, certificateFailure);
scenario("origin untrusted certificate is refused", {untrusted: true}, certificateFailure);
scenario("HTTPS proxy certificate name is verified", {secureProxy: true, proxyHostname: "wrong-fixture.invalid"}, certificateFailure);
scenario("HTTPS proxy untrusted certificate is refused", {secureProxy: true, untrusted: true}, certificateFailure);

for (const [label, options] of [["origin", {status: 302}], ["CONNECT", {connectStatus: 302}]])
    scenario(`${label} redirect never contacts its Location`, {...options, redirect: true}, ({results, runtime}, seen) => {
        if (runtime === "bun") assert.ok(results[0].error, "integration wiring refuses redirects");
        else assert.equal(results[0].status, 302, "portable leaf returns status for caller redirect refusal");
        assert.equal(seen.connects.length, 1);
        assert.equal(seen.posts.length, label === "origin" ? 1 : 0);
    });

scenario("pre-TLS failure tries next filtered candidate", {firstTlsFailure: true, answers: [FIRST_IPV4, IPV4]}, ({results}, seen) => {
    assert.equal(results[0].status, 200);
    assert.equal(seen.connects.length, 2);
    assert.equal(seen.posts.length, 1);
});

scenario("delivered POST is never replayed after socket loss", {pathname: "/close", answers: [FIRST_IPV4, IPV4]}, ({results}, seen) => {
    assert.ok(results[0].error);
    assert.equal(seen.connects.length, 1);
    assert.equal(seen.posts.length, 1);
});

scenario("warm reused socket never replays a delivered POST", {warmClose: true, answers: [FIRST_IPV4, IPV4]}, ({results}, seen) => {
    assert.equal(results[0].status, 200);
    assert.ok(results[1].error);
    assert.equal(seen.connects.length, 1);
    assert.equal(seen.posts.length, 2);
});

scenario("complete drains preserve reuse and payload bytes", {reuse: true}, ({results, runtime}, seen, peer) => {
    assert.deepEqual(results.map(item => item.status), Array(REUSE_REQUESTS).fill(200));
    assert.equal(seen.connects.length, 1);
    assert.equal(seen.posts.length, REUSE_REQUESTS);
    for (const post of seen.posts) {
        assert.equal(post.body, BODY);
        assert.equal(post.headers.host, `${HOST}:${peer.originPort}`);
        assert.equal(post.headers["content-length"], String(Buffer.byteLength(BODY)));
        if (runtime === "bun") assert.match(post.headers["user-agent"], /^Bun\//);
    }
});

scenario("concurrent abort does not destroy another active lease", {concurrent: true}, ({results}, seen) => {
    assert.equal(results.filter(item => item.status === 200).length, 2);
    assert.equal(results.filter(item => item.drainError).length, 1);
    assert.equal(seen.connects.length, 2);
    assert.equal(seen.posts.length, 2);
    assert.equal(seen.openSockets, SOCKETS_PER_TUNNEL, "only successful reusable connection remains");
});

for (const [label, options] of [
    ["trickling body deadline", {pathname: "/trickle", timeout: SHORT_REQUEST_MS}],
    ["body socket loss", {pathname: "/body-close"}],
    ["body cancellation", {pathname: "/trickle", cancelBody: true}]
]) scenario(`${label} retains settled status and destroys lease`, options, ({results}, seen) => {
    assert.equal(results[0].status, 200);
    if (!options.cancelBody) assert.ok(results[0].drainError);
    assert.equal(seen.posts.length, 1);
    assert.equal(seen.openSockets, 0);
});

scenario("idle cache evicts overflow without retaining sockets", {eviction: true}, ({results}, seen) => {
    assert.equal(results.length, IDLE_LEASE_LIMIT + 1);
    assert.ok(results.every(item => item.status === 200));
    assert.equal(seen.connects.length, IDLE_LEASE_LIMIT + 1);
    assert.equal(seen.openSockets, IDLE_LEASE_LIMIT * SOCKETS_PER_TUNNEL);
});

scenario("idle cache expiry closes drained sockets", {expiry: true}, ({results}, seen) => {
    assert.equal(results[0].status, 200);
    assert.equal(seen.openSockets, 0);
});

for (const [label, options] of [["IPv4", {hostname: LOCAL}], ["IPv6", {hostname: "[::1]", ipv6: true}]])
    scenario(`literal ${label} target omits SNI and verifies IP identity`, {...options, noProxy: "*"}, (result, seen) => {
        certificateFailure(result, seen);
        assert.equal(seen.connects.length, 0);
        assert.deepEqual(seen.sni, [], "literal target must not send a DNS SNI name");
    });

for (const [label, options] of [["IPv4", {hostname: LOCAL}], ["IPv6", {hostname: "[::1]", ipv6: true}]])
    for (const bypass of [false, true]) scenario(`literal ${label} ${bypass ? "bypass" : "proxy"} follows native IP-SAN verification without SNI`,
        {...options, ipCertificate: true, ...(bypass ? {noProxy: "*"} : {})}, ({results, nativeIpIdentityError, runtime}, seen) => {
            if (nativeIpIdentityError) {
                assert.equal(runtime, "node", "Bun must deliver a correctly certified literal target");
                assert.equal(options.ipv6, true, "only the measured Node IPv6 checker limitation is accepted");
                assert.equal(results[0].error, nativeIpIdentityError);
                assert.equal(seen.posts.length, 0);
            } else {
                assert.equal(results[0].status, 200, JSON.stringify(results));
                assert.equal(seen.posts.length, 1);
                assert.equal(seen.posts[0].servername, false);
            }
            assert.equal(seen.connects.length, bypass ? 0 : 1);
            assert.deepEqual(seen.sni, []);
        });
