import { it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { readSource } from "../helpers/source.js";

const TIMEOUT = 20_000;
const GUARD_FAILURE = 97;
// Prefer Git Bash when installed: Windows' bash.exe can be a WSL launcher,
// which accepts -c but cannot open the native temporary paths passed below.
const bash = ["C:/Program Files/Git/bin/bash.exe", "bash", "/usr/bin/bash"]
    .find((candidate) => spawnSync(candidate, ["-c", "exit 0"], {timeout: TIMEOUT}).status === 0);
const posix = (value) => value.replaceAll("\\", "/").replace(/^([A-Za-z]):/, (_, drive) => `/${drive.toLowerCase()}`);

const upgrade = (t, failure = "", active = true) => {
    const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "myspeed-upgrade-")));
    t.after(() => fs.rmSync(root, {recursive: true, force: true}));
    const bin = path.join(root, "bin");
    const installation = path.join(root, "installation");
    fs.mkdirSync(bin);
    fs.mkdirSync(installation);
    fs.writeFileSync(path.join(installation, "myspeed"), "old binary");
    if (active) fs.writeFileSync(path.join(root, "active"), "");
    const stub = (name, body) => fs.writeFileSync(path.join(bin, name), `#!/bin/sh\n${body}\n`, {mode: 0o755});
    for (const name of ["apt-get", "chown", "useradd"]) stub(name, "exit 0");
    stub("id", "echo 999");
    stub("uname", "echo aarch64");
    stub("curl", `case "$*" in
  *api.github.com*)
    [ "$FAILURE" = api ] && exit 1
    if [ "$FAILURE" = asset ]; then echo '{"browser_download_url":"https://example.test/other"}'
    else echo '{"browser_download_url":"https://example.test/MySpeed-linux-arm64","browser_download_url":"https://example.test/SHA256SUMS"}'; fi ;;
  *SHA256SUMS*)
    if [ "$FAILURE" = checksum ]; then echo 'bad MySpeed-linux-arm64'
    else echo 'valid MySpeed-linux-arm64'; fi ;;
  *) echo 192.0.2.1 ;;
esac`);
    stub("wget", `echo download >> "$SANDBOX/calls"
[ "$FAILURE" = download ] && exit 1
[ "$FAILURE" = empty ] && { : > "$3"; exit 0; }
echo 'new binary' > "$3"`);
    stub("sha256sum", "echo valid");
    stub("chmod", `[ "$FAILURE" = chmod ] && exit 1
exit 0`);
    stub("mv", `echo move >> "$SANDBOX/calls"
[ "$FAILURE" = move ] || [ "$FAILURE" = recovery ] && exit 1
exec /bin/mv "$@"`);
    stub("systemctl", `echo "$*" >> "$SANDBOX/calls"
case "$1" in
  --all) echo 'myspeed.service loaded active' ;;
  is-active) [ -f "$SANDBOX/active" ] ;;
  stop)
    rm -f "$SANDBOX/active"
    [ "$FAILURE" != stop ] ;;
  start|restart)
    [ "$FAILURE" = recovery ] && exit 1
    touch "$SANDBOX/active" ;;
esac`);
    let source = readSource("scripts/install.sh");
    const rewrites = [
        ["if [ $EUID -ne 0 ]; then", "if false; then"],
        ["/etc/systemd/system/myspeed.service", `${posix(root)}/myspeed.service`]
    ];
    for (const [from, to] of rewrites) {
        assert.ok(source.includes(from), `installer sandbox anchor missing: ${from}`);
        source = source.replaceAll(from, to);
    }
    source = source
        .replace(/^(\s*)sleep \d+$/gm, "$1:")
        .replace(/^(\s*)clear$/gm, "$1:");
    source = 'export PATH="$SANDBOX/bin:$PATH"\n'
        + 'for mocked in apt-get chown useradd id uname curl wget sha256sum chmod mv systemctl; do\n'
        + ` [ "$(command -v "$mocked")" = "$SANDBOX/bin/$mocked" ] || exit ${GUARD_FAILURE}\ndone\n`
        + source;
    const script = path.join(root, "install.sh");
    fs.writeFileSync(script, source);
    const result = spawnSync(bash, [script, "-d", posix(installation)], {
        env: {...process.env, SANDBOX: posix(root), FAILURE: failure}, encoding: "utf8", timeout: TIMEOUT
    });
    assert.ifError(result.error);
    const calls = fs.existsSync(path.join(root, "calls")) ? fs.readFileSync(path.join(root, "calls"), "utf8") : "";
    return {status: result.status, output: result.stdout + result.stderr, calls,
        binary: fs.readFileSync(path.join(installation, "myspeed"), "utf8").trim(),
        active: fs.existsSync(path.join(root, "active"))};
};

for (const failure of ["api", "asset", "download", "empty", "checksum", "chmod"]) {
    it(`keeps the working service and binary when ${failure} fails`, {skip: !bash && "Bash unavailable"}, (t) => {
        const result = upgrade(t, failure);
        assert.equal(result.status, 1, result.output);
        assert.equal(result.binary, "old binary");
        assert.equal(result.active, true, result.calls);
        assert.doesNotMatch(result.calls, /stop|move|start/);
    });
}

for (const failure of ["stop", "move"]) {
    for (const active of [true, false]) {
        it(`recovers only a previously active service after ${failure} fails (${active})`, {skip: !bash && "Bash unavailable"}, (t) => {
            const result = upgrade(t, failure, active);
            assert.equal(result.status, 1, result.output);
            assert.equal(result.binary, "old binary");
            assert.equal(result.active, active, result.calls);
            if (failure === "stop") assert.doesNotMatch(result.calls, /move/);
            if (!active) assert.doesNotMatch(result.calls, /start/);
            assert.doesNotMatch(result.output, /Installation completed/);
        });
    }
}

it("reports failed recovery without replacing the old binary", {skip: !bash && "Bash unavailable"}, (t) => {
    const result = upgrade(t, "recovery");
    assert.equal(result.status, 1);
    assert.equal(result.binary, "old binary");
    assert.equal(result.active, false);
    assert.match(result.output, /could not restart|failed to restart/i);
});

it("stops only after download and restarts after replacement", {skip: !bash && "Bash unavailable"}, (t) => {
    const result = upgrade(t);
    assert.equal(result.status, 0, result.output);
    assert.equal(result.binary, "new binary");
    assert.equal(result.active, true);
    assert.match(result.calls, /download[\s\S]*stop myspeed[\s\S]*move[\s\S]*restart myspeed/);
});
