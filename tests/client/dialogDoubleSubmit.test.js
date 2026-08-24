import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { escapeRegExp, readSource } from "../helpers/source.js";

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
        what: "the provider dialog",
        file: "common/components/ProviderDialog/ProviderDialog.jsx",
        buttons: ['dialog.update']
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
});
