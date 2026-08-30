import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { bodyOf, escapeRegExp, readSource } from "../helpers/source.js";

/**
 * A dialog's submit button stays pressable while its request is in flight.
 *
 * Every one of these handlers awaits a chain of PATCHes, and nothing disabled
 * the button or refused a second entry in the meantime - so a double-click, or
 * an impatient click on a slow connection, ran the chain twice interleaved.
 * The writes are individually idempotent, which is why this survived, but the
 * announcements are not: every configUpdated listener heard each change twice,
 * and two overlapping password saves exchanged two sessions where the operator
 * asked for one.
 *
 * The shape asserted here is the narrow one: a `saving` flag that turns the
 * handler into a no-op while a run is live, cleared in a `finally` so a refused
 * save does not wedge the dialog shut, and mirrored on the button so the state
 * is visible rather than merely enforced.
 */
const DIALOGS = [
    {
        what: "the optimal values dialog",
        file: "common/components/OptimalValuesDialog/OptimalValuesDialog.jsx",
        buttons: ['dialog.update']
    },
    {
        what: "the password dialog",
        file: "common/components/PasswordDialog/PasswordDialog.jsx",
        buttons: ['dialog.update', 'update.remove_password']
    },
    {
        // The provider dialog's successor: same chain of writes, same lock.
        // Its one button carries two labels - "update" over a row, "add" over
        // a blank - so the shared per-key scan below cannot name it; its own
        // assertion follows the loop.
        what: "the target editor",
        file: "common/components/TargetsDialog/TargetEditor.jsx",
        buttons: []
    },
    {
        // The wizard's one button carries t("dialog.continue") or
        // t("dialog.done") depending on the step, so the shared per-key scan
        // is skipped and the bespoke case below finds it by its handler. The
        // second press used to run finish() twice: two PUT /targets, two
        // identical targets, and every scheduled round measuring the same
        // provider twice.
        what: "the welcome wizard",
        file: "common/components/WelcomeDialog/WelcomeDialog.jsx",
        buttons: []
    },
    {
        // The integration card's save button is a bare icon, so the shared
        // per-key scan cannot name it; its own assertion follows the loop.
        // The double-click that matters is on an integration not yet saved:
        // both runs take the PUT branch, because the id that would send the
        // second down the PATCH path only arrives with the first response -
        // and the server files two integrations for one card.
        what: "the integration card",
        file: "common/components/IntegrationDialog/IntegrationDialog.jsx",
        buttons: []
    }
];

describe("a dialog cannot be submitted twice at once", () => {
    for (const {what, file, buttons} of DIALOGS) {
        const source = readSource(`client/src/${file}`);

        it(`${what} holds a saving flag`, () => {
            assert.match(source, /const \[saving, setSaving] = useState\(false\)/,
                `${what} tracks nothing about a request already running`);
        });

        it(`${what} refuses to start a second run`, () => {
            assert.match(source, /if \(saving\) return/,
                `${what}'s handler starts a second chain on a second click`);
        });

        it(`${what} clears the flag however the run ends`, () => {
            assert.match(source, /finally\s*\{[^}]*setSaving\(false\)/,
                `a refused save leaves ${what} locked shut`);
        });

        for (const key of buttons) {
            it(`${what}'s "${key}" button shows the lock`, () => {
                // From the opening tag to the translation key it carries,
                // spanning an icon in between but never a different button.
                const tag = source.match(
                    new RegExp(`<button(?:(?!<button)[^])*?\\{t\\("${escapeRegExp(key)}"\\)}`))?.[0];

                assert.ok(tag, `the "${key}" button in ${what} is no longer recognisable`);
                assert.match(tag, /disabled=\{[^}]*saving/,
                    `the "${key}" button stays pressable while the request runs`);
            });
        }
    }

    // The target editor's save button, recognised by its handler rather than
    // by a single label - see its DIALOGS entry.
    it(`the target editor's save button shows the lock`, () => {
        const source = readSource("client/src/common/components/TargetsDialog/TargetEditor.jsx");
        const tag = source.match(/<button(?:(?!<button)[^])*?save\(close\)(?:(?!<button)[^])*?>/)?.[0];

        assert.ok(tag, "the save button is no longer recognisable by its handler");
        assert.match(tag, /disabled=\{[^}]*saving/,
            "the save button stays pressable while the request runs");
    });

    // The integration card's save button, likewise found by its handler - see
    // its DIALOGS entry for why the label cannot be the anchor.
    it(`the integration card's save button shows the lock`, () => {
        const source = readSource("client/src/common/components/IntegrationDialog/IntegrationDialog.jsx");
        const tag = source.match(/<button(?:(?!<button)[^])*?handleSave\(\)(?:(?!<button)[^])*?>/)?.[0];

        assert.ok(tag, "the save button is no longer recognisable by its handler");
        assert.match(tag, /disabled=\{[^}]*saving/,
            "the save button stays pressable while the request runs");
    });

    // The wizard's continue button, likewise found by its handler - see its
    // DIALOGS entry for why the label cannot be the anchor.
    it(`the welcome wizard's continue button shows the lock`, () => {
        const source = readSource("client/src/common/components/WelcomeDialog/WelcomeDialog.jsx");
        const tag = source.match(/<button(?:(?!<button)[^])*?continueStep\(forceClose\)(?:(?!<button)[^])*?>/)?.[0];

        assert.ok(tag, "the continue button is no longer recognisable by its handler");
        assert.match(tag, /disabled=\{[^}]*saving/,
            "the continue button stays pressable while the four requests run");
    });
});

