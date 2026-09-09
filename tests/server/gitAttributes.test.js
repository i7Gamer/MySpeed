import {describe, it} from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {execFileSync} from "node:child_process";
import {readSource} from "../helpers/source.js";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const FILES = ["scripts/install.sh", "Dockerfile", ".github/workflows/test.yml", "example.yaml"];
const ATTRIBUTES = readSource(".gitattributes");
const git = (directory, ...args) => execFileSync("git", args, {cwd: directory, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"]});
const assertLf = directory => {
    const fields = git(directory, "check-attr", "-z", "text", "eol", "--", ...FILES).split("\0");
    const ATTRIBUTE_RECORD_FIELDS = 3;
    for (let index = 0; index < fields.length - 1; index += ATTRIBUTE_RECORD_FIELDS) {
        const [file, attribute, value] = fields.slice(index, index + ATTRIBUTE_RECORD_FIELDS);
        if (attribute === "eol") assert.equal(value, "lf", `${file} ${attribute}`);
        else assert.ok(["set", "auto"].includes(value), `${file} ${attribute} must remain text`);
    }
};
const fixture = run => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "myspeed-attributes-"));
    try {
        git(directory, "init", "--quiet");
        git(directory, "config", "core.autocrlf", "true");
        fs.writeFileSync(path.join(directory, ".gitattributes"), ATTRIBUTES);
        run(directory);
    } finally { fs.rmSync(directory, {recursive: true, force: true}); }
};

describe("Git line-ending configuration", () => {
    it("keeps shell, Docker and YAML paths LF in the actual checkout", () => assertLf(ROOT));
    it("normalizes CRLF input in the index while autocrlf is enabled", () => fixture(directory => {
        assertLf(directory);
        for (const file of FILES) {
            const target = path.join(directory, file);
            fs.mkdirSync(path.dirname(target), {recursive: true});
            fs.writeFileSync(target, "first\r\nsecond\r\n");
        }
        git(directory, "add", "--", ".gitattributes", ...FILES);
        for (const file of FILES) assert.equal(git(directory, "show", `:${file}`), "first\nsecond\n");
    }));
    it("detects a removed shell rule", () => fixture(directory => {
        fs.writeFileSync(path.join(directory, ".gitattributes"), ATTRIBUTES.replace("*.sh text eol=lf", ""));
        assert.throws(() => assertLf(directory), /scripts\/install\.sh/);
    }));
    it("detects a more specific override", () => fixture(directory => {
        fs.writeFileSync(path.join(directory, ".gitattributes"), ATTRIBUTES + "\nscripts/install.sh -text eol=crlf\n");
        assert.throws(() => assertLf(directory), /scripts\/install\.sh/);
    }));
});
