import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readSource } from "../helpers/source.js";
import { welcomeOpens } from "@/common/contexts/Targets/welcomeOutcome.js";
import { optimalOrNull, targetBody } from "@/common/components/TargetsDialog/targetBody.js";

/**
 * The two decisions the target rework put in front of an operator: whether the
 * setup wizard opens itself, and what the editor writes when it is saved.
 *
 * Both are pure modules for the same reason configOutcome and frequencyStateFrom
 * are - the suite cannot compile JSX, and what went wrong historically in each
 * of them was the decision rather than the rendering.
 */

const LOADED = {ping: "25"};

describe("when the setup wizard opens itself", () => {
    it("stays shut until the config has arrived", () => {
        // Otherwise it flashes over an instance that turns out to be
        // perfectly configured, on every load.
        assert.equal(welcomeOpens({config: {}, firstRun: true, alreadyShown: null}), false);
        assert.equal(welcomeOpens({config: undefined, firstRun: true, alreadyShown: null}), false);
    });

    it("stays shut until the target list has arrived", () => {
        assert.equal(welcomeOpens({config: LOADED, firstRun: null, alreadyShown: null}), false,
            "a list still in flight is not an instance with nothing to measure");
    });

    it("opens on an instance that has never had a target", () => {
        assert.equal(welcomeOpens({config: LOADED, firstRun: true, alreadyShown: null}), true);
    });

    it("leaves a configured instance alone", () => {
        assert.equal(welcomeOpens({config: LOADED, firstRun: false, alreadyShown: null}), false);
    });

    /**
     * The wizard is the one modal in the app that cannot be dismissed, so
     * every state that raises it must be one whose only way out is finishing
     * it. An empty list is not that state: an operator replacing their only
     * target by the obvious route - delete, then add - emptied the list
     * mid-workflow and was locked into a setup wizard over the manager they
     * were working in, which then left behind a provider-named target they had
     * to delete, emptying the list and raising it again.
     *
     * The provider decides that; what is pinned here is that this function
     * asks about a first run and not about emptiness.
     */
    it("asks whether this is a first run, not whether the list is empty", () => {
        const outcome = readSource("client/src/common/contexts/Targets/welcomeOutcome.js");

        assert.match(outcome, /return firstRun === true;/,
            "the wizard opens on an empty list again, so deleting the last target traps the operator");
        // The decision is handed an answer rather than the list: given the
        // list it could only ask about emptiness, which is the fault above.
        assert.doesNotMatch(outcome, /targets\.length/,
            "the decision measures the list itself again");
    });

    /**
     * The demo, whose wizard is a tour rather than a setup: shown once per
     * browser and remembered. It has targets of its own, so the first-run rule
     * would never show it - and it is the deployment whose address exists to
     * be handed to strangers.
     */
    it("shows a demo its tour once per browser", () => {
        assert.equal(welcomeOpens({config: {...LOADED, previewMode: true},
            firstRun: false, alreadyShown: null}), true);
        assert.equal(welcomeOpens({config: {...LOADED, previewMode: true},
            firstRun: false, alreadyShown: "true"}), false);
    });

    /**
     * And never to a read-only visitor. They cannot create a target, so the
     * wizard's last step is refused - which is the shape of the bug that once
     * left every demo visitor behind a box they could not close.
     */
    it("never walks a read-only visitor into a setup they cannot finish", () => {
        assert.equal(welcomeOpens({config: {...LOADED, viewMode: true},
            firstRun: true, alreadyShown: null}), false);
    });

    // previewMode is answered before viewMode: a demo marks its visitors
    // read-only too, and the tour is still worth showing them.
    it("still shows the tour on a demo a visitor is reading", () => {
        assert.equal(welcomeOpens({config: {...LOADED, previewMode: true, viewMode: true},
            firstRun: false, alreadyShown: null}), true);
    });
});

/**
 * The other half of that rule, which lives in the provider: what it hands to
 * welcomeOpens as `firstRun`, and the failure it must not report as emptiness.
 */
