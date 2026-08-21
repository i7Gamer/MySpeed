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
/*
 * Where the authority ends, in the two dialects the URL parser has.
 *
 * For a special scheme a backslash is a slash - the parser converts them - so
 * it ends the authority just as "/" does, and a walk that scans only for "/?#"
 * runs on into the path. That is not cosmetic: in
 * "http://admin:pw@evil.com\@good.com/" the address is evil.com, and a walk
 * that reaches the second "@" answers good.com.
 */
const AUTHORITY_END = /[/?#]/;
const AUTHORITY_END_SPECIAL = /[/\\?#]/;

// The schemes for which the parser applies that conversion, and skips however
// many slashes were written after the colon rather than requiring two.
const SPECIAL_SCHEMES = ["http:", "https:", "ws:", "wss:", "ftp:", "file:"];

const isAuthoritySlash = (character, special) =>
    character === "/" || (special && character === "\\");

/**
 * The same address, or not the same address.
 *
 * The surgery below is textual, and text and the URL parser can disagree; when
 * they do, the redaction rewrites an address it promised only to shorten. So
 * whatever comes out is parsed back and held against what went in, and a
 * candidate that moved the target is refused rather than returned. This is the
 * guarantee, not the two spellings that broke it - a walk that disagrees with
 * the parser in some third way lands here too.
 */
const sameTarget = (candidate, original) => {
    let parsed;
    try {
        parsed = new URL(candidate);
    } catch {
        return false;
    }

    return parsed.protocol === original.protocol && parsed.host === original.host
        && parsed.pathname === original.pathname && parsed.search === original.search
        && parsed.hash === original.hash && parsed.username === "" && parsed.password === "";
};

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
     * The authority begins after the scheme and after however many slashes were
     * written, which is not the same as after a literal "://": a special scheme
     * accepts "http:user:pw@node.lan/" with none at all, and looking three
     * characters past the colon then cut the redaction into the scheme itself
     * and answered "htnode.lan/". The userinfo is everything before the last
     * "@" in it - the last, because a password may legally contain one.
     */
    const special = SPECIAL_SCHEMES.includes(url.protocol);

    let start = value.indexOf(":") + 1;
    while (start < value.length && isAuthoritySlash(value[start], special)) start++;

    const rest = value.slice(start);
    const end = rest.search(special ? AUTHORITY_END_SPECIAL : AUTHORITY_END);
    const authorityEnd = end === -1 ? value.length : start + end;

    const at = value.slice(start, authorityEnd).lastIndexOf("@");
    if (at === -1) return value;

    const stripped = value.slice(0, start) + value.slice(start + at + 1);
    if (sameTarget(stripped, url)) return stripped;

    // The walk and the parser disagreed about this one. The address the parser
    // read is the address the instance actually connects to, so that is what a
    // restore has to come back with - serialised, trailing slash and all, since
    // a rewritten path is the lesser wrong against a rewritten host.
    return `${url.protocol}//${url.host}${url.pathname}${url.search}${url.hash}`;
};
