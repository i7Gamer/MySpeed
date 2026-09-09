import {it, before, after, beforeEach} from "node:test";
import assert from "node:assert/strict";
import express from "express";
import bcrypt from "bcryptjs";
import {bootServer} from "./helpers/boot.js";
import {proxyRequest} from "../../server/controller/node.js";
import password, {allowsPasswordlessAccess, resetFailedAttempts} from "../../server/middlewares/password.js";
import {clientKey} from "../../server/util/clientKey.js";

const LOOPBACK = "127.0.0.1";
const FAILED_BUDGET = 20;
const PASSWORD = "child-password";
const TEST_HASH_ROUNDS = 4;
let fixture, child, parent, parentUrl;
let childApp;
const env = {TRUST_PROXY: process.env.TRUST_PROXY, ALLOW_LOCAL_NODES: process.env.ALLOW_LOCAL_NODES,
    ALLOW_NO_PASSWORD: process.env.ALLOW_NO_PASSWORD};
const listen = (app) => new Promise((resolve) => {
    const listener = app.listen(0, LOOPBACK, () => resolve(listener));
});
const request = async (headers = {}, path = "/identity") => {
    const response = await fetch(parentUrl + path, {headers});
    return {status: response.status, body: await response.json()};
};

before(async () => {
    process.env.ALLOW_LOCAL_NODES = "true";
    fixture = await bootServer();
    childApp = express();
    childApp.get("/identity", (req, res) => res.json({ip: req.ip, key: clientKey(req),
        hostname: req.hostname, protocol: req.protocol, local: allowsPasswordlessAccess(req),
        forwarded: req.headers.forwarded}));
    childApp.get("/protected", password(false), (_req, res) => res.json({ok: true}));
    child = await listen(childApp);
    const relay = express();
    relay.use((req, res) => proxyRequest(`http://${LOOPBACK}:${child.address().port}${req.url}`, req, res));
    parent = await listen(relay);
    parentUrl = `http://${LOOPBACK}:${parent.address().port}`;
});

beforeEach(async () => {
    delete process.env.TRUST_PROXY;
    delete process.env.ALLOW_NO_PASSWORD;
    childApp.set("trust proxy", false);
    resetFailedAttempts();
    await fixture.config.updateValue("password", fixture.config.NO_PASSWORD);
});

after(async () => {
    for (const listener of [parent, child]) await new Promise((resolve) => listener.close(resolve));
    await fixture.close();
    for (const [key, value] of Object.entries(env)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
    }
});

for (const header of ["Forwarded", "X-Forwarded-For", "X-Real-IP", "X-Client-IP"]) {
    it(`preserves setup-token refusal for original ${header} relay evidence`, async () => {
        const result = await request({[header]: "198.51.100.1"}, "/protected");
        assert.equal(result.status, 401);
        assert.equal(result.body.type, "SETUP_TOKEN_REQUIRED");
    });
}

it("preserves headerless loopback and host/proto-only passwordless access", async () => {
    for (const headers of [{}, {"X-Forwarded-Host": "attacker.test", "X-Forwarded-Proto": "https"}]) {
        assert.equal((await request(headers, "/protected")).status, 200);
        const {body} = await request(headers);
        assert.equal(body.local, true);
        assert.equal(body.hostname, LOOPBACK);
        assert.equal(body.protocol, "http");
    }
});

it("preserves TRUST_PROXY refusal and the explicit passwordless override", async () => {
    process.env.TRUST_PROXY = "1";
    childApp.set("trust proxy", 1);
    assert.equal((await request({}, "/protected")).body.type, "SETUP_TOKEN_REQUIRED");
    process.env.ALLOW_NO_PASSWORD = "true";
    assert.equal((await request({"X-Forwarded-For": "198.51.100.1"}, "/protected")).status, 200);
});

it("keys varied forwarded callers by the parent connection on a trusted-proxy child", async () => {
    process.env.TRUST_PROXY = "1";
    childApp.set("trust proxy", 1);
    for (const address of ["198.51.100.1", "203.0.113.2"]) {
        const {body} = await request({"X-Forwarded-For": address, "X-Forwarded-Host": "attacker.test",
            "X-Forwarded-Proto": "https"});
        assert.equal(body.ip, LOOPBACK);
        assert.equal(body.key, LOOPBACK);
        assert.equal(body.hostname, LOOPBACK);
        assert.equal(body.protocol, "http");
        assert.equal(body.forwarded, "for=unknown");
        assert.equal(body.local, false);
    }
});

it("rotating forwarded addresses cannot evade the shared failed-password budget", async () => {
    process.env.TRUST_PROXY = "1";
    childApp.set("trust proxy", 1);
    await fixture.config.updateValue("password", await bcrypt.hash(PASSWORD, TEST_HASH_ROUNDS));
    assert.equal((await request({"x-password": PASSWORD}, "/protected")).status, 200);
    for (let index = 0; index < FAILED_BUDGET; index++) {
        const result = await request({"x-password": "wrong", "X-Forwarded-For": `198.51.100.${index + 1}`}, "/protected");
        assert.equal(result.status, 401);
    }
    const result = await request({"x-password": "wrong", "X-Forwarded-For": "203.0.113.1"}, "/protected");
    assert.equal(result.status, 429);
    assert.equal(result.body.type, "TOO_MANY_ATTEMPTS");
});

it("does not grant the local waiver to a remote socket", () => {
    assert.equal(allowsPasswordlessAccess({headers: {host: "127.0.0.1"},
        socket: {remoteAddress: "192.168.1.10"}}), false);
});