describe("what the provider calls a first run", () => {
    const context = readSource("client/src/common/contexts/Targets/TargetsContext.jsx");

    it("is an empty list on an instance that has never had a target", () => {
        assert.match(context, /firstRun: targets === null \? null : targets\.length === 0 && !everHadTargets\.current/,
            "the provider raises the wizard whenever the list is empty, whatever emptied it");
    });

    /**
     * A request that failed is not an instance with nothing to measure.
     * jsonRequest throws for a 500, for the 503 a proxy answers in front of a
     * restarting container and for its own 10s timeout alike - and recording
     * any of those as an empty list raised a modal that cannot be dismissed
     * over an instance that was working a moment earlier.
     */
    it("does not turn a failed fetch into an empty list", () => {
        const failure = context.slice(context.indexOf("} catch {"), context.indexOf("}, []);"));

        assert.doesNotMatch(failure, /setTargets\(/,
            "a failed /targets fetch invents a state the server never reported");
    });

    // Another node's answer must not label this node's rows: ids are
    // per-instance, so a late reply does not merely lag - it renames things.
    it("drops an answer for a node the viewer has left", () => {
        assert.match(context, /const generation = \+\+requestGeneration\.current/);
        assert.match(context, /if \(superseded\(\)\) return/);
    });

    /**
     * And re-reads the list when the session's permission changes. A read-only
     * visitor is served rows with no serverId, endpoint or alerts flag, and
     * the header's admin login is the one login that does not reload the page
     * - so without this the editor seeded from the redacted row and saving it
     * wrote that redaction back over the stored target.
     */
    it("re-reads the list when the session stops being read-only", () => {
        assert.match(context, /reloadOnPermissionChange\(\s*fetchedUnderRef\.current, config\.viewMode, reloadTargets\)/,
            "the redacted rows stay in hand after signing in, and the editor writes them back");
    });
});

describe("what the target editor writes", () => {
    const FIELDS = {
        name: "Frankfurt", provider: "ookla", serverId: "none", endpoint: "none",
        alerts: true, ownOptimals: false, optimalPing: "", optimalDownload: "", optimalUpload: ""
    };

    it("sends an unset server as no server rather than as the sentinel", () => {
        // "none" is the select's own word for "let the provider choose"; sent
        // as a server id the server refuses it, naming a value the operator
        // cannot see in any field.
        assert.equal(targetBody(FIELDS).serverId, null);
        assert.equal(targetBody({...FIELDS, serverId: ""}).serverId, null);
        assert.equal(targetBody({...FIELDS, serverId: "1234"}).serverId, "1234");
    });

    it("trims the name, so a name of spaces is not a name", () => {
        assert.equal(targetBody({...FIELDS, name: "  Frankfurt  "}).name, "Frankfurt");
        assert.equal(targetBody({...FIELDS, name: "   "}).name, "");
    });

    /**
     * Only LibreSpeed takes an endpoint. The server judges the row the PATCH
     * would produce, so an endpoint left behind by a provider switch is
     * refused - which is a save the operator cannot explain, since the field
     * it names is no longer on screen.
     */
    it("keeps the endpoint to the provider that takes one", () => {
        assert.equal(targetBody({...FIELDS, provider: "libre",
            endpoint: "https://speed.example.net"}).endpoint, "https://speed.example.net");
        assert.equal(targetBody({...FIELDS, provider: "ookla",
            endpoint: "https://speed.example.net"}).endpoint, null,
            "a stale endpoint followed a provider switch into a provider that takes none");
        assert.equal(targetBody({...FIELDS, provider: "cloudflare",
            endpoint: "https://speed.example.net"}).endpoint, null);
        assert.equal(targetBody({...FIELDS, provider: "libre"}).endpoint, null);
    });

    it("passes the alerts flag through as it stands", () => {
        assert.equal(targetBody(FIELDS).alerts, true);
        assert.equal(targetBody({...FIELDS, alerts: false}).alerts, false);
    });
});

/**
 * The inherit semantics, which are per metric: null means "use the
 * instance-wide setting for this one figure", and resolveLimits falls back
 * that way - so a target can pin its download and leave its ping global.
 */
describe("a target's own optimal values", () => {
    it("inherits everything while the toggle is off", () => {
        assert.equal(optimalOrNull(false, "500"), null,
            "a value left behind by a toggle switched off was still written");
    });

    it("inherits the metrics left blank", () => {
        assert.equal(optimalOrNull(true, ""), null);
        assert.equal(optimalOrNull(true, null), null);
        assert.equal(optimalOrNull(true, undefined), null);
    });

    it("sends what was typed, as a number", () => {
        assert.equal(optimalOrNull(true, "500"), 500);
        assert.equal(optimalOrNull(true, "0.4"), 0.4,
            "the recommended ping on a fast line is fractional");
        assert.equal(optimalOrNull(true, 500), 500);
    });

    // A number input hands back "" for anything it cannot parse, so this is
    // the belt rather than the braces - but Number("abc") is NaN, and NaN
    // reaching the column is a threshold no measurement is ever under.
    it("inherits rather than storing something that is not a number", () => {
        assert.equal(optimalOrNull(true, "abc"), null);
        assert.equal(optimalOrNull(true, "1.2.3"), null);
    });

    it("mixes pinned and inherited metrics in one row", () => {
        const body = targetBody({name: "x", provider: "ookla", serverId: "none", endpoint: "none",
            alerts: true, ownOptimals: true,
            optimalPing: "", optimalDownload: "500", optimalUpload: ""});

        assert.deepEqual([body.optimalPing, body.optimalDownload, body.optimalUpload],
            [null, 500, null]);
    });
});

/**
 * And the dialog uses them, rather than keeping a second copy that drifts.
 */
describe("the editor and the wizard read those decisions", () => {
    it("the editor builds its body through targetBody", () => {
        const editor = readSource("client/src/common/components/TargetsDialog/TargetEditor.jsx");

        assert.match(editor, /const body = targetBody\(/,
            "the editor builds its own body again, so the rules above hold nothing");
    });

    it("the provider decides whether the wizard opens through welcomeOpens", () => {
        const context = readSource("client/src/common/contexts/Targets/TargetsContext.jsx");

        assert.match(context, /if \(welcomeOpens\(\{/,
            "the open rule was inlined back into the effect");
    });
});
