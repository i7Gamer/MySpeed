import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { blockEnd, readSource } from "../helpers/source.js";

const welcomeSource = readSource("client/src/common/components/WelcomeDialog/WelcomeDialog.jsx");

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
const runFinish = async ({previewMode = false, refuse = [], provider = "ookla",
                             endpoint = ""} = {}) => {
    const patched = [];
    const created = [];
    const stored = new Map();
    const toasts = [];
    const closed = [];
    const reloaded = [];
    const targetsReloaded = [];

    const finish = finishWith({
        config: {previewMode, ping: "0", download: "0", upload: "0"},
        provider,
        endpoint,
        // The wizard's own copy of the rule the server enforces, so a provider
        // that cannot measure without an address is created carrying one.
        requiresEndpoint: (current) => current === "iperf3",
        ping: 50,
        download: 100,
        upload: 40,
        patchRequest: async (path, body) => {
            patched.push({path, value: body.value});
            return {ok: !refuse.includes(path), status: refuse.includes(path) ? 403 : 200};
        },
        // The provider write became the creation of the instance's first
        // target - a PUT to a list, not a PATCH to a config key.
        putRequest: async (path, body) => {
            created.push({path, body});
            return {ok: !refuse.includes(path), status: refuse.includes(path) ? 403 : 200};
        },
        providerById: (id) => ({ookla: {id: "ookla", name: "Ookla"},
            iperf3: {id: "iperf3", name: "iperf3"}})[id] ?? null,
        assertOk: async (response, _path) => {
            if (response.ok) return response;
            throw new StubRequestError(response.status,
                "You can't change anything on this instance in preview mode");
        },
        RequestError: StubRequestError,
        // The guarded wrapper, not localStorage: a blocked or partitioned store
        // throws on the property access itself, and this runs on a demo, which
        // is the deployment most likely to be embedded in someone else's page.
        writeStored: (key, value) => stored.set(key, value),
        readStored: (key) => stored.has(key) ? stored.get(key) : null,
        updateToast: (message, colour) => toasts.push({message, colour}),
        faExclamationTriangle: "icon",
        t: (key) => key,
        reloadConfig: () => reloaded.push(true),
        reloadTargets: () => targetsReloaded.push(true)
    });

    await finish(() => closed.push(true));

    return {patched, created, stored, toasts, closed: closed.length > 0,
        reloaded: reloaded.length > 0, targetsReloaded: targetsReloaded.length > 0};
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
        const {patched, created} = await runFinish({previewMode: true, refuse: ["/targets"]});

        assert.deepEqual(patched, [],
            "the wizard tried to configure an instance that refuses every write");
        assert.deepEqual(created, [],
            "the wizard tried to create a target on an instance that refuses every write");
    });

    it("closes instead of trapping the visitor behind it", async () => {
        const {closed, toasts} = await runFinish({previewMode: true, refuse: ["/targets"]});

        assert.equal(closed, true, "the demo's welcome dialog cannot be dismissed");
        assert.deepEqual(toasts, [], "the visitor was shown an error they cannot act on");
    });

    it("remembers that it has been shown, so a reload does not reopen it", async () => {
        const {stored} = await runFinish({previewMode: true, refuse: ["/targets"]});

        assert.equal(stored.get("welcomeShown"), "true");
    });
});

/**
 * The ordinary install: the chosen provider becomes the instance's first
 * target, the three thresholds are still written, and a genuine refusal still
 * holds the wizard open rather than closing over a setup that did not stick.
 */
describe("finishing the wizard on an ordinary instance", () => {
    it("creates the first target and writes all three thresholds", async () => {
        const {patched, created, closed, reloaded, targetsReloaded} = await runFinish();

        assert.deepEqual(created, [
            {path: "/targets", body: {name: "Ookla", provider: "ookla"}}
        ]);
        assert.deepEqual(patched, [
            {path: "/config/ping", value: 50},
            {path: "/config/download", value: 100},
            {path: "/config/upload", value: 40}
        ]);
        assert.equal(reloaded, true);
        assert.equal(closed, true);
        assert.equal(targetsReloaded, true,
            "the wizard reopens on the next render: it is keyed on the list it never re-read");
    });

    // The refusal that used to trap every demo visitor, on a real instance:
    // a refused creation must not close the wizard over nothing.
    it("stays open when the target creation is refused", async () => {
        const {toasts, closed} = await runFinish({refuse: ["/targets"]});

        assert.equal(closed, false, "the wizard closed over a target that was not created");
        assert.equal(toasts.length, 1);
        assert.equal(toasts[0].colour, "red");
    });

    it("stays open and says so when a write is refused", async () => {
        const {toasts, closed} = await runFinish({refuse: ["/config/download"]});

        assert.equal(closed, false, "the wizard closed over a setup that was not saved");
        assert.equal(toasts.length, 1);
        assert.equal(toasts[0].colour, "red");
    });
});

/**
 * A provider that cannot measure without an address of its own.
 *
 * The wizard sent `{name, provider}` for all four cards alike, so the iperf3
 * one was refused by the server every time - on the one dialog nobody can
 * close and that has no way back to the step where the choice was made.
 */
describe("finishing the wizard on a provider that needs an address", () => {
    it("creates the target with the address that was typed", async () => {
        const {created} = await runFinish({provider: "iperf3", endpoint: " 10.0.0.5:5201 "});

        assert.deepEqual(created, [
            {path: "/targets", body: {name: "iperf3", provider: "iperf3",
                // Trimmed here rather than at the server, which judges the row
                // it would become: a padded host is a host it refuses.
                endpoint: "10.0.0.5:5201"}}
        ]);
    });

    /**
     * Only where the provider cannot do without one. A LibreSpeed target
     * measures against the public backend list until the manager gives it an
     * address, and an endpoint on a provider that takes none is exactly what
     * the server refuses - so a stale value left behind by switching cards
     * must not travel with the row.
     */
    it("sends no address for a provider that does not need one", async () => {
        const {created} = await runFinish({provider: "ookla", endpoint: "10.0.0.5:5201"});

        assert.deepEqual(created, [
            {path: "/targets", body: {name: "Ookla", provider: "ookla"}}
        ]);
    });
});
