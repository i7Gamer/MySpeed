import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readSource } from "../helpers/source.js";
import { withoutUrlCredentials } from "../../server/util/urlCredentials.js";
import { announcedValue } from "../../server/controller/config.js";

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

/**
 * And the other way the same value leaves the instance.
 *
 * The export is not the only reader of libreUrl. Every save fires a
 * `configUpdated` event carrying the key and its new value, and the webhook and
 * discord modules deliver that to whatever address the operator configured -
 * over plain http on a LAN, as often as not. That announcement redacted exactly
 * one key, `password`, so the librespeed backend URL went out verbatim: an
 * address whose userinfo the export has stripped since it learned a URL can
 * carry a credential, and which GET /api/config already withholds from a reader
 * who is not the operator.
 *
 * The same list decides it in both places. Two lists would drift the first time
 * a key was added to one of them, which is precisely the drift that left this
 * half behind.
 */
describe("what a configUpdated event carries", () => {
    it("never carries the password, hashed or otherwise", () => {
        assert.equal(announcedValue("password", "$2b$10$abcdefghijklmnopqrstuv"), "protected");
    });

    it("strips the credential out of the librespeed URL", () => {
        assert.equal(announcedValue("libreUrl", "http://admin:hunter2@speed.lan:8080"),
            "http://speed.lan:8080");
    });

    it("keeps the address itself, which is what the announcement is about", () => {
        assert.equal(announcedValue("libreUrl", "https://speed.example.net/backend"),
            "https://speed.example.net/backend");
    });

    // An ordinary setting is announced as it was stored. Redacting more than the
    // credentials would make the event useless to the consumers it exists for.
    it("passes an ordinary value through untouched", () => {
        assert.equal(announcedValue("cron", "0 * * * *"), "0 * * * *");
        assert.equal(announcedValue("download", "500"), "500");
    });

    /**
     * The one that ties the two halves together: whatever the export treats as
     * credential-bearing, the announcement has to treat the same way. A key
     * added to the list for the export alone is this bug again under a new name.
     */
    it("redacts every key the export redacts", () => {
        const source = readSource("server/controller/config.js");
        const declared = source.match(/CREDENTIAL_BEARING_KEYS = \[([^\]]*)\]/);

        assert.ok(declared, "the export no longer names the keys that can carry a credential");

        const keys = [...declared[1].matchAll(/"([^"]+)"/g)].map((match) => match[1]);
        assert.ok(keys.length > 0, "the list is empty, so neither half redacts anything");

        for (const key of keys)
            assert.equal(announcedValue(key, "http://admin:hunter2@host.lan"), "http://host.lan",
                `${key} is redacted in the export but announced verbatim`);
    });
});
