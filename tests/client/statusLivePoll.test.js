import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { IDLE_POLL_MS, LIVE_POLL_MS } from "@/common/utils/StatusUtil.js";
import { compile, read, rules } from "../helpers/sass.mjs";

const contextSource = read("common/contexts/Status/StatusContext.jsx");
const bar = compile("common/components/StatusBar/styles.sass");

const MS_PER_SECOND = 1000;
const SECONDS_PER_MINUTE = 60;

// The server's general backstop, read from where it is declared - the number
// is deliberately not restated here, so raising or lowering it moves this
// test's bound with it.
const appSource = fs.readFileSync(
    path.resolve(fileURLToPath(import.meta.url), "..", "..", "..", "server", "app.js"), "utf8");
const backstop = Number(appSource.match(/API_REQUESTS_PER_MINUTE = (\d+)/)?.[1]);

/**
 * The run is followed from /status/live - four in-memory fields - instead of
 * dragging the full status route's two database queries and three config reads
 * along at the sampling rate. The full poll stays at its idle pace during a
 * run; the live poll's falling edge is what refreshes it the moment the run
 * ends.
 */
describe("the live poll", () => {

    it("asks the live route, not the full one, at the sampling rate", () => {
        assert.match(contextSource, /\/speedtests\/status\/live/);
        assert.match(contextSource, /LIVE_POLL_MS/);
    });

    it("keeps the full poll at its idle pace while the live poll watches", () => {
        assert.match(contextSource, /pollIntervalFor\(status,\s*liveSupported\)/,
            "the full poll's interval does not know whether the live poll is watching");
    });

    it("refreshes the full status on the falling edge it sees first", () => {
        assert.match(contextSource, /runJustFinished\(/,
            "a run's end is not what triggers the full refresh");
    });

    /**
     * A remote node on an older version has no live route and answers 404 -
     * through the node proxy this client polls, so it is a lasting state, not
     * an upgrade window. One such answer sends the client back to the old
     * fast full poll; anything else - a timeout, a 500 - keeps the last
     * reading, exactly as the full poll does.
     */
    it("falls back to the fast full poll when the route is not there", () => {
        assert.match(contextSource, /NOT_FOUND/);
        assert.match(contextSource, /setLiveSupported\(false\)/);
    });

    it("spares a hidden tab, like every other poll here", () => {
        const guards = contextSource.match(/document\.hidden/g) ?? [];
        assert.ok(guards.length >= 3,
            "the live timer ticks for a wall dashboard nobody is looking at");
    });

    /**
     * What bounds the sampling rate: the general API backstop admits 300 a
     * minute as of this writing, and the limiter cannot tell a progress poll
     * from anything else. The live and idle polls together must fit under it
     * with room for the person actually using the page - twice over, so a
     * second open tab does not lock the first one out.
     */
    it("fits under the API backstop twice over", () => {
        assert.ok(Number.isFinite(backstop), "the backstop moved out of server/app.js");

        const perMinute = (interval) => (SECONDS_PER_MINUTE * MS_PER_SECOND) / interval;
        const TABS = 2;

        assert.ok(TABS * (perMinute(LIVE_POLL_MS) + perMinute(IDLE_POLL_MS)) <= backstop,
            `${LIVE_POLL_MS}ms sampling leaves no headroom under ${backstop}/min`);
    });

    /**
     * The glide is the sampling rate, worn on the screen: the fill is told a
     * new width every LIVE_POLL_MS and takes exactly that long to get there,
     * so it is always moving and never waiting. A duration shorter than the
     * poll stalls between samples; longer, and readings queue up behind the
     * ease. The two are pinned to each other here because the stylesheet
     * cannot import the constant.
     */
    it("glides the fill for exactly one sampling interval", () => {
        const fill = rules(bar).find((rule) => rule.selector === ".status-progress-fill")?.body ?? "";
        const duration = fill.match(/transition:\s*width\s+([\d.]+)s\s+linear/)?.[1];

        assert.notEqual(duration, undefined, "the fill no longer declares a linear width transition");
        assert.equal(Number(duration) * MS_PER_SECOND, LIVE_POLL_MS,
            "the glide and the sampling rate have drifted apart");
    });
});
