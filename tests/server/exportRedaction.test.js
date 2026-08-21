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

    /**
     * The two ways a URL can carry userinfo without spelling "://" before it.
     *
     * A textual walk that looks for "://" and stops the authority at "/", "?"
     * or "#" is not the walk the URL parser takes, and where the two disagree
     * the redaction rewrites an address it promised only to shorten. Both of
     * these parse - which is the whole reason they are stored in the first
     * place, since the field only has to satisfy `new URL` - so both reach this
     * function.
     */
    it("keeps the address when the scheme carries no slashes", () => {
        // Special schemes ignore however many slashes were written, so this is
        // node.lan to `new URL`, to safeRequest and to http.request. Reading
        // three characters past the colon took the redaction into the scheme.
        assert.equal(new URL(withoutUrlCredentials("http:admin:hunter2@node.lan/")).hostname, "node.lan");
        assert.doesNotMatch(withoutUrlCredentials("http:admin:hunter2@node.lan/"), /hunter2/);
    });

    it("keeps the address when a backslash ends the authority", () => {
        // A backslash terminates the authority exactly as a slash does, so this
        // address is evil.com and everything after it is the path. Scanning
        // only for "/?#" ran the walk into that path and took its "@" instead,
        // which answered good.com - a redaction that silently repoints a node.
        const redacted = withoutUrlCredentials("http://admin:pw@evil.com\\@good.com/");

        assert.equal(new URL(redacted).hostname, "evil.com");
        assert.doesNotMatch(redacted, /admin:pw/);
    });

    /**
     * And the general form of both, which is what actually keeps them fixed.
     *
     * The two cases above are the ones that were found; the guarantee is that
     * no input can be redacted into a different target. Whatever the textual
     * surgery produces is parsed back and compared against the address that
     * went in, so a walk that ever disagrees with the parser again is caught
     * here rather than in a restored backup.
     */
    it("never redacts one address into another", () => {
        const targets = [
            "http://admin:hunter2@node.lan:5216",
            "http://admin:hunt@er2@node.lan:5216/x?y=1#z",
            "https://u:p@node.lan:8443/api/v2?x=1",
            "http:admin:hunter2@node.lan/",
            "http://admin:pw@evil.com\\@good.com/",
            "http://admin:pw@[fd00::1]:5216/api"
        ];

        for (const target of targets) {
            const before = new URL(target);
            const after = new URL(withoutUrlCredentials(target));

            assert.equal(after.host, before.host, `${target} was redacted to a different host`);
            assert.equal(after.protocol, before.protocol, `${target} changed scheme`);
            assert.equal(after.pathname, before.pathname, `${target} changed path`);
            assert.equal(after.username, "", `${target} kept its username`);
            assert.equal(after.password, "", `${target} kept its password`);
        }
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

    // Both halves, because naming the list proves nothing on its own: an empty
    // list and a deleted branch each leave the name in place, and either one
    // ships libreUrl verbatim in a file stamped secretsRedacted.
    it("strips it from the librespeed URL too", () => {
        assert.match(source, /CREDENTIAL_BEARING_KEYS = \[[^\]]*"libreUrl"/,
            "libreUrl is no longer on the list of values that can carry a credential");
        assert.match(source, /CREDENTIAL_BEARING_KEYS\.includes\([^)]*\)\s*\?\s*withoutUrlCredentials/,
            "the config half of the export still ships every URL verbatim");
    });

    // The full export is the one that exists to carry credentials - a restore
    // from it has to bring the instance back exactly as it was.
    it("leaves a full export untouched", () => {
        assert.match(source, /includeSecrets \? nodeRows\s*:/,
            "the credential strip is no longer behind the redaction switch");
    });
});
