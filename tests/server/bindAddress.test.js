import { describe, it } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import https from "node:https";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getBindAddress } from "../../server/config/bind.js";

const LOOPBACK_IPV4 = "127.0.0.1";
const LOOPBACK_IPV6 = "::1";
const EPHEMERAL_PORT = 0;
const root = path.resolve(fileURLToPath(import.meta.url), "..", "..", "..");
const serverSource = fs.readFileSync(path.join(root, "server/index.js"), "utf8");

const listen = (server, host) => new Promise((resolve, reject) => {
    const onError = (error) => {
        server.off("listening", onListening);
        reject(error);
    };
    const onListening = () => {
        server.off("error", onError);
        resolve(server);
    };

    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(EPHEMERAL_PORT, host);
});

const close = (server) => new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
});

describe("SERVER_HOST bind configuration", () => {
    it("keeps the wildcard default when SERVER_HOST is unset or empty", () => {
        assert.equal(getBindAddress(undefined), undefined);
        assert.equal(getBindAddress(""), undefined);
    });

    it("accepts literal IPv4 and IPv6 addresses", () => {
        assert.equal(getBindAddress(LOOPBACK_IPV4), LOOPBACK_IPV4);
        assert.equal(getBindAddress(LOOPBACK_IPV6), LOOPBACK_IPV6);
    });

    it("rejects every nonempty value that is not a literal IP", () => {
        for (const value of ["localhost", "127.0.0.999", " 127.0.0.1 ", "https://127.0.0.1"]) {
            assert.throws(() => getBindAddress(value), {
                message: /SERVER_HOST must be a literal IPv4 or IPv6 address/
            });
        }
    });

    it("makes an IPv4 listener own the IPv4 loopback socket", async () => {
        const server = await listen(http.createServer(), getBindAddress(LOOPBACK_IPV4));

        try {
            assert.equal(net.isIP(server.address().address), 4);
            assert.equal(server.address().address, LOOPBACK_IPV4);
        } finally {
            await close(server);
        }
    });

    it("makes an IPv6 listener own the IPv6 loopback socket", async () => {
        const server = await listen(http.createServer(), getBindAddress(LOOPBACK_IPV6));

        try {
            assert.equal(net.isIP(server.address().address), 6);
            assert.equal(server.address().address, LOOPBACK_IPV6);
        } finally {
            await close(server);
        }
    });

    it("makes an HTTPS listener own the configured loopback socket", async () => {
        const server = await listen(https.createServer({
            key: fs.readFileSync(path.join(root, "tests", "fixtures", "outbound-tls", "key.pem")),
            cert: fs.readFileSync(path.join(root, "tests", "fixtures", "outbound-tls", "cert.pem"))
        }), getBindAddress(LOOPBACK_IPV4));

        try {
            assert.equal(server.address().address, LOOPBACK_IPV4);
        } finally {
            await close(server);
        }
    });

    it("passes the validated address to both HTTP and HTTPS listeners", () => {
        assert.match(serverSource, /app\.listen\(port, bindAddress,/);
        assert.match(serverSource, /httpsServer\.listen\(httpsPort, bindAddress,/);
    });
});
