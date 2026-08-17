import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readSource } from "../helpers/source.js";

const createDialogSource = readSource(
    "client/src/pages/Nodes/components/CreateNodeDialog/CreateNodeDialog.jsx");
const nodeContainerSource = readSource(
    "client/src/pages/Nodes/components/NodeContainer/NodeContainer.jsx");

// The index of the } that closes the block opened at `from`.
const blockEnd = (source, from) => {
    let depth = 0;

    for (let index = from; index < source.length; index++) {
        if (source[index] === "{") depth++;
        else if (source[index] === "}" && --depth === 0) return index;
    }

    assert.fail("a block is never closed");
};

/**
 * The `authenticate` half of a password prompt, taken out of its component and
 * run.
 *
 * promptUntilAccepted awaits this and catches nothing, and both prompts are
 * started from a bare call - `runPasswordProcess()` and `updatePassword()`,
 * neither awaited nor caught. So whatever this rejects with becomes an
 * unhandled rejection and the prompt simply disappears: no toast, no retry, no
 * word to the operator about a node that is now half-configured.
 *
 * The only thing that can reject is the pair on the first line, and both halves
 * can: baseRequest rejects on a dropped connection and on its own ten second
 * abort, and .json() rejects on any body that is not JSON - a reverse proxy's
 * HTML error page being the ordinary one.
 */
const attemptWith = (source, marker, closure) => {
    const start = source.indexOf(marker);
    assert.notEqual(start, -1, `"${marker}" is no longer in this component`);

    const body = source.slice(source.indexOf("{", source.indexOf("=>", start)));
    const names = Object.keys(closure);

    return new Function(...names, `return async (password) => ${body.slice(0, blockEnd(body, 0) + 1)};`)(
        ...names.map((name) => closure[name]));
};

/**
 * A response whose body cannot be read, which is what a stalled or
 * proxy-intercepted request actually produces.
 */
const unreadable = () => ({
    ok: false,
    status: 502,
    json: async () => { throw new SyntaxError("Unexpected token '<'"); }
});

const rejects = () => { throw new TypeError("Failed to fetch"); };

describe("the create-node password prompt", () => {
    const run = ({respond}) => {
        const toasts = [];
        const created = [];

        const attempt = attemptWith(createDialogSource, "async (password) => {", {
            baseRequest: async (...args) => respond(...args),
            serverName: "child",
            serverUrl: "http://192.168.1.50:5216",
            describeNodeOutcome: (body) => ({kind: body?.type, message: body?.message}),
            OUTCOME_CREATED: "NODE_CREATED",
            OUTCOME_PASSWORD: "PASSWORD_REQUIRED",
            created: () => created.push(true),
            updateToast: (message, colour) => toasts.push({message, colour}),
            faExclamationTriangle: "icon",
            t: (key) => key
        });

        return {attempt, toasts, created};
    };

    it("ends the loop with a reason when the body cannot be read", async () => {
        const {attempt, toasts} = run({respond: unreadable});

        const outcome = await attempt("hunter2");

        assert.equal(outcome.ok, true, "the prompt kept asking for a password that was never the problem");
        assert.equal(toasts.length, 1, "the prompt vanished with nothing said");
        assert.equal(toasts[0].colour, "red");
    });

    it("ends the loop with a reason when the request never arrives", async () => {
        const {attempt, toasts} = run({respond: rejects});

        const outcome = await attempt("hunter2");

        assert.equal(outcome.ok, true);
        assert.equal(toasts.length, 1);
    });

    // The working paths are untouched: a wrong password still re-asks, and a
    // created node still reports itself.
    it("still asks again when the node refuses the password", async () => {
        const {attempt, toasts} = run({
            respond: async () => ({ok: true, json: async () => ({type: "PASSWORD_REQUIRED"})})
        });

        assert.deepEqual(await attempt("wrong"), {ok: false});
        assert.deepEqual(toasts, []);
    });

    it("still reports a node it created", async () => {
        const {attempt, created} = run({
            respond: async () => ({ok: true, json: async () => ({type: "NODE_CREATED", id: 7})})
        });

        assert.deepEqual(await attempt("right"), {ok: true});
        assert.deepEqual(created, [true]);
    });
});

describe("the node card's password prompt", () => {
    const run = ({respond}) => {
        const toasts = [];
        const refreshed = [];

        const attempt = attemptWith(nodeContainerSource, "async (password) => {", {
            baseRequest: async (...args) => respond(...args),
            node: {id: 3},
            updateData: async () => refreshed.push(true),
            setNodeError: () => undefined,
            updateToast: (message, colour) => toasts.push({message, colour}),
            faExclamationTriangle: "icon",
            faKey: "icon",
            t: (key) => key
        });

        return {attempt, toasts, refreshed};
    };

    it("ends the loop with a reason when the body cannot be read", async () => {
        const {attempt, toasts} = run({respond: unreadable});

        const outcome = await attempt("hunter2");

        assert.equal(outcome.ok, true, "the prompt kept asking for a password that was never the problem");
        assert.equal(toasts.length, 1, "the prompt vanished with nothing said");
        assert.equal(toasts[0].colour, "red");
    });

    it("ends the loop with a reason when the request never arrives", async () => {
        const {attempt, toasts} = run({respond: rejects});

        assert.equal((await attempt("hunter2")).ok, true);
        assert.equal(toasts.length, 1);
    });

    it("still asks again when the node refuses the password", async () => {
        const {attempt} = run({
            respond: async () => ({ok: true, json: async () => ({type: "PASSWORD_REQUIRED"})})
        });

        assert.deepEqual(await attempt("wrong"), {ok: false});
    });

    it("still accepts a password the node took", async () => {
        const {attempt, refreshed} = run({
            respond: async () => ({ok: true, json: async () => ({type: "PASSWORD_UPDATED"})})
        });

        assert.deepEqual(await attempt("right"), {ok: true});
        assert.deepEqual(refreshed, [true]);
    });
});

/**
 * The other silent exit on the same two prompts.
 *
 * promptUntilAccepted reads an empty answer as "the operator cancelled" and
 * returns, so Enter on an empty box ends the loop exactly as Escape does. The
 * admin login prompt marks its input required for that reason; these two did
 * not, so a stray Enter closed a node's password prompt with nothing said and
 * the card left in its error state.
 */
describe("both prompts refuse an empty answer", () => {
    const openInputCall = (source) => {
        const at = source.indexOf("alert.openInput");
        assert.notEqual(at, -1, "the prompt no longer asks for anything");
        return source.slice(at, source.indexOf("})", at));
    };

    it("is required in the create dialog", () => {
        assert.match(openInputCall(createDialogSource), /required:\s*true/);
    });

    it("is required on the node card", () => {
        assert.match(openInputCall(nodeContainerSource), /required:\s*true/);
    });
});
