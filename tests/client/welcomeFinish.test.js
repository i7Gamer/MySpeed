import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readSource } from "../helpers/source.js";

const welcomeSource = readSource("client/src/common/components/WelcomeDialog/WelcomeDialog.jsx");

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
 * The wizard's last step, taken out of the component file and run.
 *
 * Same extraction as alertEnterFocus.test.js, and for the same reason: what was
 * wrong is what this function does with one config, and that is only observable
 * by handing it one. Only the JSX around it is what node cannot parse.
 */
const finishWith = (closure) => {
    const start = welcomeSource.indexOf("const finish = async");
    assert.notEqual(start, -1, "the wizard no longer has a finish step");

    const body = welcomeSource.slice(welcomeSource.indexOf("{", welcomeSource.indexOf("=>", start)));
    const names = Object.keys(closure);

    return new Function(...names, `return async (close) => ${body.slice(0, blockEnd(body, 0) + 1)};`)(
        ...names.map((name) => closure[name]));
};

class StubRequestError extends Error {
    constructor(status, message) {
        super(message);
        this.status = status;
    }
}

/**
 * A wizard on its last step, with the writes and the outcome recorded.
 *
 * `refuse` is the set of paths the server turns down, which is how a preview
 * instance answers every one of them: previewReadOnly sits on PATCH
 * /api/config/:key and refuses it 403 whoever is asking.
 */
const runFinish = async ({previewMode = false, refuse = []} = {}) => {
    const patched = [];
    const stored = new Map();
    const toasts = [];
    const closed = [];
    const reloaded = [];

    const finish = finishWith({
        config: {previewMode, ping: "0", download: "0", upload: "0"},
        provider: "ookla",
        ping: 50,
        download: 100,
        upload: 40,
        patchRequest: async (path, body) => {
            patched.push({path, value: body.value});
            return {ok: !refuse.includes(path), status: refuse.includes(path) ? 403 : 200};
        },
        assertOk: async (response, path) => {
            if (response.ok) return response;
            throw new StubRequestError(response.status,
                "You can't change anything on this instance in preview mode");
        },
        RequestError: StubRequestError,
        localStorage: {
            setItem: (key, value) => stored.set(key, value),
            getItem: (key) => stored.has(key) ? stored.get(key) : null
        },
        updateToast: (message, colour) => toasts.push({message, colour}),
        faExclamationTriangle: "icon",
        t: (key) => key,
        reloadConfig: () => reloaded.push(true)
    });

    await finish(() => closed.push(true));

    return {patched, stored, toasts, closed: closed.length > 0, reloaded: reloaded.length > 0};
};

/**
 * A demo has no configuration to write and refuses every attempt to write one.
 *
 * The provider PATCH sat above the preview branch rather than inside it, so it
 * ran first and was refused 403 - which throws, toasts, and returns before
 * close(). The wizard has no other way out: it is opened by ConfigContext
 * whenever previewMode is set and welcomeShown is absent, and welcomeShown is
 * written on the line the throw skipped. So every visitor to a public demo met
 * an unclosable box over the whole dashboard, on every load, in every browser -
 * the one deployment whose address exists to be handed to strangers.
 */
describe("finishing the wizard on a preview instance", () => {
    it("writes nothing at all", async () => {
        const {patched} = await runFinish({previewMode: true, refuse: ["/config/provider"]});

        assert.deepEqual(patched, [],
            "the wizard tried to configure an instance that refuses every write");
    });

    it("closes instead of trapping the visitor behind it", async () => {
        const {closed, toasts} = await runFinish({previewMode: true, refuse: ["/config/provider"]});

        assert.equal(closed, true, "the demo's welcome dialog cannot be dismissed");
        assert.deepEqual(toasts, [], "the visitor was shown an error they cannot act on");
    });

    it("remembers that it has been shown, so a reload does not reopen it", async () => {
        const {stored} = await runFinish({previewMode: true, refuse: ["/config/provider"]});

        assert.equal(stored.get("welcomeShown"), "true");
    });
});

/**
 * The ordinary install is untouched: all four values are still written, and a
 * genuine refusal still holds the wizard open rather than closing over a setup
 * that did not stick.
 */
describe("finishing the wizard on an ordinary instance", () => {
    it("writes the provider and all three targets", async () => {
        const {patched, closed, reloaded} = await runFinish();

        assert.deepEqual(patched, [
            {path: "/config/provider", value: "ookla"},
            {path: "/config/ping", value: 50},
            {path: "/config/download", value: 100},
            {path: "/config/upload", value: 40}
        ]);
        assert.equal(reloaded, true);
        assert.equal(closed, true);
    });

    it("stays open and says so when a write is refused", async () => {
        const {toasts, closed} = await runFinish({refuse: ["/config/download"]});

        assert.equal(closed, false, "the wizard closed over a setup that was not saved");
        assert.equal(toasts.length, 1);
        assert.equal(toasts[0].colour, "red");
    });
});
