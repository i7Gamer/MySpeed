import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readSource } from "../helpers/source.js";
import {
    reloadOnPermissionChange
} from "../../client/src/common/contexts/Speedtests/permission.js";

/**
 * The rows in hand carry what the session was allowed to see.
 *
 * A read-only session is served speedtests with stripConnectionIdentity run
 * over every row: isp and externalIp nulled, resultId deleted. The detail pane
 * gates its Connection fact on `test.isp || test.externalIp` and its result
 * link on `test.resultId`, so under that session those parts of the pane render
 * nothing at all.
 *
 * Signing in through the header is the one login path that does not reload the
 * page - it calls login() and then reloadConfig(), which refetches /config and
 * nothing else. The list is not keyed on any of that: its load effect runs for
 * the node and the selected range, neither of which moves. So the rows stayed
 * as the read-only fetch left them and the detail pane kept its holes, and a
 * full page reload was the only way back.
 *
 * The other providers already close this themselves - NodeContext keys its load
 * on the config, StatusContext polls - which is why the list was the only thing
 * left needing the reload.
 *
 * Refreshing cannot stand in for refetching. A refresh asks the same query and
 * merges the answer, and mergeNewTests only prepends rows the list does not
 * already know: every stripped row is known by id and would be kept verbatim.
 * Only loadInitialTests replaces them.
 */
describe("reloadOnPermissionChange", () => {
    const run = (held, viewMode) => {
        let reloaded = 0;
        const next = reloadOnPermissionChange(held, viewMode, () => reloaded++);

        return {next, reloaded};
    };

    it("holds nothing while the config has still not arrived", () => {
        assert.deepEqual(run(undefined, undefined), {next: undefined, reloaded: 0});
    });

    /**
     * The list and the config are fetched side by side at mount, so the first
     * answer is not a change - it is the baseline. Treating it as one would
     * refetch the whole list on every single page load, which is the cost that
     * made keying this on the value rather than the transition wrong.
     */
    it("records the first answer without refetching", () => {
        assert.deepEqual(run(undefined, false), {next: false, reloaded: 0});
        assert.deepEqual(run(undefined, true), {next: true, reloaded: 0});
    });

    it("refetches when a read-only viewer signs in", () => {
        assert.deepEqual(run(true, false), {next: false, reloaded: 1});
    });

    // The same in reverse, and for the same reason: rows fetched with the
    // operator's provider and address in them must not stay on screen once the
    // session holding them has dropped to read level.
    it("refetches when the session drops back to read level", () => {
        assert.deepEqual(run(false, true), {next: true, reloaded: 1});
    });

    it("leaves the list alone when the permission has not moved", () => {
        assert.deepEqual(run(false, false), {next: false, reloaded: 0});
        assert.deepEqual(run(true, true), {next: true, reloaded: 0});
    });

    /**
     * Kept rather than overwritten, which is the whole reason this returns the
     * value to hold instead of writing whatever it was given.
     *
     * Recording the absence would make the next real answer look like a first
     * one - so a permission that went read-only, briefly unknown, then admin
     * would be read as a baseline being set, and the refetch it needs would be
     * skipped with nothing said.
     */
    it("keeps the permission it holds when an answer carries none", () => {
        assert.deepEqual(run(true, undefined), {next: true, reloaded: 0});
        assert.deepEqual(run(false, undefined), {next: false, reloaded: 0});
    });
});

/**
 * And that the provider actually asks it. A predicate nothing calls is worth
 * nothing, and this one is reached from an effect whose dependency array is the
 * half that decides when it runs at all.
 */
describe("SpeedtestProvider watches the permission its rows were fetched under", () => {
    const source = readSource("client/src/common/contexts/Speedtests/SpeedtestContext.jsx");

    const effect = () => {
        // The import carries no parenthesis, so this is the call.
        const at = source.indexOf("reloadOnPermissionChange(");
        assert.notEqual(at, -1, "the provider no longer watches the permission");

        return source.slice(at, source.indexOf("]);", at) + 3);
    };

    const dependencies = () => {
        const body = effect();

        return body.slice(body.lastIndexOf("["), body.lastIndexOf("]") + 1);
    };

    it("reads the config the permission is announced in", () => {
        assert.match(source, /import \{ConfigContext\} from "@\/common\/contexts\/Config"/,
            "the provider cannot see viewMode without the config context");
        assert.match(source, /useContext\(ConfigContext\)/);
    });

    it("refetches rather than refreshing", () => {
        assert.match(effect(), /loadInitialTests/,
            "a refresh merges, and mergeNewTests keeps every row it already knows by id - "
            + "so the stripped rows would survive it untouched");
    });

    it("keys on the permission itself, not on the whole config", () => {
        assert.match(dependencies(), /config\.viewMode/,
            "nothing re-runs the effect when the permission changes under the list");

        assert.doesNotMatch(dependencies(), /\bconfig\s*[,\]]/,
            "the config is a new object identity every time it reloads, so depending on the "
            + "whole of it would refetch the list each time the settings dialog saves");
    });

    // Both halves, or the effect closes over a stale loader: loadInitialTests is
    // rebuilt whenever the selected range changes, and an effect holding the
    // previous one would refetch the range the reader has already left.
    it("depends on the loader it calls", () => {
        assert.match(dependencies(), /loadInitialTests/);
    });
});
