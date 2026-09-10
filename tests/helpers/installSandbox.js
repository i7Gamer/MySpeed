import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {spawnSync} from "node:child_process";
import {readSource} from "./source.js";

export const INSTALL_SANDBOX_TIMEOUT = 20_000;
const GUARD_FAILURE = 97;

// Prefer Git Bash when installed: Windows' bash.exe can be a WSL launcher,
// which accepts -c but cannot open the native temporary paths passed below.
export const sandboxBash = ["C:/Program Files/Git/bin/bash.exe", "bash", "/usr/bin/bash"]
    .find((candidate) => spawnSync(candidate, ["-c", "exit 0"], {timeout: INSTALL_SANDBOX_TIMEOUT}).status === 0);

export const posixPath = (value) => value.replaceAll("\\", "/")
    .replace(/^([A-Za-z]):/, (_, drive) => `/${drive.toLowerCase()}`);

/** Run the complete installer against fake host commands and temporary paths. */
export const installSandbox = (t, failure = "", active = true, {
    fresh = false, existingData = false, reachable = true, attempts = 1, name = "installation"
} = {}) => {
    const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "myspeed-upgrade-")));
    t.after(() => fs.rmSync(root, {recursive: true, force: true}));
    const bin = path.join(root, "bin");
    const installation = path.join(root, name);
    fs.mkdirSync(bin);
    fs.mkdirSync(installation);
    if (existingData) fs.mkdirSync(path.join(installation, "data"));
    if (!fresh) fs.writeFileSync(path.join(installation, "myspeed"), "old binary");
    const unit = path.join(root, "myspeed.service");
    if (!fresh) fs.writeFileSync(unit, "old service");
    if (active) fs.writeFileSync(path.join(root, "active"), "");
    const stub = (name, body) => fs.writeFileSync(path.join(bin, name), `#!/bin/sh\n${body}\n`, {mode: 0o755});
    for (const name of ["apt-get", "useradd"]) stub(name, "exit 0");
    stub("chown", '[ "$FAILURE" != ownership ]');
    stub("mkdir", `case "$*" in
  */data) [ "$FAILURE" = data-directory ] && exit 1 ;;
  */bin) [ "$FAILURE" = binary-directory ] && exit 1 ;;
esac
exec /bin/mkdir "$@"`);
    stub("id", "echo 999");
    // Linux mkdtemp creates a private directory; Git Bash reports different
    // permissions. Control this host input so failure injection reaches the
    // intended account branch. Real traversal is covered by separate tests.
    stub("find", `[ "$2 $3 $4 $5" = "-maxdepth 0 -perm -o=x" ] || exit ${GUARD_FAILURE}
[ "$DIRECTORY_REACHABLE" = true ] && echo "$1"`);
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
case "$*" in */data) [ "$FAILURE" = data-mode ] && exit 1 ;; esac
exit 0`);
    stub("mv", `echo move >> "$SANDBOX/calls"
[ "$FAILURE" = move ] || [ "$FAILURE" = recovery ] && exit 1
exec /bin/mv "$@"`);
    stub("cp", `[ "$FAILURE" = backup ] && exit 1
exec /bin/cp "$@"`);
    stub("cat", `[ "$FAILURE" = unit ] && exit 1
exec /bin/cat "$@"`);
    stub("systemctl", `echo "$*" >> "$SANDBOX/calls"
case "$1" in
  --all) echo 'myspeed.service loaded active' ;;
  is-active)
    [ "$FAILURE" = health ] && [ -f "$SANDBOX/started" ] && exit 1
    [ -f "$SANDBOX/active" ] ;;
  daemon-reload)
    if [ "$FAILURE" = reload ] && [ ! -f "$SANDBOX/reloaded" ]; then touch "$SANDBOX/reloaded"; exit 1; fi ;;
  stop)
    rm -f "$SANDBOX/active"
    [ "$FAILURE" != stop ] ;;
  restart)
    touch "$SANDBOX/started"
    [ "$FAILURE" = restart ] && exit 1
    touch "$SANDBOX/active" ;;
  start)
    [ "$FAILURE" = recovery ] && exit 1
    touch "$SANDBOX/active" ;;
esac`);
    let source = readSource("scripts/install.sh");
    const rewrites = [
        ["if [ $EUID -ne 0 ]; then", "if false; then"],
        ["/etc/systemd/system/myspeed.service", `${posixPath(root)}/myspeed.service`]
    ];
    for (const [from, to] of rewrites) {
        assert.ok(source.includes(from), `installer sandbox anchor missing: ${from}`);
        source = source.replaceAll(from, to);
    }
    source = source
        .replace(/^(\s*)sleep \d+$/gm, "$1:")
        .replace(/^(\s*)clear$/gm, "$1:");
    source = 'export PATH="$SANDBOX/bin:$PATH"\n'
        + 'for mocked in apt-get chown useradd id find uname curl wget sha256sum chmod mkdir mv cp cat systemctl; do\n'
        + ` [ "$(command -v "$mocked")" = "$SANDBOX/bin/$mocked" ] || exit ${GUARD_FAILURE}\ndone\n`
        + source;
    const script = path.join(root, "install.sh");
    fs.writeFileSync(script, source);
    let result;
    for (let attempt = 0; attempt < attempts; attempt++) {
        result = spawnSync(sandboxBash, [script, "-d", posixPath(installation)], {
            env: {...process.env, SANDBOX: posixPath(root), FAILURE: failure,
                DIRECTORY_REACHABLE: String(reachable)},
            encoding: "utf8", timeout: INSTALL_SANDBOX_TIMEOUT
        });
        assert.ifError(result.error);
    }
    const calls = fs.existsSync(path.join(root, "calls")) ? fs.readFileSync(path.join(root, "calls"), "utf8") : "";
    return {status: result.status, output: result.stdout + result.stderr, calls,
        binary: fs.readFileSync(path.join(installation, "myspeed"), "utf8").trim(),
        backups: fs.readdirSync(installation).filter((file) => file.startsWith("myspeed.previous."))
            .map((file) => fs.readFileSync(path.join(installation, file), "utf8").trim()),
        unit: fs.existsSync(unit) ? fs.readFileSync(unit, "utf8") : null,
        installation: posixPath(installation), nativeInstallation: installation,
        active: fs.existsSync(path.join(root, "active"))};
};
