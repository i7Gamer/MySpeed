import {it} from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {spawnSync} from "node:child_process";
import {parse} from "yaml";
import {readSource} from "../helpers/source.js";

const BUN_BINARY = process.env.MYSPEED_BUN_BINARY;
const BUILD_TIMEOUT_MS = 30_000;
const MARKER = "client-build-ran";
const workflow = parse(readSource(".github/workflows/test.yml"));

it("the CI renderer-preparation command executes the client build script", {skip: !BUN_BINARY}, () => {
    const preparation = workflow.jobs.test.steps.find(step => step.name === "Prepare compiled renderer test");
    const command = preparation.run.split("\n").map(line => line.trim())
        .find(line => /^bun\s+.*\bbuild$/.test(line));
    assert.ok(command, "renderer preparation has no client build command");
    const [executable, ...args] = command.split(/\s+/);
    assert.equal(executable, "bun");

    const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "myspeed-ci-client-build-"));
    const client = path.join(fixture, "client");
    try {
        fs.mkdirSync(client);
        fs.writeFileSync(path.join(client, "package.json"), JSON.stringify({
            name: "synthetic-build-fixture",
            scripts: {build: "bun build-fixture.mjs"},
        }));
        fs.writeFileSync(path.join(client, "build-fixture.mjs"),
            `import fs from "node:fs"; fs.writeFileSync("build-marker.txt", ${JSON.stringify(MARKER)});`);

        const result = spawnSync(BUN_BINARY, args, {
            cwd: fixture,
            encoding: "utf8",
            timeout: BUILD_TIMEOUT_MS,
            env: {
                PATH: `${path.dirname(BUN_BINARY)}${path.delimiter}${process.env.PATH ?? ""}`,
                SystemRoot: process.env.SystemRoot,
                WINDIR: process.env.WINDIR,
                TEMP: process.env.TEMP,
                TMP: process.env.TMP,
            },
        });
        assert.equal(result.status, 0, `${result.error ?? ""}\n${result.stdout}\n${result.stderr}`);
        const marker = path.join(client, "build-marker.txt");
        assert.ok(fs.existsSync(marker), "Bun returned successfully without running the client build script");
        assert.equal(fs.readFileSync(marker, "utf8"), MARKER);
        assert.equal(fs.existsSync(path.join(fixture, "build-marker.txt")), false,
            "the client build ran in the repository root instead of client/");
    } finally {
        fs.rmSync(fixture, {recursive: true, force: true});
    }
});
