import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { bootServer, setConfig } from "./helpers/boot.js";
import { isQuietHour, QUIET_HOURS_OFF } from "../../server/util/quietHours.js";

/**
 * runTask() itself, which is the only place the offset guard actually lives.
 *
 * The unit tests around it exercise the primitives - delayRun, stopTimer,
 * scheduleGeneration, scheduleChangedSince - in isolation, and every one of
 * them would still pass if runTask forgot to capture `startedIn` before its
 * first await, or forgot to consult it afterwards. That is the whole fix, so it
 * needs a test that runs it.
 *
 * The observable is the speedtests table. The provider is set to cloudflare and
 * no interface has been detected in a test boot, so missingInterfaceMessage
 * refuses the run on every platform before anything is spawned - the attempt
 * fails in milliseconds and records one failed row. A run that goes ahead
 * therefore adds a row and a run that is skipped does not, with no CLI, no
 * network and no timing involved.
 *
 * stopTimer() releasing the pending delay is what keeps this fast: the offset
 * delay is at least thirty seconds, and the test never waits for it.
 */
let server;
let timer;

before(async () => {
    server = await bootServer();
    timer = await import("../../server/tasks/timer.js");
});

after(async () => {
    timer.stopTimer();
    await server?.close();
});

// Far enough out that node-schedule never fires it during the test; it is here
// only so runTask has a currentCron to compute a delay from.
const DISTANT_CRON = "0 3 1 1 *";

const countTests = () => server.tests.count();

const MINUTES_PER_HOUR = 60;

/**
 * The clock a while from now as "HH:MM", so a quiet window can be described
 * relative to the moment the test runs rather than written out.
 */
const clockAt = (offsetMinutes) => {
    const moment = new Date(Date.now() + offsetMinutes * 60_000);

    return `${String(moment.getHours()).padStart(2, "0")}:${String(moment.getMinutes()).padStart(2, "0")}`;
};

const setWindow = async (start, end) => {
    await setConfig(server.config, "quietHoursStart", start);
    await setConfig(server.config, "quietHoursEnd", end);
};

beforeEach(async () => {
    timer.stopTimer();
    await server.tests.destroy({where: {}});
    await setConfig(server.config, "provider", "cloudflare");
});

/** Lets runTask get as far as its delay before the test interferes. */
const reachedDelay = async () => {
    for (let attempt = 0; attempt < 50; attempt++) {
        if (timer.pendingDelayCount() > 0) return true;
        await new Promise((resolve) => setImmediate(resolve));
    }
    return false;
};

describe("runTask with the schedule offset enabled", () => {
    it("does not test when the schedule was stopped during its delay", async () => {
        await setConfig(server.config, "scheduleOffset", "true");
        timer.startTimer(DISTANT_CRON);

        const run = timer.runTask();
        assert.ok(await reachedDelay(), "runTask never reached its offset delay");

        timer.stopTimer();
        await run;

        assert.equal(await countTests(), 0,
            "a run whose schedule was stopped underneath it went ahead and tested anyway");
    });

    it("does not test when the schedule was replaced during its delay", async () => {
        await setConfig(server.config, "scheduleOffset", "true");
        timer.startTimer(DISTANT_CRON);

        const run = timer.runTask();
        assert.ok(await reachedDelay(), "runTask never reached its offset delay");

        // A reschedule, which is what changing the cron in the settings does.
        // Nothing is paused here, so the pause check on the far side of the
        // delay cannot be what catches this.
        timer.startTimer("0 4 1 1 *");
        await run;

        assert.equal(await countTests(), 0,
            "changing the cron was still followed by one run from the schedule it replaced");
    });

    /**
     * The control. Without it the two tests above would pass just as happily on
     * a runTask that never tests at all.
     */
    it("does test when nothing disturbed it", async () => {
        await setConfig(server.config, "scheduleOffset", "false");
        timer.startTimer(DISTANT_CRON);

        await timer.runTask();

        assert.equal(await countTests(), 1,
            "an undisturbed run recorded nothing, so the assertions above prove nothing");
    });

    it("leaves no delay in flight once it has finished", async () => {
        await setConfig(server.config, "scheduleOffset", "true");
        timer.startTimer(DISTANT_CRON);

        const run = timer.runTask();
        await reachedDelay();
        timer.stopTimer();
        await run;

        assert.equal(timer.pendingDelayCount(), 0);
    });
});

