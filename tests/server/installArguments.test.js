import { it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { readSource } from "../helpers/source.js";

const TIMEOUT_MS = 10_000;
const bash = ["C:/Program Files/Git/bin/bash.exe", "bash", "/usr/bin/bash"]
    .find(candidate => spawnSync(candidate, ["-c", "exit 0"], {timeout: TIMEOUT_MS}).status === 0);
const noBash = !bash && "no compatible Bash; Linux CI must execute installer argument regressions";
const posix = value => value.replaceAll("\\", "/").replace(/^([A-Za-z]):/, (_, drive) => `/${drive.toLowerCase()}`);

// Execute the actual parser and path normalization, ending before the first
// dependency check. No installer tail can run, even if a refusal regresses.
const parse = (t, args) => {
    const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "myspeed-install-args-")));
    t.after(() => fs.rmSync(root, {recursive: true, force: true}));
    const source = readSource("scripts/install.sh");
    const boundary = source.indexOf("if command -v systemctl");
    assert.ok(boundary > 0, "isolation boundary must exist");
    const script = path.join(root, "parse.sh");
    fs.writeFileSync(script, source.slice(0, boundary) + '\nprintf "PARSED=%s\\n" "$INSTALLATION_PATH"\n');
    const result = spawnSync(bash, [posix(script), ...args], {cwd: root, encoding: "utf8", timeout: TIMEOUT_MS});
    assert.ifError(result.error);
    return {...result, root: posix(root), output: result.stdout + result.stderr};
};

for (const args of [["-p"], ["--unknown"], ["-d"], ["-d", ""], ["-d", "--help"], ["-d", "-bad"],
    ["-d-bad"], ["extra"], ["-d", "/tmp/example", "extra"], ["--", "extra"]]) {
    it(`installer refuses ${JSON.stringify(args)} before proceeding`, {skip: noBash}, t => {
        const result = parse(t, args);
        assert.equal(result.status, 1, result.output);
        assert.doesNotMatch(result.output, /PARSED=/);
        assert.equal((result.output.match(/Installation Error:/g) || []).length, 1, result.output);
    });
}

for (const option of ["-h", "--help"]) {
    it(`installer ${option} is usage-only success`, {skip: noBash}, t => {
        const result = parse(t, [option]);
        assert.equal(result.status, 0, result.output);
        assert.match(result.output, /Usage: install\.sh/);
        assert.doesNotMatch(result.output, /PARSED=/);
    });
}

for (const [args, expected] of [[[], "/opt/myspeed"], [["--"], "/opt/myspeed"],
    [["-d", "/tmp/with spaces"], "/tmp/with spaces"], [["-d/tmp/attached"], "/tmp/attached"],
    [["-d", "/tmp/first", "-d/tmp/last"], "/tmp/last"], [["-d", "/tmp/example", "--"], "/tmp/example"]]) {
    it(`installer preserves ${JSON.stringify(args)}`, {skip: noBash}, t => {
        const result = parse(t, args);
        assert.equal(result.status, 0, result.output);
        assert.ok(result.output.includes(`PARSED=${expected}\n`), result.output);
    });
}

it("installer permits an explicitly relative dash-prefixed directory", {skip: noBash}, t => {
    const result = parse(t, ["-d", "./-name"]);
    assert.equal(result.status, 0, result.output);
    assert.ok(result.output.includes(`PARSED=${result.root}/./-name\n`), result.output);
});
