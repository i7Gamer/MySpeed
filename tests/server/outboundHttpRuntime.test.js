import {it} from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import https from "node:https";
import fs from "node:fs";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {spawn} from "node:child_process";

const LOOPBACK = "127.0.0.1";
const HOSTNAME = "outbound-fixture.invalid";
const TRICKLE_MS = 10;
const PROBE_TIMEOUT_MS = 15000;
const EPHEMERAL_PORT = 0;
const BODY = "Grüezi 🌍";
const PROXY_ENVIRONMENT_KEYS = new Set(["http_proxy", "https_proxy", "no_proxy", "all_proxy"]);
const bunCandidates = [process.env.BUN_EXECUTABLE, "bun", path.join(process.env.USERPROFILE ?? "", ".bun", "bin", "bun.exe"),
    path.join(process.env.APPDATA ?? "", "npm", "node_modules", "bun", "bin", "bun.exe")];
const listen = (server) => new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(EPHEMERAL_PORT, LOOPBACK, resolve);
});
const executable = async (candidate) => {
    if (!candidate) return false;
    return new Promise((resolve) => {
        let child;
        try {child = spawn(candidate, ["--version"], {windowsHide: true, stdio: "ignore"});}
        catch {resolve(false); return;}
        child.once("error", () => resolve(false));
        child.once("close", (code) => resolve(code === 0));
    });
};

for (const runtime of ["node", "bun"]) {
    it(`${runtime} preserves guarded POST delivery, TLS identity and drain deadlines`, async (t) => {
        let command = process.execPath;
        if (runtime === "bun") {
            command = undefined;
            for (const candidate of bunCandidates) {
                if (await executable(candidate)) {command = candidate; break;}
            }
            if (!command) return t.skip("Bun executable unavailable; run this transport contract on the binary runtime separately");
        }
        const received = [];
        const sockets = new Set();
        let trickleClosed = false;
        const server = http.createServer((req, res) => {
            let body = "";
            req.on("data", (chunk) => {body += chunk;});
            req.on("end", () => {
                received.push({path: req.url, headers: req.headers, body, socket: req.socket});
                sockets.add(req.socket);
                if (req.url === "/redirect") {
                    res.writeHead(307, {location: `http://${LOOPBACK}:${server.address().port}/unexpected`});
                    return res.end();
                }
                if (req.url === "/error") {res.writeHead(429); return res.end("refused");}
                res.writeHead(202);
                res.write("accepted");
                if (req.url === "/trickle") {
                    const timer = setInterval(() => res.write("."), TRICKLE_MS);
                    res.on("close", () => {clearInterval(timer); trickleClosed = true;});
                } else setImmediate(() => res.end(" done"));
            });
        });
        let tlsObserved;
        const tlsServer = https.createServer({
            key: fs.readFileSync(new URL("../fixtures/outbound-tls/key.pem", import.meta.url)),
            cert: fs.readFileSync(new URL("../fixtures/outbound-tls/cert.pem", import.meta.url))
        }, (req, res) => {
            tlsObserved = {host: req.headers.host, sni: req.socket.servername};
            req.resume();
            res.end("ok");
        });
        t.after(async () => {
            for (const listener of [server, tlsServer]) {
                listener.closeAllConnections();
                await new Promise((resolve) => listener.close(resolve));
            }
        });
        await listen(server);
        await listen(tlsServer);
        const probe = fileURLToPath(new URL("../helpers/outboundHttpRuntime.mjs", import.meta.url));
        const env = Object.fromEntries(Object.entries(process.env)
            .filter(([key]) => !PROXY_ENVIRONMENT_KEYS.has(key.toLowerCase())));
        const child = spawn(command, [probe, String(server.address().port), String(tlsServer.address().port)],
            {windowsHide: true, stdio: ["ignore", "pipe", "pipe"], env});
        let output = "";
        child.stdout.on("data", (chunk) => {output += chunk;});
        child.stderr.on("data", (chunk) => {output += chunk;});
        const timeout = setTimeout(() => child.kill(), PROBE_TIMEOUT_MS);
        t.after(() => {clearTimeout(timeout); child.kill();});
        const code = await new Promise((resolve, reject) => {
            child.once("error", reject);
            child.once("close", resolve);
        });
        assert.equal(code, 0, output);
        const expectedPaths = ["/baseline", "/ok", "/ok", "/trickle", "/redirect", "/error"];
        if (runtime === "bun") expectedPaths.push("/credentials", "/credentials");
        assert.deepEqual(received.map(({path}) => path), expectedPaths);
        for (const entry of received.filter(({path}) => path !== "/baseline" && path !== "/credentials")) {
            assert.equal(entry.body, BODY);
            assert.equal(entry.headers.host, `${HOSTNAME}:${server.address().port}`);
            assert.equal(entry.headers["content-type"], "text/plain, application/x-fixture");
            assert.equal(entry.headers.authorization, "Bearer synthetic-fixture");
        }
        const baseline = received[0].headers;
        const candidate = received[1].headers;
        for (const header of ["user-agent", "accept", "accept-language", "sec-fetch-mode", "accept-encoding"])
            assert.equal(candidate[header], baseline[header], header);
        if (runtime === "bun") {
            assert.equal(received.at(-2).headers.authorization, undefined, "Bun fetch ignored embedded URL credentials");
            assert.equal(received.at(-1).headers.authorization, "Bearer explicit-fixture");
        }
        assert.equal(received[1].socket, received[2].socket, "completed drain discarded the reusable connection");
        assert.ok(sockets.size < received.length);
        assert.equal(trickleClosed, true, "the actual connection outlived the abort");
        assert.deepEqual(tlsObserved, {host: `${HOSTNAME}:${tlsServer.address().port}`, sni: HOSTNAME});
    });
}