/**
 * The daily quiet window, checked where it has to be checked: inside runTask.
 *
 * The predicate has its own unit tests, and every one of them would still pass
 * if the scheduler never consulted it. The window is computed from the clock at
 * the moment of the test rather than written out, so the assertions hold
 * whenever the suite happens to run.
 */
describe("runTask during the configured quiet hours", () => {
    beforeEach(async () => {
        await setConfig(server.config, "scheduleOffset", "false");
        await setWindow("none", "none");
    });

    after(async () => {
        await setWindow("none", "none");
    });

    it("does not test inside the window", async () => {
        await setWindow(clockAt(-MINUTES_PER_HOUR), clockAt(MINUTES_PER_HOUR));
        timer.startTimer(DISTANT_CRON);

        await timer.runTask();

        assert.equal(await countTests(), 0, "a test ran during the quiet hours");
    });

    it("tests outside the window", async () => {
        await setWindow(clockAt(MINUTES_PER_HOUR), clockAt(2 * MINUTES_PER_HOUR));
        timer.startTimer(DISTANT_CRON);

        await timer.runTask();

        assert.equal(await countTests(), 1, "a test outside the quiet hours was skipped");
    });

    // The window everyone actually wants, and the one a naive comparison gets
    // wrong: its end is a smaller number than its start.
    it("does not test inside a window that crosses midnight", async () => {
        await setWindow(clockAt(-MINUTES_PER_HOUR), clockAt(-2 * MINUTES_PER_HOUR));
        timer.startTimer(DISTANT_CRON);

        await timer.runTask();

        assert.equal(await countTests(), 0, "a window spanning midnight silenced nothing");
    });

    it("tests when no window is configured", async () => {
        timer.startTimer(DISTANT_CRON);

        await timer.runTask();

        assert.equal(await countTests(), 1, "an unconfigured window skipped the run");
    });

    // Only one end set is not a window, and must not be read as one.
    it("tests when only one end of the window is set", async () => {
        await setWindow(clockAt(-MINUTES_PER_HOUR), "none");
        timer.startTimer(DISTANT_CRON);

        await timer.runTask();

        assert.equal(await countTests(), 1, "half a window silenced the run");
    });
});

/**
 * The same window, met on the far side of the offset's sleep.
 *
 * The offset is on by default, so for a default install the check behind the
 * delay is the only thing standing between a run that started outside the
 * window and a test inside it - the delay runs to five minutes, long enough to
 * sleep straight into the hours the operator set aside. The describe above
 * never reaches that check: it pins the offset off and so only exercises the
 * one before the delay.
 *
 * The sleep is held rather than shortened: its callback is captured so the
 * window can be configured while the run is provably asleep, then released by
 * hand. Shortening it to zero instead would race the configuration writes
 * against the wake.
 */
