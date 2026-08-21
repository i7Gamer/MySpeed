import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
    carriesWindow, windowProblem, writeQuietHours
} from "@/common/components/PauseDialog/quietHoursWindow.js";
import { blockEnd, readSource } from "../helpers/source.js";

const source = readSource("client/src/common/components/PauseDialog/PauseDialog.jsx");

const bodyOfArrowAt = (text, start) =>
    text.slice(text.indexOf("{", text.indexOf("=>", start)));

const saveIn = (closure) => {
    const start = source.indexOf("const saveQuietHours");
    assert.notEqual(start, -1, "the dialog no longer has a quiet hours save");

    const body = bodyOfArrowAt(source, start);
    const names = Object.keys(closure);

    return new Function(...names,
        `return async () => ${body.slice(0, blockEnd(body, 0) + 1)};`)(
        ...names.map((name) => closure[name]));
};

class RequestError extends Error {}

/**
 * The pair the dialog was opened over, and the mixed pair the server is left
 * holding when the second write and the undo are both refused - a new start
 * against the old end. They share an end on purpose: that is what the mixed
 * pair looks like, and the starts differ, so fields re-seeded from the wrong
 * side cannot pass for the right one.
 */
const CONTEXT = {quietHoursStart: "23:00", quietHoursEnd: "08:00"};
const SERVER_HOLDS = {quietHoursStart: "22:00", quietHoursEnd: "08:00"};

const FIRST_PATCH = 1;
const SECOND_PATCH = 2;

/**
 * The save wired up over recorders. `refuse` is handed the ordinal of each
 * PATCH; `reread` (or a whole `checkConfig`) is what the failure-path re-read
 * finds on the server.
 */
const dialogSaving = ({quietStart, quietEnd, refuse = () => false, reread = SERVER_HOLDS, checkConfig}) => {
    const seen = {patches: [], toasts: [], shown: [], reloads: 0, saving: []};

    const save = saveIn({
        quietProblem: windowProblem(quietStart, quietEnd),
        quietStart, quietEnd,
        config: CONTEXT,
        writeQuietHours, carriesWindow, RequestError,
        setSavingQuiet: (value) => seen.saving.push(value),
        patchRequest: async (url, {value}) => {
            seen.patches.push({url, value});
            return {ok: !refuse(seen.patches.length)};
        },
        assertOk: async (response, what) => {
            if (response.ok) return response;
            throw new RequestError(`${what} was refused`);
        },
        updateToast: (message, color) => seen.toasts.push(color),
        t: (key) => key,
        faMoon: {}, faExclamationTriangle: {},
        checkConfig: checkConfig ?? (async () => reread),
        showStoredWindow: (stored) => seen.shown.push(stored),
        reloadConfig: () => seen.reloads++
    });

    return {save, seen};
};

describe("the quiet hours save", () => {
    it("writes both ends through checked PATCHes and reports the save", async () => {
        const {save, seen} = dialogSaving({quietStart: "22:00", quietEnd: "07:00"});

        await save();

        assert.deepEqual(seen.patches, [
            {url: "/config/quietHoursStart", value: "22:00"},
            {url: "/config/quietHoursEnd", value: "07:00"}
        ]);
        assert.deepEqual(seen.toasts, ["green"]);
        assert.deepEqual(seen.shown, [], "a save that succeeded has nothing to correct on screen");
        assert.equal(seen.reloads, 1, "the other readers of these keys never heard about the save");
        assert.deepEqual(seen.saving, [true, false]);
    });

    /**
     * The session expires between the first write and the second, which refuses
     * the undo as well: the server is left holding the mixed pair. The fields
     * have to be re-seeded from the re-read - not from the context the dialog
     * was opened over, which still carries the pair from before the edit.
     */
    it("shows the pair the server actually holds when a write is refused", async () => {
        const {save, seen} = dialogSaving({
            quietStart: "22:00", quietEnd: "07:00",
            refuse: (patch) => patch !== FIRST_PATCH,
            reread: SERVER_HOLDS
        });

        await save();

        // Three PATCHes, not two: the refused second write sends the save back
        // through the helper's undo rather than out of a bare loop.
        assert.deepEqual(seen.patches, [
            {url: "/config/quietHoursStart", value: "22:00"},
            {url: "/config/quietHoursEnd", value: "07:00"},
            {url: "/config/quietHoursStart", value: CONTEXT.quietHoursStart}
        ]);
        assert.deepEqual(seen.toasts, ["red"]);
        assert.deepEqual(seen.shown, [SERVER_HOLDS],
            "the fields go on showing the window that was asked for, not the stored one");
        assert.equal(seen.reloads, 1, "a partial save does not resync the config");
        assert.deepEqual(seen.saving, [true, false]);
    });

    // checkConfig hands back the parsed body whatever the status was, so an
    // expired session arrives looking like a config with no keys in it.
    it("does not read a window out of a refusal", async () => {
        const {save, seen} = dialogSaving({
            quietStart: "22:00", quietEnd: "07:00",
            refuse: (patch) => patch >= SECOND_PATCH,
            reread: {message: "Unauthorized"}
        });

        await save();

        assert.deepEqual(seen.shown, [],
            "a refused re-read blanks the fields, calling the window off when it may not be");
        assert.equal(seen.reloads, 1);
    });

    // Whatever refused the write is quite capable of refusing the re-read too,
    // and a save must not turn that into an unhandled rejection.
    it("survives the re-read failing outright", async () => {
        const {save, seen} = dialogSaving({
            quietStart: "22:00", quietEnd: "07:00",
            refuse: (patch) => patch >= SECOND_PATCH,
            checkConfig: async () => {
                throw new Error("network gone");
            }
        });

        await save();

        assert.deepEqual(seen.shown, []);
        assert.deepEqual(seen.toasts, ["red"]);
        assert.equal(seen.reloads, 1);
    });

    // The save button is disabled while the window has a problem, but the guard
    // in the save is the backstop: half a window must never reach the server.
    it("writes nothing while the window is incomplete", async () => {
        const {save, seen} = dialogSaving({quietStart: "22:00", quietEnd: ""});

        await save();

        assert.deepEqual(seen.patches, []);
        assert.equal(seen.reloads, 0);
    });
});
