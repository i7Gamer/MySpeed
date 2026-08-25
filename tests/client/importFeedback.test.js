import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readSource, withoutJsComments } from "../helpers/source.js";
import { compile } from "../helpers/sass.mjs";

const CLIENT_SRC = path.resolve(fileURLToPath(import.meta.url), "..", "..", "..", "client", "src");

// listSources is neither recursive nor interested in .jsx, and every caller of
// updateToast is a component. Walked here rather than widening the helper,
// which a dozen other tests read at its current contract.
const componentSources = (dir) => fs.readdirSync(dir, {withFileTypes: true}).flatMap((entry) => {
    const full = path.join(dir, entry.name);

    if (entry.isDirectory()) return componentSources(full);
    return /\.jsx?$/.test(entry.name) ? [fs.readFileSync(full, "utf8")] : [];
});

const storageRoutes = withoutJsComments(readSource("server/routes/storage.js"));
const speedtestsTab = withoutJsComments(readSource("client/src/common/components/StorageDialog/tabs/Speedtests.jsx"));
const configTab = withoutJsComments(readSource("client/src/common/components/StorageDialog/tabs/Configuration.jsx"));

/**
 * A restore that only half worked, reported as one that worked.
 *
 * Both import routes were taught to say more than "it failed". /tests/history
 * sends `imported` and `skipped` beside its message, because a file whose rows
 * were nearly all refused had been answering exactly as a file that restored
 * whole. /config names the stored key it choked on, because a restore is
 * abandoned entire on the first value it cannot read and "Error importing
 * config" left the operator to bisect the file by hand.
 *
 * Both were then dropped on the floor. The dialogs awaited the response, read
 * `res.ok`, and never touched the body - so the server worked out the useful
 * half of the answer, put it on the wire, and the interface showed the same
 * green toast as before. Nothing failed. Two suites stayed green across the
 * whole gap, because each only ever tested its own end.
 *
 * Which is what this holds: the fields the route puts in the body, against the
 * dialog that has to read them. Written against the source rather than a
 * rendered dialog because the client suite does not compile JSX.
 */
const jsonBodyOf = (route) => {
    const at = storageRoutes.indexOf(route);
    assert.notEqual(at, -1, `the ${route} handler could not be found in server/routes/storage.js`);

    const json = storageRoutes.slice(at).match(/res\.status\([^)]*\)\.json\(\{([\s\S]*?)\}\);/);
    assert.ok(json, `the ${route} handler does not answer with a json body`);

    return json[1];
};

/**
 * Asked one field at a time rather than by parsing the object literal.
 *
 * The first version of this walked the body with a global regex and consumed
 * the comma after each property, which left the next one with no delimiter to
 * match on: it read `{message, imported, skipped}` as declaring `message` and
 * `imported`, and would have passed a handler that had quietly stopped sending
 * the count this whole change exists to surface.
 *
 * The end anchor matters too. The last property is flush against the closing
 * brace, which the match that extracted this body already ate - so requiring a
 * delimiter after the name fails on whichever field happens to be written last.
 */
const declares = (body, field) => new RegExp(`(?:^|[,{])\\s*${field}\\s*(?:[,}:]|$)`).test(body);

describe("what the import routes send", () => {
    it("still sends the counts a partial restore is told apart by", () => {
        const body = jsonBodyOf('app.put("/tests/history"');

        for (const field of ["imported", "skipped"])
            assert.ok(declares(body, field), `/tests/history no longer sends ${field}`);
    });

    it("still names the key a refused config restore choked on", () => {
        assert.match(storageRoutes.slice(storageRoutes.indexOf('app.put("/config"')), /key:\s*result\.key/,
            "/config no longer sends the offending key as a field");
    });
});

describe("what the storage dialog reads back", () => {
    it("reads the body of the history import rather than only its status", () => {
        assert.match(speedtestsTab, /await res\?\.json\(\)/,
            "the tests tab never parses the response, so the counts are dropped");
        assert.match(speedtestsTab, /skipped/, "the tests tab does not look at the skipped count");
    });

    /**
     * The whole point of the change: a restore that refused rows must not look
     * like one that did not. Green is what it looked like before.
     */
    it("does not report a partly refused restore in the same colour as a clean one", () => {
        const call = speedtestsTab.match(/updateToast\(skipped[\s\S]*?\);/);

        assert.ok(call, "the tests tab no longer branches its toast on the skipped count");
        assert.match(call[0], /"orange"/, "a partial import is still reported as a plain success");
        assert.match(call[0], /storage\.tests_imported_partial/, "the partial import has no message of its own");
    });

    it("reads the key out of a refused config restore", () => {
        assert.match(configTab, /await res\?\.json\(\)/,
            "the configuration tab never parses the refusal, so the key is dropped");
        assert.match(configTab, /storage\.import_config_error_key/,
            "the configuration tab has no message that names the key");
    });

    /**
     * The generic message stays for the refusals that name nothing - a truncated
     * file, a network failure, a 500 with no body at all.
     */
    it("keeps the generic message for a refusal that names nothing", () => {
        assert.match(configTab, /storage\.import_config_error(?!_key)/,
            "the fallback for an unnamed refusal is gone");
    });
});

/**
 * The trap this change walked into on its way past.
 *
 * updateToast takes the colour as a string and puts it straight into a class
 * name, so "orange" was a perfectly good argument that produced `toast-orange`
 * - a class the stylesheet had no rule for. Nothing throws; the toast simply
 * renders without its coloured edge or icon, which is a hole where a signal
 * belongs. Exactly the shape of the integration icons that were named and never
 * drawn.
 */
describe("every toast colour a caller asks for", () => {
    const css = compile("common/contexts/ToastNotification/styles.sass");

    const asked = [...new Set(componentSources(CLIENT_SRC)
        .flatMap((source) => [...source.matchAll(/updateToast\([\s\S]{0,400}?,\s*"(\w+)"/g)])
        .map(([, colour]) => colour))];

    it("finds the colours to check", () => {
        assert.ok(asked.length >= 2, `only found ${asked.length} toast colours in the client`);
    });

    it("has a rule in the stylesheet", () => {
        const missing = asked.filter((colour) => !css.includes(`.toast-${colour}`));

        assert.deepEqual(missing, [],
            "these colours are passed to updateToast and styled nowhere, so the toast renders unmarked");
    });
});
