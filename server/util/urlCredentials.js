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
 * A value that will not parse is redacted too, and this file used to say why it
 * need not be: an unparseable URL "carries no userinfo a parser could find, so
 * passing it through leaks nothing". The first half is true and the second does
 * not follow. A parser cannot find it; the credential is still in the text, and
 * the text is what leaves. `http://myspeed:hunter2@fd00::1:8086` is the shape -
 * an unbracketed IPv6 literal is the realistic way an unparseable URL comes to
 * be stored, since the field only has to satisfy `new URL` at the time it was
 * set, and basic auth in front of it is ordinary.
 *
 * Both readers of this are ones a credential must not reach. One is the export
 * people attach to bug reports and sync to cloud backups. The other is a
 * stranger: `withoutSecrets` answers the untrusted reader of GET
 * /api/integrations as well as building that export, and gotify's and
 * influxdb's `url` fields are not `secret: true` - so nothing else in that path
 * touches them, and this function is the whole of what protects them.
 *
 * The address itself is still kept wherever it can be, for the reason it always
 * was: an unparseable URL is already stored on some instance, and an export is
 * not the place to discover it. Only where the walk below cannot vouch for its
 * own answer does the address go with the credential.
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
 * What is answered when the walk below cannot vouch for what it produced.
 *
 * A placeholder is useless to a restore and names nothing to a reader, and that
 * is the price of it. A credential handed to either is not a price; it is the
 * thing this file exists to prevent.
 */
export const REDACTED_URL = "[redacted]";

/**
 * Where the authority begins and ends in the text of a URL.
 *
 * It begins after the scheme and after however many slashes were written, which
 * is not the same as after a literal "://": a special scheme accepts
 * "http:user:pw@node.lan/" with none at all, and looking three characters past
 * the colon cut the redaction into the scheme itself and answered
 * "htnode.lan/".
 *
 * Extracted rather than written twice. The failure report in util/http.js needs
 * exactly this walk - with the backslash dialect and all - and a second copy of
 * it is a second thing to get right the next time either is touched.
 */
/**
 * Whether an unparseable value is a URL at all, and so whether the walk below
 * has any business rewriting it.
 *
 * Two questions, because either alone lets free text through. The scheme has to
 * be one of the ones an address is actually stored under here - every URL field
 * in this app is `https?://`, and node URLs and libre backends are the same -
 * so "Report: results @ noon" is not read as a URL under the scheme "Report".
 * And a URL carries no unencoded whitespace, which is what separates
 * "MySpeed @ home: test failed" from an address someone typed badly.
 *
 * The parseable branch needs none of this: `new URL` answering at all is the
 * same guarantee, and `sameTarget` checks the result on top.
 */
const looksLikeStoredUrl = (value) =>
    !/\s/.test(value)
        && SPECIAL_SCHEMES.includes(value.slice(0, value.indexOf(":") + 1).toLowerCase());

const authorityBounds = (value, special) => {
    let start = value.indexOf(":") + 1;
    while (start < value.length && isAuthoritySlash(value[start], special)) start++;

    const rest = value.slice(start);
    const end = rest.search(special ? AUTHORITY_END_SPECIAL : AUTHORITY_END);

    return {start, end: end === -1 ? value.length : start + end};
};

/**
 * The same text with any userinfo cut out of its authority, reached by walking
 * rather than by parsing - so it holds for a value `new URL` refuses.
 *
 * `authorityOnly` says how much of what follows the authority comes back: all
 * of it for a redaction, which promised to shorten an address rather than
 * rewrite it, and none of it for a failure report, which needs to name a
 * destination and has no business repeating a path that is itself the secret.
 *
 * The userinfo is everything before the last "@" in the authority - the last,
 * because a password may legally contain one.
 *
 * The scheme is read out of the text here rather than off a parsed URL, because
 * for the value this is really for there is no parsed URL. Lowercased, since
 * "HTTP:" is the same special scheme to the parser and would not be to a list
 * lookup.
 *
 * With no parse to appeal to, the guarantee sameTarget gives the parseable path
 * has to be textual: every "@" in the value must fall inside the authority the
 * walk found. One that does not means the walk and whoever typed the value
 * disagree about where the authority ended - "user:pa/ss@host" is a password
 * with a slash in it to the second and a host of "user:pa" to the first - and
 * the safe answer to that disagreement is to drop the value. So what comes back
 * from here carries no "@" at all, which is the whole of the invariant:
 * userinfo is the text before one, so text with none has none.
 */
const cutUserinfo = (value, authorityOnly) => {
    const scheme = value.slice(0, value.indexOf(":") + 1).toLowerCase();
    const {start, end} = authorityBounds(value, SPECIAL_SCHEMES.includes(scheme));

    const first = value.indexOf("@");
    const last = value.lastIndexOf("@");

    if (first === -1) return authorityOnly ? value.slice(0, end) : value;
    if (first < start || last >= end) return REDACTED_URL;

    return value.slice(0, start) + (authorityOnly ? value.slice(last + 1, end) : value.slice(last + 1));
};

/**
 * The authority of a URL and nothing after it, with any userinfo gone.
 *
 * For the failure report in util/http.js, which names the endpoint that would
 * not answer and used to name the whole stored string when `new URL` threw.
 * healthChecks.js, ntfy.js and webhook.js all declare their URL `secret: true`
 * behind a pattern loose enough to accept an unbracketed IPv6 host and a port
 * outside the range, so for those three the path *is* the secret - and for
 * healthchecks the line repeated on every ping tick.
 *
 * Cutting to the authority is not enough on its own, which is the half worth
 * saying out loud: userinfo lives *in* the authority, so
 * "https://user:s3cret@2001:db8::1/webhook/x" still reads
 * "https://user:s3cret@2001:db8::1" once the path is off. The userinfo goes
 * first, and the cut above is what takes it.
 *
 * A value that is not a string, or is empty, names nothing - so it gets the
 * placeholder rather than leaving a hole in the middle of a sentence.
 */
export const authorityWithoutCredentials = (value) =>
    typeof value === "string" && value !== "" ? cutUserinfo(value, true) : REDACTED_URL;

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
        // No parse to check the surgery against, so the walk answers alone -
        // and drops the value where it cannot vouch for what it produced.
        //
        // Only for something shaped like a URL, which is the whole of what this
        // function promises to touch. withoutSecrets runs it over every
        // remaining string field of every integration, and several of those are
        // free text that is not secret - an e-mail subject, a Discord display
        // name, a Gotify title - where an "@" is ordinary. Without this gate the
        // walk read "Alerts@office" as userinfo on a host called "office" and
        // answered "office", into the export a restore reads back and into what
        // an untrusted reader is shown.
        return looksLikeStoredUrl(value) ? cutUserinfo(value, false) : value;
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
     * The parsed scheme decides the dialect here, where cutUserinfo has to read
     * it out of the text: there is a URL in hand, so it answers the question.
     */
    const {start, end} = authorityBounds(value, SPECIAL_SCHEMES.includes(url.protocol));

    const at = value.slice(start, end).lastIndexOf("@");
    if (at === -1) return value;

    const stripped = value.slice(0, start) + value.slice(start + at + 1);
    if (sameTarget(stripped, url)) return stripped;

    // The walk and the parser disagreed about this one. The address the parser
    // read is the address the instance actually connects to, so that is what a
    // restore has to come back with - serialised, trailing slash and all, since
    // a rewritten path is the lesser wrong against a rewritten host.
    return `${url.protocol}//${url.host}${url.pathname}${url.search}${url.hash}`;
};