describe("the quiet hours beginning during the offset delay", () => {
    // Not a live timer id. The held callback is invoked by hand, so there is
    // nothing for a clearTimeout on the far side to cancel.
    const HELD_SLEEP_ID = 0;

    /**
     * Holds the offset's sleep until the test releases it.
     *
     * It steps aside the moment it has seen that timer - recognised by being
     * at least the offset floor, which nothing else the run creates reaches -
     * so everything else still runs on real ones.
     */
    const holdOffsetSleep = () => {
        const realSetTimeout = globalThis.setTimeout;
        const held = {
            release: null,
            restore: () => { globalThis.setTimeout = realSetTimeout; }
        };

        globalThis.setTimeout = (callback, ms, ...args) => {
            if (ms >= timer.OFFSET_MIN_DELAY_MS) {
                held.restore();
                held.release = () => callback(...args);
                return HELD_SLEEP_ID;
            }

            return realSetTimeout(callback, ms, ...args);
        };

        return held;
    };

    /** Collects console.warn output, so a skip can be pinned to its reason. */
    const recordWarnings = () => {
        const realWarn = console.warn;
        const recorded = {
            messages: [],
            restore: () => { console.warn = realWarn; }
        };

        console.warn = (...args) => { recorded.messages.push(args.join(" ")); };

        return recorded;
    };

    beforeEach(async () => {
        await setConfig(server.config, "scheduleOffset", "true");
        await setWindow(QUIET_HOURS_OFF, QUIET_HOURS_OFF);
    });

    after(async () => {
        await setWindow(QUIET_HOURS_OFF, QUIET_HOURS_OFF);
    });

    it("does not test when the window begins during the delay", async () => {
        // Armed before the shim, or its own far-future timer would be taken
        // for the offset's sleep.
        timer.startTimer(DISTANT_CRON);

        const sleep = holdOffsetSleep();
        const warnings = recordWarnings();

        try {
            const run = timer.runTask();
            assert.ok(await reachedDelay(), "runTask never reached its offset delay");

            // The window opens while the run is asleep, wide enough either
            // side that the wake falls squarely inside it.
            await setWindow(clockAt(-MINUTES_PER_HOUR), clockAt(MINUTES_PER_HOUR));

            sleep.release();
            await run;
        } finally {
            sleep.restore();
            warnings.restore();
        }

        assert.equal(await countTests(), 0,
            "a run that slept into the quiet window went ahead and tested anyway");
        assert.ok(warnings.messages.some((message) => message.includes("Quiet hours began during delay")),
            "the skip was not announced as a quiet hours skip");
        assert.notEqual(timer.currentJob(), undefined,
            "the skip tore the schedule down instead of leaving the next occurrence to it");
    });

    /**
     * The control. The undisturbed run above proves nothing here: it pins the
     * offset off, so a post-delay check that refused every run - inverted,
     * say - would still pass the skip test while silencing every default
     * install. This one has to come out the far side of the sleep and test.
     */
    it("does test when the window never opens", async () => {
        timer.startTimer(DISTANT_CRON);

        const sleep = holdOffsetSleep();

        try {
            const run = timer.runTask();
            assert.ok(await reachedDelay(), "runTask never reached its offset delay");

            sleep.release();
            await run;
        } finally {
            sleep.restore();
        }

        assert.equal(await countTests(), 1,
            "an undisturbed offset run recorded nothing, so the skip above proves nothing");
    });
});

/**
 * A reschedule that lands while the run is reading the quiet hours.
 *
 * The generation counter only closes the window between the offset's sleep and
 * the speedtest for as long as nothing is awaited after its guard. Reading the
 * quiet window is two config reads, and a PATCH /config/cron arriving while
 * those were in flight was seen by no guard at all - the one before them had
 * already passed - so one test still fired from the schedule that had just been
 * replaced, which is the exact failure the counter exists to catch.
 *
 * The config reads runTask makes are answered from here rather than from the
 * database. That is what puts the reschedule at precisely that moment, and it
 * also leaves the offset's own sleep as the only long timer created while the
 * run is on its way to it.
 */
