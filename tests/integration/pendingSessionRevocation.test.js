import {after, afterEach, before, beforeEach, describe, it} from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import bcrypt from "bcryptjs";
import {bootServer, api, setConfig} from "./helpers/boot.js";
import {PASSWORD_REQUIRED} from "../../server/util/authOutcome.js";

const PASSWORD = "Original-Password-1!";
const REPLACEMENT = "Replacement-Password-2!";
const FAILED_ATTEMPT_LIMIT = 20;
const TEST_TIMEOUT_MS = 15_000;
const READ_HOOK = "pending-session-read";
const EMPTY_TABLES = {nodes: [], integrations: [], recommendations: [], targets: []};
let server;
let configModel;
let timer;
let throttle;

before(async () => {
    server = await bootServer();
    configModel = (await import("../../server/models/Config.js")).default;
    timer = await import("../../server/tasks/timer.js");
    throttle = await import("../../server/middlewares/password.js");
});
beforeEach(async () => {
    throttle.resetFailedAttempts();
    await setConfig(server.config, "password", PASSWORD);
});
afterEach(async () => {
    configModel.removeHook("afterFind", READ_HOOK);
    timer.stopTimer();
    await new Promise(setImmediate);
});
after(async () => { await server?.close(); });

const deferred = () => {
    let resolve;
    const promise = new Promise((done) => { resolve = done; });
    return {promise, resolve};
};
const login = (password = PASSWORD) => api(server.baseUrl, "/session", {
    method: "POST", headers: {"content-type": "application/json"}, body: JSON.stringify({password})
});

// Gates the result of real work, never supplies an invented authentication
// result. The database hook captures the queried row before the later write.
const pauseLogin = (t, phase) => {
    const reached = deferred();
    const release = deferred();
    let paused = false;
    const pauseOnce = async () => {
        if (paused) return;
        paused = true;
        reached.resolve();
        await release.promise;
    };
    if (phase === "comparison") {
        const realCompare = bcrypt.compare;
        t.mock.method(bcrypt, "compare", async (...args) => {
            const valid = await realCompare(...args);
            if (valid) await pauseOnce();
            return valid;
        });
    } else {
        configModel.addHook("afterFind", READ_HOOK, async (row) => {
            if (row?.key === "password") await pauseOnce();
        });
    }
    return {reached: reached.promise, release: release.resolve};
};

const duringLogin = async (t, phase, mutate) => {
    const gate = pauseLogin(t, phase);
    const pending = login();
    try {
        await Promise.race([
            gate.reached,
            pending.then(() => { throw new Error(`login completed before its ${phase} was paused`); })
        ]);
        await mutate();
    } finally {
        gate.release();
    }
    return await pending;
};

const revoked = (result) => {
    assert.equal(result.status, 401, "an old successful login minted a session after revocation");
    assert.equal(result.headers.get("set-cookie"), null);
    assert.equal(result.body.type, PASSWORD_REQUIRED);
};

describe("pending logins across committed credential changes", () => {
    for (const phase of ["comparison", "database read"]) {
        for (const mutation of ["password update", "password clear", "same-hash restore", "factory reset"]) {
            it(`rejects an old ${phase} across ${mutation}`, {timeout: TEST_TIMEOUT_MS}, async (t) => {
                const hash = await server.config.getValue("password");
                // Reset starts an interface refresh; an empty snapshot prevents
                // real network probes and the afterEach hook stops its scheduler.
                t.mock.method(os, "networkInterfaces", () => ({}));
                const result = await duringLogin(t, phase, async () => {
                    if (mutation === "password update") await setConfig(server.config, "password", REPLACEMENT);
                    else if (mutation === "password clear") await server.config.clearPassword();
                    else if (mutation === "same-hash restore") {
                        assert.deepEqual(await server.config.importConfig({config: {password: hash}, ...EMPTY_TABLES}), {ok: true});
                    } else await server.config.factoryReset();
                });
                revoked(result);
            });
        }
    }

    it("does not count a stale success as a failure or clear prior failures", {timeout: TEST_TIMEOUT_MS}, async (t) => {
        const admission = throttle.reserveAttempt({ip: "127.0.0.1"});
        admission.settle({failed: FAILED_ATTEMPT_LIMIT - 1});
        const result = await duringLogin(t, "comparison", () => setConfig(server.config, "password", REPLACEMENT));
        revoked(result);
        assert.equal((await login("wrong-password")).status, 401,
            "the stale success consumed the final wrong-password allowance");
        assert.equal((await login(REPLACEMENT)).status, 429,
            "the stale success cleared the existing failure budget");
    });
});

describe("pending logins when credentials were not revoked", () => {
    for (const mutation of ["failed password write", "refused restore", "failed factory reset", "password-free restore"]) {
        it(`remains eligible across ${mutation}`, {timeout: TEST_TIMEOUT_MS}, async (t) => {
            const result = await duringLogin(t, "comparison", async () => {
                if (mutation === "failed password write") {
                    t.mock.method(configModel, "update", async () => { throw new Error("write refused"); });
                    await assert.rejects(setConfig(server.config, "password", REPLACEMENT), /write refused/);
                } else if (mutation === "refused restore") {
                    assert.equal((await server.config.importConfig({config: {password: "invalid-hash"}, ...EMPTY_TABLES})).ok, false);
                } else if (mutation === "failed factory reset") {
                    t.mock.method(configModel, "bulkCreate", async () => { throw new Error("reset refused"); });
                    await assert.rejects(server.config.factoryReset(), /reset refused/);
                } else {
                    assert.deepEqual(await server.config.importConfig({config: {retentionDays: "30"}, ...EMPTY_TABLES}), {ok: true});
                }
            });
            assert.equal(result.status, 200);
            const cookie = result.headers.get("set-cookie").split(";")[0];
            assert.equal((await api(server.baseUrl, "/session", {headers: {cookie}})).body.active, true);
        });
    }

    it("still admits ordinary concurrent correct logins", async () => {
        const results = await Promise.all([login(), login()]);
        for (const result of results) {
            assert.equal(result.status, 200);
            assert.ok(result.headers.get("set-cookie"));
        }
        assert.notEqual(results[0].headers.get("set-cookie"), results[1].headers.get("set-cookie"));
    });
});
