import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { blockEnd, readSource } from "../helpers/source.js";

const source = readSource("client/src/common/contexts/Node/NodeContext.jsx");

/**
 * What makes the node list refetch itself.
 *
 * The list is loaded from an effect keyed on the config, and the config is a
 * fresh object every time it reloads - which the provider's own comment says
 * happens "from a dozen places". So every settings save, every password change,
 * every node edit refetched a list none of them had changed, and two of those
 * fetches could be in flight at once. That is the churn the generation guards
 * further up the file exist to survive: the newest answer decides which node
 * the whole app talks to, and a stale one landing last would move the session
 * to this instance and write that to localStorage.
 *
 * The guards stay - updateNodes is called directly from the dialogs too - but
 * the effect no longer manufactures the race. Only the two things it actually
 * reads re-run it.
 */
describe("the node list is refetched for what it reads, not for the whole config", () => {
    const effect = () => {
        const at = source.indexOf("updateNodes();");
        assert.notEqual(at, -1, "no effect loads the node list any more");

        const start = source.lastIndexOf("useEffect(() => {", at);
        assert.notEqual(start, -1, "the node list is no longer loaded from an effect");

        const body = source.slice(source.indexOf("{", source.indexOf("=>", start)));

        return body.slice(0, blockEnd(body, 0) + 1);
    };

    const dependencies = () => {
        const from = source.indexOf(effect()) + effect().length;

        return source.slice(source.indexOf("[", from), source.indexOf("]", from) + 1);
    };

    it("does not re-run for a config that merely reloaded", () => {
        assert.doesNotMatch(dependencies(), /\bconfig\s*[,\]]/,
            "the whole config object is a new identity on every reload, so the node list is "
            + "refetched by every settings save - and two answers can then race each other");
    });

    it("re-runs when the permission changes, so signing in reveals the nodes", () => {
        assert.match(dependencies(), /config\.viewMode/);
    });

    /**
     * And on whether there is a config at all, which is a different question
     * from what it says - see the run below. Keyed separately because the two
     * answers are not derivable from one another.
     */
    it("re-runs when the config first arrives", () => {
        assert.match(dependencies(), /configLoaded/,
            "nothing re-runs the effect when the config lands, so the node list stays empty");
    });
});

/**
 * The decision itself, which the narrowing above must not quietly change.
 *
 * Run rather than read: the interesting case is a config that has arrived and
 * says nothing about the permission, and no assertion about the shape of the
 * source can tell whether that fetches or not.
 */
describe("when the node list is fetched", () => {
    const run = (config) => {
        const at = source.indexOf("updateNodes();");
        const start = source.lastIndexOf("useEffect(() => {", at);
        const body = source.slice(source.indexOf("{", source.indexOf("=>", start)));
        const callback = body.slice(0, blockEnd(body, 0) + 1);

        const loaded = Object.keys(config).length > 0;
        let fetched = 0;

        new Function("configLoaded", "config", "updateNodes",
            `return () => ${callback};`)(loaded, config, () => fetched++)();

        return fetched;
    };

    it("waits for the config rather than fetching against an empty one", () => {
        assert.equal(run({}), 0);
    });

    it("fetches once the config says the session is not read-only", () => {
        assert.equal(run({viewMode: false}), 1);
    });

    // The nodes route answers a read-only reader with an empty list, so asking
    // costs a request to be told nothing.
    it("does not fetch for a read-only session", () => {
        assert.equal(run({viewMode: true}), 0);
    });

    /**
     * A config that arrived without a permission in it still fetches.
     *
     * `config` here is whichever instance the app is pointed at, and a node
     * running a version from before the flag existed answers without it. The
     * guard this replaced asked whether the config was empty, so that node's
     * list was fetched; reading the absent flag as "not yet loaded" instead
     * would leave the node list permanently empty against it, which is a
     * regression no assertion about the dependency array would catch.
     */
    it("fetches for a config that names no permission at all", () => {
        assert.equal(run({dashboardTitle: "an older node"}), 1);
    });
});
