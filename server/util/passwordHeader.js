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
    // The control characters are the point: this asks whether every code point
    // fits in a byte, which is what a raw HTTP header can carry.
    // eslint-disable-next-line no-control-regex
    if (/^[\x00-\xFF]*$/.test(password)) headers.password = password;

    return headers;
};
