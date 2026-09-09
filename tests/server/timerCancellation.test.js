import { it } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { createRequire } from "node:module";
import { transformSync } from "esbuild";
import { readSource } from "../helpers/source.js";

const require = createRequire(import.meta.url);
const CRON = "0 3 1 1 *";
const OTHER_CRON = "0 4 1 1 *";
const source = transformSync(readSource("server/tasks/timer.js"), {format: "cjs", platform: "node"}).code;
const deferred = () => Promise.withResolvers();

// Evaluate the real module with isolated I/O boundaries: no database, real
// speedtest, scheduled job, or wall-clock delay is started by this fixture.
const fixture = (t, {offset = true} = {}) => {
    const delayStarted = deferred();
    const pending = new Map();
    const reads = [];
    const rounds = [];
    const pause = {currentState: false};
    const controls = {closed: false, quiet: false, onRead: async () => {}};
    let nextId = 0;
    const config = {getValue: async key => {
        reads.push(key);
        if (controls.closed) throw new Error("configuration database closed");
        await controls.onRead(key);
        return key === "scheduleOffset" ? String(offset) : undefined;
    }};
    const mocks = {
        "../controller/pause.js": pause,
        "../controller/config.js": config,
        "node-schedule": {scheduleJob: () => ({cancel() {}})},
        "./speedtest.js": {create: async kind => { rounds.push(kind); }},
        "./digestReport.js": {runDigest: async () => {}},
        "../util/quietHours.js": {isQuietHour: () => controls.quiet},
        "../util/timezone.js": {serverZone: undefined, zoneFromName: () => undefined},
        "../util/errorHandler.js": () => {}
    };
    const module = {exports: {}};
    vm.runInNewContext(source, {module, exports: module.exports,
        require: name => Object.hasOwn(mocks, name) ? mocks[name] : require(name),
        console: {log() {}, warn() {}},
        setTimeout: callback => { const id = nextId++; pending.set(id, callback); delayStarted.resolve(); return id; },
        clearTimeout: id => pending.delete(id)
    });
    const timer = module.exports;
    timer.startTimer(CRON);
    t.after(() => timer.stopTimer());
    const wake = () => { for (const [id, callback] of pending) { pending.delete(id); callback(); } };
    return {timer, controls, pause, reads, rounds, delayStarted: delayStarted.promise, wake};
};

it("stop releases an offset without starting reads against a closing database", async t => {
    const f = fixture(t);
    const running = f.timer.runTask();
    await f.delayStarted;
    const before = f.reads.length;
    f.controls.closed = true;
    f.timer.stopTimer();
    await assert.doesNotReject(running);
    assert.equal(f.reads.length, before);
    assert.deepEqual(f.rounds, []);
});

it("reschedule releases the obsolete offset without more reads", async t => {
    const f = fixture(t);
    const running = f.timer.runTask();
    await f.delayStarted;
    const before = f.reads.length;
    f.timer.startTimer(OTHER_CRON);
    await running;
    assert.equal(f.reads.length, before);
    assert.deepEqual(f.rounds, []);
});

it("the final generation guard rejects rescheduling during the post-delay read", async t => {
    const f = fixture(t);
    const running = f.timer.runTask();
    await f.delayStarted;
    f.controls.onRead = async key => { if (key === "timezone") f.timer.startTimer(OTHER_CRON); };
    f.wake();
    await running;
    assert.deepEqual(f.rounds, []);
});

it("the final guard also protects runs without an offset", async t => {
    const f = fixture(t, {offset: false});
    f.controls.onRead = async key => { if (key === "scheduleOffset") f.timer.stopTimer(); };
    await f.timer.runTask();
    assert.deepEqual(f.rounds, []);
});

it("startup still notices a pause during its final configuration read", async t => {
    const f = fixture(t);
    f.controls.onRead = async key => { if (key === "timezone") f.pause.currentState = true; };
    await f.timer.runTask({immediate: true});
    assert.deepEqual(f.rounds, []);
    assert.ok(!f.reads.includes("scheduleOffset"));
});

for (const quiet of [false, true]) {
    it(`a current delayed run preserves quiet-hours suppression (${quiet})`, async t => {
        const f = fixture(t);
        const running = f.timer.runTask();
        await f.delayStarted;
        f.controls.quiet = quiet;
        f.wake();
        await running;
        assert.deepEqual(f.rounds, quiet ? [] : ["auto"]);
    });
}

it("pause alone retains post-delay reads but suppresses the round", async t => {
    const f = fixture(t);
    const running = f.timer.runTask();
    await f.delayStarted;
    const before = f.reads.length;
    f.pause.currentState = true;
    f.wake();
    await running;
    assert.ok(f.reads.length > before);
    assert.deepEqual(f.rounds, []);
});
