import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readSource } from "../helpers/source.js";
import { welcomeOpens } from "@/common/contexts/Targets/welcomeOutcome.js";
import { optimalOrNull, targetBody } from "@/common/components/TargetsDialog/targetBody.js";
import {
    requiresEndpoint, takesEndpoint, takesServerId
} from "@/common/components/TargetsDialog/providerFields.js";

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
        assert.doesNotMatch(outcome, /\btargets\.length\b/,
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

/**
 * The fields a provider is offered, which have to be the fields the server
 * will accept: one drawn for a provider that refuses it is a save that fails
 * naming a value the operator can see on screen, and one left out is a target
 * that cannot be finished.
 */
describe("what each provider lets a target say", () => {
    it("offers a server to pin only where there is a list to pin from", () => {
        assert.equal(takesServerId("ookla"), true);
        assert.equal(takesServerId("libre"), true);
        // One endpoint, so nothing to choose between.
        assert.equal(takesServerId("cloudflare"), false);
        // Named on the target itself - an iperf3 server is the operator's own.
        assert.equal(takesServerId("iperf3"), false);
    });

    it("offers an address of its own to the two that take one", () => {
        assert.equal(takesEndpoint("libre"), true);
        assert.equal(takesEndpoint("iperf3"), true);
        assert.equal(takesEndpoint("ookla"), false);
        assert.equal(takesEndpoint("cloudflare"), false);
    });

    // A libre target with no endpoint measures against the public backend
    // list; an iperf3 target with no host has nothing to measure at all.
    it("insists on one only where there is no fallback", () => {
        assert.equal(requiresEndpoint("iperf3"), true);
        assert.equal(requiresEndpoint("libre"), false);
    });
});

describe("what the editor writes for an iperf3 target", () => {
    const IPERF = {
        name: "NAS", provider: "iperf3", serverId: "none", endpoint: "10.0.0.5:5201",
        alerts: true, ownOptimals: false, optimalPing: "", optimalDownload: "", optimalUpload: ""
    };

    it("sends the host it was given", () => {
        assert.equal(targetBody(IPERF).endpoint, "10.0.0.5:5201");
    });

    it("trims it, so a pasted address with a space is not refused", () => {
        assert.equal(targetBody({...IPERF, endpoint: "  10.0.0.5:5201  "}).endpoint, "10.0.0.5:5201");
    });

    /**
     * A server id left behind by a provider switch must not travel: the server
     * judges the row the write would produce, and an id on a provider that
     * pins none is refused - naming a field the editor no longer draws.
     */
    it("drops a server id the provider cannot take", () => {
        assert.equal(targetBody({...IPERF, serverId: "1234"}).serverId, null);
        assert.equal(targetBody({...IPERF, provider: "cloudflare", serverId: "1234"}).serverId, null);
        assert.equal(targetBody({...IPERF, provider: "ookla", serverId: "1234"}).serverId, "1234");
    });

    // And the same in the other direction, which is the case that already
    // existed: an address left behind by a switch to a provider that takes none.
    it("drops an address the provider cannot take", () => {
        assert.equal(targetBody({...IPERF, provider: "ookla"}).endpoint, null);
    });
});

/**
 * And the editor will not offer to save a target the server is bound to
 * refuse - the operator meets the rule in a button that does not press, rather
 * than in a red toast after the fact.
 */
describe("the editor's own guard", () => {
    const editor = readSource("client/src/common/components/TargetsDialog/TargetEditor.jsx");

    it("holds back a save for a provider that needs a host and has none", () => {
        assert.match(editor, /const hasEndpoint = !requiresEndpoint\(provider\)/);
        assert.match(editor, /const canSave = name\.trim\(\) !== "" && hasEndpoint/);
    });

    /**
     * And holds the host to the server's shape rule, not just to being there.
     * The sentinel has to be tested first, because "none" - the editor's
     * spelling of "no endpoint chosen" - is a perfectly well-formed hostname
     * to the shape rule, and asking the rule first would read the sentinel as
     * a saveable host.
     */
    it("judges the host the way the server will", () => {
        assert.match(editor, /iperfHostAccepted\(endpoint\)/);
        assert.match(editor, /endpoint !== "none" && iperfHostAccepted\(endpoint\)/);
    });

    it("draws the server pickers only where they mean something", () => {
        assert.equal((editor.match(/takesServerId\(provider\) && !isUsingCustomUrl/g) ?? []).length, 2,
            "the server select and the free-text id no longer agree about who has a list");
    });
});

/**
 * The interface select shows the stored choice even when the list cannot.
 *
 * The select is controlled on config.interface, and its options are only what
 * GET /info/interfaces answered - so a stored "none" (a boot that found no
 * usable adapter), a renamed adapter, or a failed fetch left a controlled
 * value with no matching option, which paints blank: "no interface
 * configured" on screen while one is very much configured, and any
 * exploratory pick PATCHes instantly. The fallback option wears the raw
 * stored value, disabled because it is a fact rather than a choice.
 */
describe("the interface select", () => {
    const dialog = readSource("client/src/common/components/TargetsDialog/TargetsDialog.jsx");

    it("keeps the stored choice visible when the list does not carry it", () => {
        assert.match(dialog, /!Object\.hasOwn\(interfaces \?\? \{}, selectedInterface\)/,
            "a stored interface the list lacks paints the select blank");
        assert.match(dialog, /<option value=\{selectedInterface} disabled>/,
            "the fallback option is missing, or silently re-pickable");
    });
});
