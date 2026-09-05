export const passwordHeaderNames = ["x-password", "password"];

const decode = (value) => {
    try {
        return decodeURIComponent(value);
    } catch {
        return null;
    }
};

const asUtf8 = (value) => {
    const decoded = Buffer.from(value, "latin1").toString("utf8");
    return decoded.includes("�") ? null : decoded;
};

export const readPasswords = (req) => {
    const [encoded, plain] = passwordHeaderNames.map(name => req.headers[name]);

    return [encoded && decode(encoded), plain, plain && asUtf8(plain)]
        .filter((candidate, index, all) => candidate && all.indexOf(candidate) === index);
};

export const writePasswordHeaders = (password) => {
    if (!password || password === "none") return {};

    const headers = {"x-password": encodeURIComponent(password)};
    // What Node's own http client accepts in a header value, not merely what
    // fits in a byte: checkInvalidHeaderChar refuses \x00-\x08, \x0A-\x1F
    // (control characters, CR and LF included) and \x7F, and throws
    // synchronously from inside http.request when it sees one. A node password
    // holding one of those - restored from a backup, since nothing on that path
    // checks a row this way - made every proxied request under that node 500,
    // where the encoded x-password header above already carries the same
    // password safely.
    if (/^[\t\x20-\x7E\x80-\xFF]*$/.test(password)) headers.password = password;

    return headers;
};
