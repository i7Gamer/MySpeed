import {it} from "node:test";
import assert from "node:assert/strict";
import {httpsProxyRoute} from "../../server/util/outboundHttpsProxy.js";

const TARGET = new URL("https://outbound-fixture.invalid:5309/notify");
const PROXY = "http://proxy-fixture.invalid:5310/";
const OTHER_PROXY = "http://other-proxy.invalid:5311/";
const environment = (values = {}) => ({HTTPS_PROXY: PROXY, ...values});

for (const values of [{}, {HTTP_PROXY: PROXY}, {ALL_PROXY: PROXY}, {HTTPS_PROXY: "", https_proxy: ""}]) {
    it(`does not invent an HTTPS proxy from ${JSON.stringify(values)}`, () => {
        assert.equal(httpsProxyRoute(TARGET, values), undefined);
    });
}

for (const [name, values, expected] of [
    ["uppercase", {HTTPS_PROXY: PROXY}, PROXY],
    ["lowercase precedence", {https_proxy: OTHER_PROXY}, OTHER_PROXY],
    ["empty lowercase fallback", {https_proxy: ""}, PROXY],
    ["scheme-less HTTP", {HTTPS_PROXY: "proxy-fixture.invalid:5310"}, PROXY],
    ["secure proxy", {HTTPS_PROXY: "https://proxy-fixture.invalid:5310"}, "https://proxy-fixture.invalid:5310/"],
    ["credentials", {HTTPS_PROXY: "http://synthetic%20user:synthetic%3Apass@proxy-fixture.invalid:5310"},
        "http://synthetic%20user:synthetic%3Apass@proxy-fixture.invalid:5310/"],
    ["username only", {HTTPS_PROXY: "http://synthetic@proxy-fixture.invalid:5310"},
        "http://synthetic@proxy-fixture.invalid:5310/"]
]) {
    it(`retains Bun HTTPS proxy ${name}`, () => {
        assert.equal(httpsProxyRoute(TARGET, environment(values)).href, expected);
    });
}

for (const [pattern, bypass] of [
    ["outbound-fixture.invalid", true], ["OUTBOUND-FIXTURE.INVALID", true],
    ["invalid", true], [".invalid", true], [".outbound-fixture.invalid", true],
    ["outbound-fixture.invalid:5309", true], ["other.invalid, outbound-fixture.invalid ", true],
    ["*", true], ["other.invalid,*", true],
    ["outbound-fixture.invalid:5310", false], ["outbound-fixture.invalid:05309", false],
    ["outbound-fixture.invalid:0", false], ["outbound-fixture.invalid:abc", false],
    ["other.invalid outbound-fixture.invalid", false], ["*.invalid", false],
    ["bound-fixture.invalid", false], ["..outbound-fixture.invalid", false],
    ["outbound-fixture.invalid.", false], ["", false]
]) {
    it(`matches the original hostname against NO_PROXY ${JSON.stringify(pattern)}`, () => {
        const result = httpsProxyRoute(TARGET, environment({NO_PROXY: pattern}));
        assert.equal(result === null, bypass);
        if (!bypass) assert.equal(result.href, PROXY);
    });
}

it("uses nonempty lowercase no_proxy and falls back from an empty value", () => {
    assert.equal(httpsProxyRoute(TARGET, environment({no_proxy: "*", NO_PROXY: "other.invalid"})), null);
    assert.equal(httpsProxyRoute(TARGET, environment({no_proxy: "", NO_PROXY: "*"})), null);
    assert.equal(httpsProxyRoute(TARGET, environment({no_proxy: "other.invalid", NO_PROXY: "*"})).href, PROXY);
});

for (const [url, pattern, bypass] of [
    ["https://outbound-fixture.invalid/", "outbound-fixture.invalid:443", true],
    ["https://outbound-fixture.invalid/", "outbound-fixture.invalid:0443", false],
    ["https://127.0.0.1:5309/", "0.0.1", true],
    ["https://127.0.0.1:5309/", "27.0.0.1", false],
    ["https://[::1]:5309/", "[::1]", true],
    ["https://[::1]:5309/", "[::1]:5309", true],
    ["https://[::1]:5309/", "[::1]:5310", false],
    ["https://[::1]:5309/", "::1", false],
    ["https://[::1]:5309/", "0:0:0:0:0:0:0:1", false]
]) {
    it(`preserves literal/default-port bypass for ${url} and ${pattern}`, () => {
        assert.equal(httpsProxyRoute(new URL(url), environment({NO_PROXY: pattern})) === null, bypass);
    });
}

it("does not parse an unused proxy when NO_PROXY selects a direct connection", () => {
    assert.equal(httpsProxyRoute(TARGET, {HTTPS_PROXY: "malformed://[", NO_PROXY: "*"}), null);
});

for (const proxy of ["socks5://synthetic:secret@proxy.invalid", "ftp://proxy.invalid", "http://["]) {
    it(`refuses unsupported or invalid proxy configuration without exposing credentials`, () => {
        assert.throws(() => httpsProxyRoute(TARGET, {HTTPS_PROXY: proxy}), (error) => {
            assert.equal(error.message, "Invalid HTTPS proxy configuration");
            assert.equal(error.message.includes("secret"), false);
            return true;
        });
    });
}
