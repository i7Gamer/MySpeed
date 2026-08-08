/**
 * The little bit of cookie handling this server needs.
 *
 * Hand-rolled rather than adding cookie-parser: one cookie is read and one is
 * written, and the whole of it is shorter than the lockfile entry would be.
 */
export const readCookie = (req, name) => {
    const header = req.headers?.cookie;
    if (typeof header !== "string") return null;

    for (const pair of header.split(";")) {
        const index = pair.indexOf("=");
        if (index === -1) continue;

        if (pair.slice(0, index).trim() !== name) continue;

        try {
            return decodeURIComponent(pair.slice(index + 1).trim());
        } catch {
            return null;
        }
    }

    return null;
};

/**
 * Builds the Set-Cookie value.
 *
 * HttpOnly is the entire reason this exists - it is what puts the credential
 * out of reach of any script on the page. SameSite=Strict is what stops the
 * cookie turning every state-changing endpoint into a CSRF target now that a
 * browser attaches it automatically. Secure is set only on a secure request, so
 * a plain-HTTP LAN install still works.
 */
export const serialiseCookie = (name, value, {maxAge, secure = false} = {}) => {
    const parts = [
        `${name}=${encodeURIComponent(value)}`,
        "Path=/",
        "HttpOnly",
        "SameSite=Strict"
    ];

    if (maxAge !== undefined) parts.push(`Max-Age=${maxAge}`);
    if (secure) parts.push("Secure");

    return parts.join("; ");
};
