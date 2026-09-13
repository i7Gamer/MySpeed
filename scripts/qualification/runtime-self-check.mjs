#!/usr/bin/env node
import assert from "node:assert/strict";
import {
    assertLinuxNetworkIsolation,
    assertOwnedListener,
    buildLocalOrigin,
    checkPng,
    sanitizedEnvironment
} from "./safety.mjs";

const HOST = "127.0.0.1";
const PORT = 43127;
const PID = 8123;
const WIDTH = 1_200;
const HEIGHT = 600;
const PNG_BYTES = 64;

assert.equal(buildLocalOrigin(HOST, PORT), `http://${HOST}:${PORT}`);
assert.throws(() => buildLocalOrigin("0.0.0.0", PORT));
assert.deepEqual(sanitizedEnvironment({PATH: "fixture", DB_TYPE: "mysql", HTTP_PROXY: "bad"}, {
    host: HOST,
    port: PORT
}), {
    PATH: "fixture",
    NODE_ENV: "production",
    DB_TYPE: "sqlite",
    SERVER_HOST: HOST,
    SERVER_PORT: String(PORT),
    RUN_TEST_ON_STARTUP: "false"
});
assert.doesNotThrow(() => assertOwnedListener({
    listeners: [{address: HOST, port: PORT, pid: PID}], host: HOST, port: PORT, pid: PID
}));
assert.throws(() => assertOwnedListener({
    listeners: [{address: "0.0.0.0", port: PORT, pid: PID}], host: HOST, port: PORT, pid: PID
}));
assert.doesNotThrow(() => assertLinuxNetworkIsolation({
    platform: "linux",
    routeTable: "Iface Destination Gateway Flags\nlo 00000000 00000000 0001",
    ipv6RouteTable: ""
}));

const png = Buffer.alloc(PNG_BYTES, 1);
Buffer.from("89504e470d0a1a0a", "hex").copy(png);
png.writeUInt32BE(13, 8);
png.write("IHDR", 12, "ascii");
png.writeUInt32BE(WIDTH, 16);
png.writeUInt32BE(HEIGHT, 20);
assert.deepEqual(checkPng(png), {width: WIDTH, height: HEIGHT, bytes: PNG_BYTES});

console.log(`qualification safety contract passed on ${process.release?.name ?? "runtime"}`);
