import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readSource } from "../helpers/source.js";

const source = readSource("client/src/common/components/IntegrationDialog/IntegrationDialog.jsx");

/**
 * The setActive call inside a named handler, from the call to the semicolon
 * that ends its statement.
 *
 * Bounded by the terminating `;` rather than by a line break, because the tree
 * is CRLF and these arrows carry no semicolons of their own inside the updater
 * - the filter, the map and the spread all close before it.
 */
const setActiveStatement = (named) => {
    const at = source.indexOf(named);
    assert.notEqual(at, -1, `${named} is gone from the dialog`);

    const call = source.indexOf("setActive(", at);
    assert.notEqual(call, -1, `${named} no longer writes the active list`);

    return source.slice(call, source.indexOf(";", call) + 1);
};

/**
 * The three writes to the `active` list, each of which ran after an await -
 * removeIntegration after deleteRequest, updateIntegration after putRequest
 * resolves and its body is read, addIntegration alongside a save already in
 * flight - and each of which rebuilt the list from the `active` snapshot the
 * handler closed over at render.
 *
 * So two edits overlapping in flight wrote each other's stale copy back:
 * deleting A then B before A's request returned re-seeded the list from the
 * pre-A snapshot and A reappeared, and adding a card while a save was in flight
 * vanished when that save's updater put its own snapshot back. A functional
 * updater reads the live list rather than the closed-over one.
 *
 * Source-scanned because the dialog has no render harness; the shape pinned is
 * a `prev =>` updater whose body edits `prev` and never reaches back for the
 * stale `active`.
 */
describe("the integration dialog folds edits into the current list", () => {
    const cases = [
        {what: "removeIntegration", named: "const removeIntegration", edits: /prev\.filter\(/},
        {what: "updateIntegration", named: "const updateIntegration", edits: /prev\.map\(/},
        {what: "addIntegration", named: "const addIntegration", edits: /\[\.\.\.prev,/}
    ];

    for (const {what, named, edits} of cases) {
        it(`${what} passes setActive an updater rather than a render-time value`, () => {
            assert.match(setActiveStatement(named), /^setActive\(prev =>/,
                `${what} still hands setActive a list built from the render snapshot`);
        });

        it(`${what} edits the updater's own argument`, () => {
            assert.match(setActiveStatement(named), edits,
                `${what} does not apply its edit to the live list the updater is handed`);
        });

        it(`${what} never reaches back for the stale \`active\` closure`, () => {
            assert.doesNotMatch(setActiveStatement(named), /\bactive\b/,
                `${what} reads the render-time \`active\`, so a concurrent edit is lost`);
        });
    }
});
