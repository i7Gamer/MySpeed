import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isQuietHour as clientIsQuietHour } from "@/common/components/PauseDialog/quietHoursWindow.js";
import { isQuietHour as serverIsQuietHour } from "../../server/util/quietHours.js";

const ROOT = path.resolve(fileURLToPath(import.meta.url), "..", "..", "..");

const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), "utf8");

const clientSource = read("client", "src", "common", "components", "PauseDialog", "quietHoursWindow.js");
const serverSource = read("server", "util", "quietHours.js");

// The server's give-up limit lives with the schedule walker in tasks/timer.js
// rather than beside the window test, so the parity here reads a third file.
const timerSource = read("server", "tasks", "timer.js");

/**
 * The client re-implements the server's quiet window so the dialogs can say what
 * the scheduler is going to do without asking it: whether a window is complete
 * enough to be worth saving, and which scheduled occurrences will be skipped.
 * Two copies only work while they agree - a client that accepted a time the
 * server refuses would report a saved window that never applies, and one that
 * drew the window differently would announce a next test the scheduler skips,
 * which is the bug commit 7f684733 fixed for the status bar.
 *
 * Scanned from both sources rather than asserted as values, so the next change
 * to either side has to move both. Same approach as integrationLimits, which
 * guards the other place these two halves are written twice.
 */
const sentinelOf = (source) => {
    const match = source.match(/QUIET_HOURS_OFF\s*=\s*"([^"]*)"/);
    assert.ok(match, "no off sentinel found");

    return match[1];
};

const patternOf = (source) => {
    const match = source.match(/TIME_OF_DAY\s*=\s*(\/\S+\/)/);
    assert.ok(match, "no time-of-day pattern found");

    return match[1];
};

const boundsOf = (source) => {
    const match = source.match(/hours > (\d+) \|\| minutes > (\d+)/);
    assert.ok(match, "no hour and minute bounds found");

    return {hours: Number(match[1]), minutes: Number(match[2])};
};

const occurrenceLimitOf = (source) => {
    const match = source.match(/MAX_QUIET_OCCURRENCES\s*=\s*(\d+)/);
    assert.ok(match, "no swallowed-occurrence limit found");

    return Number(match[1]);
};

describe("the quiet hours window is read the same on both sides", () => {
    it("uses the same off sentinel", () => {
        assert.equal(sentinelOf(clientSource), sentinelOf(serverSource));
    });

    it("accepts the same time of day", () => {
        assert.equal(patternOf(clientSource), patternOf(serverSource));
    });

    it("bounds the hour and the minute the same way", () => {
        assert.deepEqual(boundsOf(clientSource), boundsOf(serverSource));
    });

    // Both walkers step over the occurrences a window swallows before giving
    // up, and the client's limit claims to mirror the server's: a client
    // allowed fewer steps would show no preview for a window the scheduler
    // still finds a way out of, and one allowed more would preview a test the
    // scheduler has already given up on.
    it("gives up after the same number of swallowed occurrences", () => {
        assert.equal(occurrenceLimitOf(clientSource), occurrenceLimitOf(timerSource));
    });
});

/**
 * The wrap-around, the half-open ends and the zero-length pair are decisions
 * rather than constants, so they are compared by running both copies over the
 * cases each one was written for.
 */
const WINDOWS = [
    ["23:00", "08:00"],
    ["09:00", "17:00"],
    ["09:00", "09:00"],
    ["23:00", "none"],
    ["none", "none"],
    ["0:30", "1:00"]
];

const MINUTES_PER_DAY = 24 * 60;
const MINUTE_STEP = 15;

describe("both sides agree on what falls inside a window", () => {
    for (const [start, end] of WINDOWS) {
        it(`${start} to ${end}`, () => {
            for (let minute = 0; minute < MINUTES_PER_DAY; minute += MINUTE_STEP) {
                const moment = new Date(2026, 0, 5, Math.floor(minute / 60), minute % 60);

                assert.equal(clientIsQuietHour(moment, start, end), serverIsQuietHour(moment, start, end),
                    `the two disagree at ${moment.toTimeString().slice(0, 5)} for ${start}-${end}`);
            }
        });
    }
});
