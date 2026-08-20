import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readSource } from "../helpers/source.js";
import { withoutUrlCredentials } from "../../server/util/urlCredentials.js";

/**
 * A credential does not stop being one for living inside a URL.
 *
 * The redacted export nulls a node's `password` column and skips the admin
 * hash, which is the whole of what it understood a secret to be. But a node URL
 * carries userinfo - `http://admin:hunter2@node.lan` is a working address, and
 * validateInput accepts it because `new URL` parses it - and safeRequest passes
 * that URL to http.request, which honours the credential. So an operator
 * fronting a child node with basic auth had it written into the file the export
 * stamps `secretsRedacted: true`, which is the file people attach to bug
 * reports and sync to cloud backups.
 *
 * The address itself is kept, because a restore that dropped the node's URL
 * would bring back a node pointing nowhere. Only the credential goes.
 */
describe("withoutUrlCredentials", () => {
    it("strips userinfo and keeps the address", () => {
        assert.equal(withoutUrlCredentials("http://admin:hunter2@node.lan:5216"),
            "http://node.lan:5216");
    });

    it("strips a username with no password", () => {
        assert.equal(withoutUrlCredentials("http://admin@node.lan:5216"), "http://node.lan:5216");
    });

    it("keeps the path, the query and the port", () => {
        assert.equal(withoutUrlCredentials("https://u:p@node.lan:8443/api/v2?x=1"),
            "https://node.lan:8443/api/v2?x=1");
    });

    /**
     * And it adds nothing. Clearing the credential on a parsed URL and
     * serialising it back turns an empty path into "/", and a node URL with a
     * trailing slash is its own bug: the proxy builds its target by
     * concatenation, so a restored "http://node.lan:5216/" asks the child for
     * "//api/config", which its router does not match. A redaction that
     * rewrites the address it keeps is not a redaction.
     */
    it("does not add a trailing slash to a bare origin", () => {
        assert.equal(withoutUrlCredentials("http://admin:hunter2@node.lan:5216"), "http://node.lan:5216");
        assert.doesNotMatch(withoutUrlCredentials("http://admin@node.lan:5216"), /\/$/);
    });

    // The last @, because a password is allowed to contain one.
    it("strips a password that carries an at sign", () => {
        assert.equal(withoutUrlCredentials("http://admin:hunt@er2@node.lan:5216"), "http://node.lan:5216");
    });

    // The ordinary node, which must come back from a backup byte for byte.
    it("leaves a URL that carries no credential exactly as it was", () => {
        for (const url of ["http://192.168.1.50:5216", "https://node.example/api", "http://[fd00::1]:5216"])
            assert.equal(withoutUrlCredentials(url), url);
    });

    /**
     * A value that will not parse is answered with, rather than dropped or
     * thrown over: an unparseable node URL is already stored on some instance -
     * an unbracketed IPv6 literal is the realistic way - and an export is not
     * the place to discover it. It carries no userinfo a URL parser can find,
     * so passing it through leaks nothing.
     */
    it("hands back something it cannot parse", () => {
        assert.equal(withoutUrlCredentials("not a url"), "not a url");
        assert.equal(withoutUrlCredentials(""), "");
        assert.equal(withoutUrlCredentials(null), null);
    });
});

/**
 * And the export applies it - to the nodes, and to the one config value that is
 * a URL an operator can put a credential in.
 *
 * libreUrl is the librespeed backend address, and GET /api/config already
 * withholds it from a reader who is not the operator - so the redacted backup
 * was handing out a value the live API refuses to that same caller.
 */
describe("the redacted export", () => {
    const source = readSource("server/controller/config.js");

    it("strips the credential from every node URL", () => {
        assert.match(source, /withoutUrlCredentials\(row\.url\)/,
            "a node URL leaves in a redacted backup with its userinfo attached");
    });

    it("strips it from the librespeed URL too", () => {
        assert.match(source, /CREDENTIAL_BEARING_KEYS/,
            "the config half of the export still ships every URL verbatim");
    });

    // The full export is the one that exists to carry credentials - a restore
    // from it has to bring the instance back exactly as it was.
    it("leaves a full export untouched", () => {
        assert.match(source, /includeSecrets \? nodeRows\s*:/,
            "the credential strip is no longer behind the redaction switch");
    });
});
