import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readSource } from "../helpers/source.js";

const indexSource = readSource("client/src/index.jsx");
const requestUtilSource = readSource("client/src/common/utils/RequestUtil.js");

/**
 * The one-off password migration runs at the top level of index.jsx, before the
 * first render, so that the very first request already carries the session.
 *
 * It was awaited bare. A top-level await that rejects leaves the module never
 * finishing evaluation - so ReactDOM.createRoot and root.render below it never
 * run, and the page is blank with only an unhandled rejection in the console to
 * say why. Nothing on screen, no error boundary, nothing to retry.
 *
 * What rejects: login() answers a refusal by *returning* {ok: false}, so a
 * wrong stored password is handled - but it awaits fetch, and fetch rejects
 * outright when it cannot reach the server at all. That is the upgrade itself:
 * this code path exists only for users upgrading from the stored-password
 * scheme, and the backend restarting underneath a page that is still loading is
 * exactly when it runs.
 *
 * Asserted on the source because the failure is in module evaluation - there is
 * no export to call, and the render beside it is JSX the test runner does not
 * compile.
 */
describe("the password migration at boot", () => {
    // The statement that runs it, with whatever guards it.
    const call = () => {
        const at = indexSource.indexOf("migrateStoredPassword()");
        assert.notEqual(at, -1, "the boot no longer migrates a stored password at all");
        return {at, before: indexSource.slice(0, at), after: indexSource.slice(at)};
    };

    it("still runs before the first render", () => {
        const {at} = call();

        assert.ok(at < indexSource.indexOf("root.render"),
            "the migration now runs after the render it exists to precede");
    });

    it("cannot stop the app mounting when it fails", () => {
        const {before, after} = call();

        // Either spelling is fine - a try/catch around it, or a .catch() on it.
        // What matters is that nothing propagates out to module evaluation.
        const caught = /\.catch\s*\(/.test(after.slice(0, after.indexOf("\n") + 120))
            || (/\btry\s*\{[^}]*$/.test(before) && /\}\s*catch/.test(after));

        assert.ok(caught,
            "a failed password migration leaves React unmounted and the page blank");
    });

    it("still mounts React after it", () => {
        assert.match(indexSource, /root\.render\(/,
            "nothing renders the app any more");
    });
});

/**
 * The other half of why a failure here is survivable: the stored password is
 * cleared however the exchange went, so a boot that could not reach the server
 * does not retry the same doomed migration on every load afterwards.
 */
describe("the migration itself", () => {
    it("clears the stored password whether or not the exchange worked", () => {
        const start = requestUtilSource.indexOf("export const migrateStoredPassword");
        assert.notEqual(start, -1, "migrateStoredPassword is no longer exported");

        const body = requestUtilSource.slice(start, requestUtilSource.indexOf("\n}", start));

        assert.match(body, /finally\s*\{[\s\S]*removeItem/,
            "a migration that fails would be retried, identically, on every load after it");
    });
});
