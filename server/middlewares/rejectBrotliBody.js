/**
 * Refuses request bodies that arrive Brotli-compressed.
 *
 * The JSON parser decodes `Content-Encoding: br` with the runtime's bundled
 * Brotli decoder, and it runs before any password check. CVE-2026-111497
 * ("Node2Shell") is an out-of-bounds write in that decoder on a crafted stream,
 * so an anonymous caller could reach memory corruption with a single request.
 * Updating the runtime fixes the decoder; this keeps the decoder out of reach of
 * request bodies whatever runtime the instance happens to be on.
 *
 * Nothing legitimate is lost: browsers never compress request bodies, and the
 * node proxy strips content-encoding before it forwards.
 */

const UNSUPPORTED_MEDIA_TYPE = 415;

// RFC 7694: a 415 for an unsupported content coding names the ones that are.
const SUPPORTED_ENCODINGS = "gzip, deflate";

const BROTLI = "br";

const isBrotli = (contentEncoding) =>
    String(contentEncoding ?? "").split(",").some(token => token.trim().toLowerCase() === BROTLI);

export default () => (req, res, next) => {
    if (!isBrotli(req.headers["content-encoding"])) return next();

    res.setHeader("Accept-Encoding", SUPPORTED_ENCODINGS);
    return res.status(UNSUPPORTED_MEDIA_TYPE).json({message: "Brotli-compressed request bodies are not accepted"});
};
