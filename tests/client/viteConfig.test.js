import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The build config's own address, spelled so it survives becoming a module.
 *
 * The alias resolved against a bare __dirname, which exists only while the
 * config is loaded as CommonJS - true today solely because client/package.json
 * declares no "type". The day that field is added, the first casualty is the
 * build config itself, with an error naming a variable nobody wrote recently.
 * fileURLToPath(import.meta.url) says the same thing in both module systems,
 * and the bundled config shims it either way.
 */
const ROOT = path.resolve(fileURLToPath(import.meta.url), "..", "..", "..");

const read = (file) => fs.readFileSync(path.join(ROOT, file), "utf8");

describe("the vite config", () => {
    const config = read("client/vite.config.js");

    it("derives its own directory instead of assuming CommonJS", () => {
        assert.match(config, /fileURLToPath\(import\.meta\.url\)/,
            "the config's directory comes from nowhere the moment the client becomes a module");
        assert.doesNotMatch(config, /__dirname/,
            "a bare __dirname is undefined the day client/package.json declares a type");
    });
});
