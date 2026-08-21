import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { blockEnd, readSource } from "../helpers/source.js";

const dropdownSource = readSource("client/src/common/components/Dropdown/DropdownComponent.jsx");

/**
 * `togglePause` taken out of the component and run.
 *
 * Same extraction as escapeTopmost.test.js: the handler is plain JavaScript and
 * only the JSX around it is what node cannot parse. It matters that this is run
 * rather than read, because what was wrong is not visible in the shape of the
 * source - the call was there, the try/catch was there, and the one missing
 * `await` is what decided whether the catch ever saw anything.
 */
const togglePauseWith = (closure) => {
    const start = dropdownSource.indexOf("const togglePause");
    assert.notEqual(start, -1, "the menu no longer offers pause and resume");

    const body = dropdownSource.slice(dropdownSource.indexOf("{", dropdownSource.indexOf("=>", start)));
    const names = Object.keys(closure);

    return new Function(...names, `return async () => ${body.slice(0, blockEnd(body, 0) + 1)};`)(
        ...names.map((name) => closure[name]));
};

// The real one from RequestUtil: async, and rejecting is the whole of what it
// is for. A stub that threw synchronously would pass either spelling of the
// call and prove nothing.
const assertOk = async (response, path) => {
    if (response.ok) return response;

    const body = await response.json().catch(() => null);
    const error = new Error(body?.message ?? `Request to ${path} failed with status ${response.status}`);
    error.status = response.status;
    throw error;
};

/**
 * The menu with the resume request scripted to answer however the test wants.
 *
 * `events` records what the user would have seen: the request going out, a
 * toast, and the status refresh that redraws the menu entry.
 */
const menu = ({paused = true, response} = {}) => {
    const events = [];

    const togglePause = togglePauseWith({
        status: {paused},
        setShowPauseDialog: () => events.push({type: "pauseDialog"}),
        assertOk,
        postRequest: async (path) => {
            events.push({type: "request", path});
            return response;
        },
        updateToast: (message, colour) => events.push({type: "toast", message, colour}),
        updateStatus: () => events.push({type: "updateStatus"}),
        t: (key) => key,
        faExclamationTriangle: "warning-icon"
    });

    return {togglePause, events};
};

const refusedWith = (status, message) => ({
    ok: false,
    status,
    json: async () => ({message})
});

const accepted = {ok: true, status: 200, json: async () => ({})};

/**
 * Resuming a paused instance reported success however it went.
 *
 * assertOk is async, and its result was not awaited - so the rejection it
 * raises for a refusal was never handed to the try/catch wrapping it. It
 * escaped as an unhandled rejection instead, no toast was shown, and
 * updateStatus() ran regardless: the menu redrew still offering "Resume tests",
 * with nothing anywhere saying the request had been refused.
 *
 * The comment above the call already says a refusal must be reported, which is
 * what makes this a slip rather than a decision: a 403 on the demo, a 401 on an
 * expired session and a 500 are all named there.
 */
describe("resuming when the server refuses", () => {
    for (const [status, message] of [[403, "Not available on a demo"], [401, "Session expired"], [500, null]]) {
        it(`reports a ${status} instead of reporting success`, async () => {
            const {togglePause, events} = menu({response: refusedWith(status, message)});

            await togglePause();

            const toast = events.find((event) => event.type === "toast");
            assert.ok(toast, `a ${status} was swallowed - the menu said nothing at all`);
            assert.equal(toast.colour, "red");
            if (message) assert.equal(toast.message, message, "the server's own reason was not shown");
        });
    }

    it("does not refresh the status as though the pause had lifted", async () => {
        const {togglePause, events} = menu({response: refusedWith(403, "Not available on a demo")});

        await togglePause();

        assert.equal(events.some((event) => event.type === "updateStatus"), false,
            "the menu redrew from a resume that never happened");
    });

    it("settles rather than leaving the rejection to escape", async () => {
        const {togglePause} = menu({response: refusedWith(500, null)});

        // Rejecting here is the failure the missing await produced: the promise
        // this hands back is not the one that carries the error.
        await assert.doesNotReject(() => togglePause());
    });
});

// The path that always worked, kept so the fix cannot be a blanket catch.
describe("resuming when the server accepts", () => {
    it("refreshes the status and says nothing", async () => {
        const {togglePause, events} = menu({response: accepted});

        await togglePause();

        assert.deepEqual(events.map((event) => event.type), ["request", "updateStatus"]);
    });

    it("sends the resume to the endpoint that lifts the pause", async () => {
        const {togglePause, events} = menu({response: accepted});

        await togglePause();

        assert.equal(events.find((event) => event.type === "request").path, "/speedtests/continue");
    });
});

describe("pausing", () => {
    it("opens the confirmation instead of requesting anything", async () => {
        const {togglePause, events} = menu({paused: false});

        await togglePause();

        assert.deepEqual(events.map((event) => event.type), ["pauseDialog"]);
    });
});
