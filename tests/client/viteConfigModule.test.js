import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(fileURLToPath(import.meta.url), "..", "..", "..");
const CLIENT = path.join(ROOT, "client");

/**
 * The client's Vite config has to be loadable as what it is written as.
 *
 * It is written in ESM - `import`/`export default` - but the root package.json's
 * `"type": "module"` does not reach into `client/`, which declares no type of
 * its own. So a plain `vite.config.js` there is a CommonJS file holding ESM, and
 * every build printed:
 *
 *   Your Vite config uses features that are unsupported by `configLoader:
 *   'native'` - ESM syntax in a file loaded as CommonJS (vite.config.js:1:1).
 *
 * Vite bundles the config first today, which is why it works at all. That
 * warning says the native loader is "planned to become the default in a future
 * major version", and when it is, this stops being a warning: the config fails
 * to load and the build has no alias, no plugins and no PWA - which is the
 * failure that arrives on a routine dependency bump rather than on a change
 * anybody made.
 *
 * Either answer settles it. The extension is the one taken, because the
 * alternative edits client/package.json, and a package.json change here means
 * the frozen install in CI has to agree about the lockfile - a much larger thing
 * to risk for a file-loading question.
 */
describe("the client's vite config", () => {
    const configs = fs.readdirSync(CLIENT).filter((name) => /^vite\.config\.[cm]?[jt]s$/.test(name));

    it("is there to be found", () => {
        assert.deepEqual(configs.length, 1,
            `expected exactly one vite config in client/, found ${configs.join(", ") || "none"}`);
    });

    it("is loaded as an ES module rather than as CommonJS holding ESM", () => {
        const [config] = configs;
        const declaresModule = JSON.parse(
            fs.readFileSync(path.join(CLIENT, "package.json"), "utf8")).type === "module";

        assert.ok(/\.m[jt]s$/.test(config) || declaresModule,
            `${config} is written in ESM but client/package.json declares no "type", so vite loads it as `
            + "CommonJS - a warning today and a build with no config at all once the native loader is the default");
    });

    // The reason the extension was the answer: were the type declared instead,
    // every other .js in client/ would become an ES module with it.
    it("leaves the rest of the client's module resolution alone", () => {
        const declared = JSON.parse(fs.readFileSync(path.join(CLIENT, "package.json"), "utf8"));

        if (declared.type === "module") return;

        assert.match(configs[0], /\.m[jt]s$/,
            "neither answer is in place, so the config is still ESM in a CommonJS file");
    });

    /**
     * And it reaches for nothing CommonJS-only, which the extension alone does
     * not settle.
     *
     * Renaming the file surfaced a second warning the first had been hiding:
     * `__dirname` at the alias. It resolved only because Vite bundles the config
     * before running it - under the native loader that global is undefined, and
     * the "@/" alias every client import depends on would resolve against
     * nothing. One warning replacing another is how that stayed invisible.
     */
    it("reaches for nothing that only exists in CommonJS", () => {
        const source = fs.readFileSync(path.join(CLIENT, configs[0]), "utf8");

        for (const global of ["__dirname", "__filename", "require(", "module.exports"])
            assert.ok(!source.includes(global),
                `the config uses ${global}, which is not defined in an ES module - `
                + "it survives only because vite bundles the config before running it");
    });
});
