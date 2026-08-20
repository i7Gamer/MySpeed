/**
 * A URL with any credential taken out of it, and everything else left alone.
 *
 * A URL is allowed to carry userinfo - `http://admin:hunter2@node.lan:5216` is
 * a working address, `new URL` parses it, and node's http.request honours it -
 * so an operator fronting a child node with basic auth stores a credential in a
 * column nothing treated as one. The redacted config export nulls the node's
 * `password` and the admin hash and stamps `secretsRedacted: true`, which made
 * that file safe to attach to a bug report in every respect but this one.
 *
 * The address survives, because a restore that dropped it would bring back a
 * node pointing nowhere; only the credential goes, and it has to be re-entered
 * the way every other redacted credential does.
 *
 * A value that will not parse is handed straight back rather than dropped or
 * thrown over. An unparseable URL is already stored on some instance - an
 * unbracketed IPv6 literal is the realistic way in, since the field only has to
 * satisfy `new URL` at the time it was set - and an export is not the place to
 * discover it. It also carries no userinfo a parser could find, so passing it
 * through leaks nothing.
 */
const AUTHORITY_END = /[/?#]/;

export const withoutUrlCredentials = (value) => {
    if (typeof value !== "string" || value === "") return value;

    let url;
    try {
        url = new URL(value);
    } catch {
        return value;
    }

    if (url.username === "" && url.password === "") return value;

    /*
     * Cut out of the text rather than cleared on the parsed URL and serialised
     * back. `new URL("http://node.lan:5216").toString()` answers
     * "http://node.lan:5216/" - the empty path becomes a slash - and a node URL
     * with a trailing slash is its own bug: routes/nodes.js builds the proxy
     * target by concatenation, so the stored value would come back from a
     * restore producing "//api/config", which the child's router does not
     * match. Redacting a backup must not quietly rewrite the address it keeps.
     *
     * The authority is everything between "://" and the first "/", "?" or "#"
     * after it, and the userinfo is everything in it before the last "@" - the
     * last, because a password may legally contain one.
     */
    const start = value.indexOf("://") + 3;
    const rest = value.slice(start);
    const end = rest.search(AUTHORITY_END);
    const authorityEnd = end === -1 ? value.length : start + end;

    const authority = value.slice(start, authorityEnd);
    const at = authority.lastIndexOf("@");
    if (at === -1) return value;

    return value.slice(0, start) + authority.slice(at + 1) + value.slice(authorityEnd);
};
