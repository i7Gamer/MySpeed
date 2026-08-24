import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readSource, withoutJsComments } from "../helpers/source.js";
import { basePathFrom } from "@/common/utils/BasePath.js";

/**
 * The client half of upstream #771.
 *
 * The server takes a configured prefix off the front of every request. The
 * client has to put it back on the front of every URL it emits - the API calls,
 * and the paths the router pushes into the address bar - or the browser asks the
 * proxy for something outside the prefix and gets whatever else is served there.
 *
 * Worked out at runtime rather than configured. A build is shipped as a Docker
 * image and a compiled binary, so a prefix baked in at build time would mean one
 * image per deployment - and the operator has already told the server, which is
 * the only place that could not work it out for itself.
 *
 * The signal is where the entry module was loaded from. With `base: "./"` in the
 * vite config, index.html asks for `./assets/index-xxx.js`, so the browser
 * resolves it against wherever index.html itself was served - which is exactly
 * the prefix, whether the proxy strips it or not.
 */
describe("working out the prefix", () => {
    it("finds it under a subdirectory", () => {
        assert.equal(basePathFrom("https://homeserver.local/internet_speed/assets/index-BzWKo9xV.js"),
            "/internet_speed");
    });

    it("finds nothing at the root, which is what every existing instance is", () => {
        assert.equal(basePathFrom("https://myspeed.example/assets/index-BzWKo9xV.js"), "");
    });

    it("finds a nested prefix whole", () => {
        assert.equal(basePathFrom("https://host/apps/myspeed/assets/index-x.js"), "/apps/myspeed");
    });

    /**
     * The dev server serves the entry from /src rather than /assets, and the two
     * are the only layouts this application produces - so both are recognised
     * and anything else is treated as the root.
     */
    it("finds nothing under the dev server", () => {
        assert.equal(basePathFrom("http://localhost:5173/src/index.jsx"), "");
        assert.equal(basePathFrom("http://localhost:5173/internet_speed/src/index.jsx"), "/internet_speed");
    });

    /**
     * A layout this build does not produce means the assumption above no longer
     * holds, and guessing would put a directory name in front of every request.
     * Answering "root" is what every instance did before this existed, so it is
     * the safe way to be wrong.
     */
    it("falls back to the root for a layout it does not recognise", () => {
        assert.equal(basePathFrom("https://host/somewhere/else/bundle.js"), "");
        assert.equal(basePathFrom("https://host/bundle.js"), "");
    });

    it("survives being handed something that is not a URL", () => {
        for (const value of ["", "not a url", null, undefined, 42])
            assert.equal(basePathFrom(value), "", `${JSON.stringify(value)} produced a prefix`);
    });

    // The trailing slash matters: it is concatenated with paths that start with
    // one, so keeping it would produce "//api" - which some proxies read as a
    // protocol-relative URL.
    it("never ends in a slash", () => {
        for (const url of ["https://host/x/assets/i.js", "https://host/assets/i.js"])
            assert.ok(!basePathFrom(url).endsWith("/"), url);
    });
});

describe("the build", () => {
    const config = withoutJsComments(readSource("client/vite.config.mjs"));

    /**
     * Relative, so index.html asks for its assets against wherever it was itself
     * served. Absolute is what #771 reports: the page loads under the prefix and
     * then asks the proxy for /assets/index.js, which is outside it.
     */
    it("emits asset URLs relative to the page", () => {
        assert.match(config, /base:\s*["']\.\/["']/,
            "assets are still requested from the root whatever prefix the page was served under");
    });
});

describe("what the client sends", () => {
    const requestUtil = withoutJsComments(readSource("client/src/common/utils/RequestUtil.js"));

    it("puts the prefix in front of the API", () => {
        assert.match(requestUtil, /BasePath|apiBase|basePath/,
            "every API call still goes to /api at the root of the host");
    });

    it("tells the router where the application starts", () => {
        const app = withoutJsComments(readSource("client/src/App.jsx"));

        assert.match(app, /basename/,
            "navigating within the app drops the prefix out of the address bar");
    });
});

/**
 * The installed app, which is the same bug one layer out.
 *
 * The manifest is served from the prefix along with everything else, and every
 * URL inside it resolves against the manifest's own URL - so a relative one
 * lands inside the prefix and an absolute one asks the proxy for the root of the
 * host, which under #771's Traefik rule is outside the application entirely.
 */
describe("the web app manifest", () => {
    const manifest = JSON.parse(readSource("client/public/manifest.json"));

    it("asks for its icons relative to itself", () => {
        for (const icon of manifest.icons)
            assert.ok(!icon.src.startsWith("/"),
                `${icon.src} is fetched from the root of the host, so the installed app has no icon`);
    });

    // "." is the directory the manifest sits in, which is the prefix. An
    // absolute one would launch the installed app outside the application.
    it("starts the installed app where the manifest was served from", () => {
        assert.ok(!manifest.start_url.startsWith("/"),
            `start_url ${manifest.start_url} launches at the root of the host`);
    });
});
