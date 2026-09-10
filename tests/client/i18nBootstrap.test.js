import {after, it} from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {build} from "esbuild";
import {window} from "../helpers/domGlobals.js";

// The component loader replaces @/i18n. Bundle the actual bootstrap here so its
// detector, supported codes, resource loading and document subscription execute.
// Only Vite's flag glob is replaced; locale HTTP requests use local file fixtures.
const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const originalFetch = globalThis.fetch;
const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
const requests = [];
globalThis.fetch = async url => {
    const pathname = String(url);
    const match = /^\/assets\/locales\/([a-z-]+)\.json$/.exec(pathname);
    assert.ok(match, `unexpected request: ${pathname}`);
    requests.push(match[1]);
    return new Response(await fs.readFile(path.join(ROOT, "client/public/assets/locales", `${match[1]}.json`)));
};

const built = await build({
    absWorkingDir: ROOT, entryPoints: ["client/src/i18n.js"], bundle: true,
    write: false, format: "esm", platform: "browser", alias: {"@": path.join(ROOT, "client/src")},
    define: {"process.env.NODE_ENV": '"test"'},
    plugins: [{name: "vite-flags-only", setup(builder) {
        builder.onLoad({filter: /[/\\]client[/\\]src[/\\]i18n\.js$/}, async ({path: filename}) => ({
            contents: (await fs.readFile(filename, "utf8")).replace(/import\.meta\.glob\([^;]+\)/, "{}"),
            loader: "js"
        }));
    }}]
});
const moduleUrl = `data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString("base64")}`;
let bootCount = 0;
const boot = async () => {
    const {default: i18n, languages} = await import(`${moduleUrl}#${bootCount++}`);
    if (!i18n.isInitialized) await new Promise(resolve => i18n.on("initialized", resolve));
    return {i18n, languages};
};

after(() => {
    globalThis.fetch = originalFetch;
    Object.defineProperty(globalThis, "navigator", originalNavigator);
    window.localStorage.clear();
});

it("activates every shipped code and keeps both Chinese variants across reload", async () => {
    window.localStorage.setItem("language", "en");
    const {i18n, languages} = await boot();
    for (const {code} of languages) {
        await i18n.changeLanguage(code);
        const resource = JSON.parse(await fs.readFile(path.join(ROOT, "client/public/assets/locales", `${code}.json`)));
        assert.equal(i18n.language, code);
        assert.equal(window.document.documentElement.lang, code);
        assert.equal(i18n.t("dropdown.language_changed"), resource.dropdown.language_changed);
    }
    for (const code of ["zh", "zh-tw"]) {
        await i18n.changeLanguage(code);
        window.localStorage.setItem("language", code);
        const reloaded = await boot();
        assert.equal(reloaded.i18n.language, code);
        assert.equal(reloaded.i18n.resolvedLanguage, code);
        assert.equal(window.document.documentElement.lang, code);
    }
    assert.ok(requests.includes("zh-tw"));
    assert.ok(!requests.includes("en"), "bundled English must not require a request");
});

it("seeds a regional Traditional Chinese browser with the exact shipped variant", async () => {
    window.localStorage.clear();
    Object.defineProperty(globalThis, "navigator", {configurable: true, value: {language: "zh-TW"}});
    const {i18n} = await boot();
    assert.equal(i18n.language, "zh-tw");
    assert.equal(i18n.resolvedLanguage, "zh-tw");
    assert.equal(window.document.documentElement.lang, "zh-tw");
});
