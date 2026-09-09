import { it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { readSource } from "../helpers/source.js";

const TIMEOUT = 20_000;
const ENGINE_FAILURE = 43;
const GUARD_FAILURE = 99;
const bash = ["C:/Program Files/Git/bin/bash.exe", "bash", "/usr/bin/bash"]
    .find((candidate) => spawnSync(candidate, ["-c", "exit 0"], {timeout: TIMEOUT}).status === 0);
const posix = (value) => value.replaceAll("\\", "/").replace(/^([A-Za-z]):/, (_, drive) => `/${drive.toLowerCase()}`);

const install = (t, engineStatus, compose = true) => {
    const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "myspeed-docker-install-")));
    t.after(() => fs.rmSync(root, {recursive: true, force: true}));
    const bin = path.join(root, "bin");
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, "curl"), `#!/bin/sh
printf '%s\\n' '#!/bin/sh' 'if [ "$ENGINE_STATUS" != 0 ]; then exit "$ENGINE_STATUS"; fi' 'touch "$SANDBOX/installed"' > "$3"
`, {mode: 0o755});
    fs.writeFileSync(path.join(bin, "docker"), `#!/bin/sh
echo "$*" >> "$SANDBOX/calls"
[ "$*" = "compose version" ] && [ "$COMPOSE" = false ] && exit 1
exit 0
`, {mode: 0o755});
    const prefix = `export PATH="$SANDBOX/bin:$PATH"
command() {
    if [ "$*" = "-v docker" ] && [ ! -f "$SANDBOX/installed" ]; then return 1; fi
    builtin command "$@"
}
mktemp() { /bin/mktemp "$SANDBOX/engine.XXXXXX"; }
[ "$(command -v curl)" = "$SANDBOX/bin/curl" ] || exit ${GUARD_FAILURE}
`;
    const script = path.join(root, "install.sh");
    fs.writeFileSync(script, prefix + readSource("scripts/docker-install.sh")
        .replace("if [ $EUID -ne 0 ]; then", "if false; then")
        .replaceAll("/opt/myspeed-dockerized", `${posix(root)}/installation`));
    const result = spawnSync(bash, [script], {encoding: "utf8", timeout: TIMEOUT,
        env: {...process.env, SANDBOX: posix(root), ENGINE_STATUS: String(engineStatus), COMPOSE: String(compose)}});
    assert.ifError(result.error);
    return {status: result.status, output: result.stdout + result.stderr,
        calls: fs.existsSync(path.join(root, "calls")) ? fs.readFileSync(path.join(root, "calls"), "utf8") : "",
        downloads: fs.readdirSync(root).filter((file) => file.startsWith("engine."))};
};

it("reports a failed engine installer before any Compose call and removes its download", {skip: !bash}, (t) => {
    const result = install(t, ENGINE_FAILURE);
    assert.equal(result.status, 1);
    assert.match(result.output, /Docker installer failed/i);
    assert.equal(result.calls, "");
    assert.deepEqual(result.downloads, []);
});

it("continues a successful engine installation through pull and start", {skip: !bash}, (t) => {
    const result = install(t, 0);
    assert.equal(result.status, 0, result.output);
    assert.match(result.calls, /compose version[\s\S]*compose pull[\s\S]*compose up -d/);
    assert.deepEqual(result.downloads, []);
});

it("still identifies a missing Compose plugin after a successful engine installation", {skip: !bash}, (t) => {
    const result = install(t, 0, false);
    assert.equal(result.status, 1);
    assert.match(result.output, /Compose plugin is not/);
    assert.doesNotMatch(result.calls, /compose pull/);
});