describe("a reschedule landing while the post-delay quiet hours are read", () => {
    const REPLACEMENT_CRON = "0 4 1 1 *";

    let configModel;
    let realFindByPk;

    before(async () => {
        configModel = (await import("../../server/models/Config.js")).default;
        realFindByPk = configModel.findByPk;
    });

    /**
     * Runs the offset's sleep out at once, and reports when it began.
     *
     * It steps aside the moment it has seen that timer, so the speedtest a
     * broken run would go on to start still runs on real ones.
     */
    const shortenOffsetSleep = (onSleepStarted) => {
        const realSetTimeout = globalThis.setTimeout;
        const restore = () => { globalThis.setTimeout = realSetTimeout; };

        globalThis.setTimeout = (callback, ms, ...args) => {
            // The offset floor: a timer at least this long, created while
            // nothing else in the run is running, can only be the sleep.
            if (ms >= timer.OFFSET_MIN_DELAY_MS) {
                restore();
                onSleepStarted();
                return realSetTimeout(callback, 0, ...args);
            }

            return realSetTimeout(callback, ms, ...args);
        };

        return restore;
    };

    /** Answers the two settings runTask consults, and watches for the reads. */
    const answerConfigReads = (onQuietHoursRead) => {
        configModel.findByPk = async (key, ...rest) => {
            if (key === "scheduleOffset") return {value: "true"};

            if (key === "quietHoursStart" || key === "quietHoursEnd") {
                onQuietHoursRead();
                return {value: QUIET_HOURS_OFF};
            }

            return realFindByPk.call(configModel, key, ...rest);
        };

        return () => { configModel.findByPk = realFindByPk; };
    };

    it("does not test", async () => {
        // Armed before the shim, or its own far-future timer would be taken for
        // the offset's sleep.
        timer.startTimer(DISTANT_CRON);

        let sleeping = false;
        let rescheduled = false;

        const restoreTimers = shortenOffsetSleep(() => { sleeping = true; });
        const restoreConfig = answerConfigReads(() => {
            // Only the check on the far side of the sleep. A reschedule during
            // the one before it is caught whichever way the guards are ordered,
            // so it would prove nothing.
            if (!sleeping || rescheduled) return;

            rescheduled = true;
            timer.startTimer(REPLACEMENT_CRON);
        });

        try {
            await timer.runTask();
        } finally {
            restoreTimers();
            restoreConfig();
        }

        assert.ok(rescheduled, "the reschedule never landed, so this proves nothing");
        assert.equal(await countTests(), 0,
            "a cron replaced while the quiet hours were being read was still followed by one test from the schedule it replaced");
    });
});

/**
 * What the status endpoint counts down to.
 *
 * `nextRun` read the cron and nothing else, so through a quiet window the
 * dashboard advertised a test at the top of each hour, the scheduler refused
 * it, and the countdown reset to the next one - all night, with nothing saying
 * why. The time shown has to be a time a test will actually run.
 *
 * The window is computed from the schedule's own next occurrence rather than
 * written out, so the assertions hold whenever the suite happens to run.
 */
describe("nextRun through the configured quiet hours", () => {
    const HOURLY = "0 * * * *";
    const HOURS_PER_DAY = 24;

    const atHour = (date, offsetHours) =>
        `${String((date.getHours() + offsetHours + HOURS_PER_DAY) % HOURS_PER_DAY).padStart(2, "0")}:00`;

    it("names the plain next occurrence when no window is set", () => {
        assert.equal(timer.nextRun(HOURLY), timer.nextRun(HOURLY, {start: "none", end: "none"}));
    });

    it("names the plain next occurrence for a window it falls outside", () => {
        const plain = new Date(timer.nextRun(HOURLY));
        // A window starting an hour after the next test and lasting an hour.
        const window = {start: atHour(plain, 1), end: atHour(plain, 2)};

        assert.equal(timer.nextRun(HOURLY, window), plain.toISOString());
    });

    // The whole point: an occurrence the scheduler would skip is not offered.
    it("skips the occurrences a quiet window would swallow", () => {
        const plain = new Date(timer.nextRun(HOURLY));
        const window = {start: atHour(plain, 0), end: atHour(plain, 2)};

        const announced = new Date(timer.nextRun(HOURLY, window));

        assert.ok(announced > plain, "the quiet window did not push the announced test out");
        assert.equal(isQuietHour(announced, window.start, window.end), false,
            "the announced test still falls inside the quiet window");
    });

    // A window that crosses midnight is the one people actually set.
    it("skips a window that crosses midnight", () => {
        const plain = new Date(timer.nextRun(HOURLY));
        const window = {start: atHour(plain, 0), end: atHour(plain, 3)};

        const announced = new Date(timer.nextRun(HOURLY, window));

        assert.equal(isQuietHour(announced, window.start, window.end), false);
    });

    it("still answers null for a cron it cannot read", () => {
        assert.equal(timer.nextRun("not a cron", {start: "23:00", end: "08:00"}), null);
    });
});