/**
 * The reorder chevrons, which are the same double-click with a worse ending.
 *
 * move() builds the id sequence from the `targets` context state and PATCHes
 * it, and the state only changes once reloadTargets settles - so two quick
 * clicks computed two swaps from the same pre-move list, and the later PATCH
 * won with an order the operator never asked for. The lock holds until the
 * reload lands, because the stale window is the reload, not the PATCH.
 */
describe("the reorder chevrons cannot race their own reload", () => {
    const source = readSource("client/src/common/components/TargetsDialog/TargetsDialog.jsx");

    it("holds a moving flag for the whole round trip", () => {
        assert.match(source, /const \[moving, setMoving] = useState\(false\)/,
            "nothing tracks a reorder already in flight");
        assert.match(source, /if \(moving\) return/,
            "a second click starts a second PATCH computed from the stale list");
        assert.match(source, /finally\s*\{[^}]*setMoving\(false\)/,
            "a refused reorder leaves the chevrons dead");
    });

    it("keeps the lock until the reordered list is back", () => {
        const body = bodyOf(source, "const move");

        assert.match(body, /await reloadTargets\(\)/,
            "the lock lifts before the list state moves, so the stale window is still open");
    });

    it("shows the lock on both chevrons", () => {
        // The `=>` of the onClick arrow means a bare [^>]* stops short, so the
        // span runs from each opening tag to its handler the way the button
        // matchers above run to theirs.
        const chevrons = source.match(/<button(?:(?!<button)[^])*?move\(index, -?1\)/g) ?? [];

        assert.equal(chevrons.length, 2, "the chevrons are no longer recognisable by their handler");
        for (const tag of chevrons)
            assert.match(tag, /disabled=\{[^}]*moving/,
                "a chevron stays pressable while the reorder runs");
    });
});

/**
 * The pause dialog's main button, beside a quiet-hours button that already
 * carries this exact lock - a double-click sent two POST /speedtests/pause,
 * and the second could trip the route's rate limit into a red toast for an
 * action that succeeded.
 */
describe("the pause dialog cannot pause twice at once", () => {
    const source = readSource("client/src/common/components/PauseDialog/PauseDialog.jsx");

    it("holds a saving flag over handleSave", () => {
        assert.match(source, /const \[savingPause, setSavingPause] = useState\(false\)/,
            "nothing tracks a pause already in flight");
        assert.match(source, /if \(savingPause\) return/,
            "a second click posts the pause again");
        assert.match(source, /finally\s*\{[^}]*setSavingPause\(false\)/,
            "a refused pause leaves the dialog locked shut");
    });

    it("shows the lock on the button", () => {
        const tag = source.match(/<button(?:(?!<button)[^])*?handleSave\(close\)(?:(?!<button)[^])*?>/)?.[0];

        assert.ok(tag, "the pause button is no longer recognisable by its handler");
        assert.match(tag, /disabled=\{[^}]*savingPause/,
            "the pause button stays pressable while the request runs");
    });
});
