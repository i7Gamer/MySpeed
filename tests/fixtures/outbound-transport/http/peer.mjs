// Independent Node peer: the client under test may be Node, Bun or compiled Bun.
// CONNECT always forwards to this process's owned loopback origin, never its path.
import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import fs from "node:fs";
import path from "node:path";

const HOST = "outbound-fixture.invalid";
const LOCAL = "127.0.0.1";
const EPHEMERAL_PORT = 0;
const TRICKLE_MS = 20;
const MAX_BODY_BYTES = 4096;
const KEEPALIVE_TIMEOUT_MS = 30000;
const options = JSON.parse(process.env.OUTBOUND_HTTP_PEER_OPTIONS || "{}");
const certificateDir = process.env.OUTBOUND_TLS_FIXTURE_DIR || path.resolve("tests/fixtures/outbound-tls");
const cert = fs.readFileSync(path.join(certificateDir, "cert.pem"));
const key = fs.readFileSync(path.join(certificateDir, "key.pem"));
const sockets = new Set();
const peers = [];
const seen = {connects: [], posts: [], sni: [], connections: 0, unsafe: []};
const concurrent = new Map();
const track = socket => {
    sockets.add(socket);
    seen.connections++;
    socket.on("error", () => undefined);
    socket.on("close", () => sockets.delete(socket));
};
const tlsOptionsFor = (cert, key) => ({
    cert, key,
    SNICallback: (hostname, callback) => {
        seen.sni.push(hostname);
        if (options.strictSni && hostname !== HOST) return callback(new Error("fixture refuses incorrect SNI"));
        callback(null, tls.createSecureContext({cert, key}));
    }
});
const tlsOptions = tlsOptionsFor(cert, key);
const originTls = options.ipCertificate ? tlsOptionsFor(
    fs.readFileSync(path.join(certificateDir, "ip-cert.pem")),
    fs.readFileSync(path.join(certificateDir, "ip-key.pem"))) : tlsOptions;
const origin = https.createServer(originTls, (request, response) => {
    let body = "";
    request.on("data", chunk => {
        body += chunk.toString();
        if (Buffer.byteLength(body) > MAX_BODY_BYTES) request.destroy();
    });
    request.on("end", () => {
        seen.posts.push({url: request.url, headers: request.headers, body, servername: request.socket.servername});
        if (request.url === "/close") return request.socket.destroy();
        if (request.url === "/stall-headers") return;
        if (request.url === "/concurrent-abort" || request.url === "/concurrent-ok") {
            concurrent.set(request.url, {response, socket: request.socket});
            const aborted = concurrent.get("/concurrent-abort");
            const surviving = concurrent.get("/concurrent-ok");
            if (aborted && surviving) {
                // Both POSTs must reach the peer before the first headers tell
                // the client to abort. The second responds only after that
                // tunnel closes, eliminating scheduler-dependent deadlines.
                aborted.socket.once("close", () => surviving.response.end("ok"));
                aborted.response.writeHead(200);
                aborted.response.write("ready to abort");
            }
            return;
        }
        response.writeHead(options.status || 200, options.redirect ? {location: "https://169.254.169.254/blocked"} : {});
        if (request.url === "/trickle") {
            response.write("start");
            const timer = setInterval(() => response.write("chunk"), TRICKLE_MS);
            response.on("close", () => clearInterval(timer));
            return;
        }
        if (request.url === "/body-close") {
            response.write("start");
            const timer = setTimeout(() => response.destroy(), TRICKLE_MS);
            response.on("close", () => clearTimeout(timer));
            return;
        }
        response.end("synthetic response");
    });
});
origin.on("connection", track);
// Outlive the application's five-second idle lease timeout. Otherwise the
// server's default timeout could make a broken client expiry test pass.
origin.keepAliveTimeout = KEEPALIVE_TIMEOUT_MS;
await new Promise(resolve => origin.listen(EPHEMERAL_PORT, options.ipv6 ? "::1" : LOCAL, resolve));
peers.push(origin);
const proxy = options.stallProxyTls ? net.createServer(socket => {
    socket.resume();
    socket.once("end", () => socket.destroy());
}) : options.secureProxy ? https.createServer(tlsOptions) : http.createServer();
proxy.on("connection", track);
proxy.on("connect", (request, client, head) => {
    client.once("end", () => client.destroy());
    seen.connects.push({path: request.url, headers: request.headers});
    const hostname = new URL(`http://${request.url}`).hostname;
    if (![LOCAL, "127.0.0.2", "[::1]", HOST, "wrong-fixture.invalid"].includes(hostname)) {
        seen.unsafe.push(request.url);
        client.destroy();
        return;
    }
    if (options.stallConnect) return;
    if (options.malformedConnect) return client.end("malformed fixture response\r\n\r\n");
    if (options.connectStatus) {
        const location = options.redirect ? "Location: https://169.254.169.254/blocked\r\n" : "";
        return client.end(`HTTP/1.1 ${options.connectStatus} Fixture\r\n${location}Content-Length: 0\r\n\r\n`);
    }
    if (options.stallTls) {
        client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        // Consume handshake bytes so a client FIN can be observed while this
        // synthetic TLS peer deliberately never answers the handshake.
        client.resume();
        return;
    }
    if (options.firstTlsFailure && hostname === "127.0.0.2")
        return client.end("HTTP/1.1 200 Connection Established\r\n\r\n");
    const upstream = net.connect({host: options.ipv6 ? "::1" : LOCAL, port: origin.address().port}, () => {
        client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head.length) upstream.write(head);
        client.pipe(upstream);
        upstream.pipe(client);
    });
    // A closed tunnel endpoint owns the whole relay. Without this, the test
    // proxy itself retains half-open origin sockets after a correct abort.
    client.once("close", () => upstream.destroy());
    upstream.once("close", () => client.destroy());
    track(upstream);
});
await new Promise(resolve => proxy.listen(EPHEMERAL_PORT, LOCAL, resolve));
peers.push(proxy);
process.on("message", async message => {
    if (message.command === "snapshot") process.send({id: message.id, result: {...seen, openSockets: sockets.size}});
    if (message.command === "close") {
        for (const socket of sockets) socket.destroy();
        await Promise.all(peers.map(peer => new Promise(resolve => peer.close(resolve))));
        process.send({id: message.id, result: true});
    }
});
process.send({ready: true, originPort: origin.address().port, proxyPort: proxy.address().port});
