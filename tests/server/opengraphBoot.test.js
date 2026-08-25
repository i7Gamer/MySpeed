import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readSource, withoutJsComments } from "../helpers/source.js";

const controller = withoutJsComments(readSource("server/controller/opengraph.js"));
const route = withoutJsComments(readSource("server/routes/opengraph.js"));
const app = withoutJsComments(readSource("server/app.js"));

/**
 * An endpoint nobody has to use must not be able to stop the server starting.
 *
 * resvg is a native addon. Its loader resolves a platform-specific `.node` at
 * require time and throws if the build that shipped does not carry the one for
 * the machine it is running on — which is a live risk, because MySpeed-macos-x64
 * is cross-compiled and the bindings are optional dependencies installed by host
 * architecture, not by target.
 *
 * The chain that made that fatal was entirely static: server/app.js imports
 * routes/opengraph.js, which imports controller/opengraph.js, which imported
 * '@resvg/resvg-js' at its top. So the throw happened while the route table was
 * still being assembled, before anything listened — a server that would not boot,
 * reporting a missing native binding and not mentioning MySpeed.
 *
 * Deferred to first use, the same fault is caught by the handler, which already
 * answers every failure by redirecting to the project banner. The preview image
 * falls back to a static one and the instance runs.
 *
 * Asserted against the source, like the integration icon registry it resembles:
 * what matters is the shape of the import, and a test that called the renderer
 * would prove the opposite thing — that it works when the binding IS present.
 */
describe("the opengraph renderer", () => {
    it("is still reached from the route table at startup", () => {
        assert.match(app, /import\s+opengraphRoutes\s+from\s+['"]\.\/routes\/opengraph\.js['"]/,
            "the premise changed - opengraph is no longer mounted, so this test guards nothing");
        assert.match(route, /import\s+generateOpenGraphImage\s+from\s+['"]\.\.\/controller\/opengraph\.js['"]/,
            "the route no longer imports the controller");
    });

    it("does not load the native renderer while the route table is built", () => {
        assert.doesNotMatch(controller, /^\s*import\s[^\n]*['"]@resvg\/resvg-js['"]/m,
            "resvg is imported at the top of the controller again, so a missing binding is a boot failure");
    });

    it("loads it when an image is actually asked for", () => {
        assert.match(controller, /import\(\s*['"]@resvg\/resvg-js['"]\s*\)/,
            "nothing loads resvg at all - the renderer cannot work");
    });

    /**
     * The fallback the deferral relies on. Without it a first request would
     * answer 500 rather than a banner, and moving the import would have traded a
     * dead server for a dead endpoint.
     */
    it("still answers a render failure with the banner rather than an error", () => {
        assert.match(route, /catch\s*\(\s*error\s*\)\s*\{[\s\S]*?res\.redirect\(BANNER_URL\)/,
            "the handler no longer falls back to the banner, so a missing binding surfaces as a 500");
    });
});
