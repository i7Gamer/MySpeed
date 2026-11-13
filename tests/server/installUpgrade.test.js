import { it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { readSource } from "../helpers/source.js";
import {INSTALL_SANDBOX_TIMEOUT as TIMEOUT, installSandbox as upgrade,
    sandboxBash as bash} from "../helpers/installSandbox.js";

for (const failure of ["api", "asset", "download", "empty", "checksum", "chmod", "backup", "mktemp"]) {
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

for (const failure of ["restart", "health"]) {
    it(`retains the previous executable and stops the failed upgrade after ${failure}`, {skip: !bash}, (t) => {
        const result = upgrade(t, failure);
        assert.equal(result.status, 1, result.output);
        assert.deepEqual(result.backups, ["old binary"]);
        assert.equal(result.binary, "new binary", "old code must not run over a possibly migrated database");
        assert.equal(result.active, false);
        assert.match(result.output, /manual|migration|database/i);
        assert.doesNotMatch(result.calls, /\nstart myspeed/);
    });
}

it("a second failed attempt retains the first known-good recovery artifact", {skip: !bash}, (t) => {
    const result = upgrade(t, "restart", true, {attempts: 2});
    assert.equal(result.status, 1);
    assert.ok(result.backups.includes("old binary"));
});

for (const failure of ["data-directory", "data-mode", "binary-directory", "ownership", "unit", "reload"]) {
    for (const active of [true, false]) {
        it(`restores the executable and service definition after pre-execution ${failure} failure (active=${active})`, {skip: !bash}, (t) => {
            const result = upgrade(t, failure, active);
            assert.equal(result.status, 1, result.output);
            assert.equal(result.binary, "old binary");
            assert.equal(result.unit, "old service");
            assert.equal(result.active, active);
            assert.doesNotMatch(result.calls, /restart myspeed/);
        });
    }
}

it("recovers an upgrade when securing an existing data directory fails", {skip: !bash}, (t) => {
    const result = upgrade(t, "data-mode", true, {existingData: true});
    assert.equal(result.status, 1, result.output);
    assert.equal(result.binary, "old binary");
    assert.equal(result.unit, "old service");
    assert.equal(result.active, true);
    assert.doesNotMatch(result.calls, /restart myspeed/);
});

it("does not start a failed first installation when its data directory cannot be created", {skip: !bash}, (t) => {
    const result = upgrade(t, "data-directory", false, {fresh: true});
    assert.equal(result.status, 1, result.output);
    assert.equal(result.active, false);
    assert.equal(result.unit, null);
    assert.deepEqual(result.backups, []);
    assert.doesNotMatch(result.calls, /(?:^|\n)(?:re)?start myspeed/);
});

it("a successful first installation needs no previous executable", {skip: !bash}, (t) => {
    const result = upgrade(t, "", false, {fresh: true});
    assert.equal(result.status, 0, result.output);
    assert.equal(result.binary, "new binary");
    assert.deepEqual(result.backups, []);
});

it("uses the service account for a traversable installation fixture", {skip: !bash}, (t) => {
    const result = upgrade(t);
    assert.equal(result.status, 0, result.output);
    assert.match(result.unit, /^User=myspeed$/m);
    assert.doesNotMatch(result.output, /cannot be reached/);
});

for (const failure of ["", "binary-directory", "ownership"]) {
    it(`preserves the root fallback for an inaccessible installation (${failure || "success"})`, {skip: !bash}, (t) => {
        const result = upgrade(t, failure, true, {reachable: false});
        assert.equal(result.status, 0, result.output);
        assert.match(result.unit, /^User=root$/m);
        assert.match(result.output, /cannot be reached by an unprivileged account/);
        assert.equal(result.binary, "new binary");
        assert.equal(result.active, true);
    });
}

it("uses each systemd directive's path syntax and preserves percent and dollar literals", {skip: !bash}, (t) => {
    const result = upgrade(t, "", true, {name: "my speed %test $box"});
    assert.equal(result.status, 0, result.output);
    const escaped = result.installation.replaceAll("%", "%%");
    assert.ok(result.unit.includes(`ExecStart=:"${escaped}/myspeed"`));
    // config_parse_working_directory expands specifiers but does not unquote
    // or unescape its value. Quoting even an ordinary path makes it relative.
    assert.ok(result.unit.includes("# MySpeed-WorkingDirectory-Encoding: percent-v1\n"
        + `WorkingDirectory=${escaped}\n`));
    assert.ok(result.unit.includes(`ReadWritePaths="${escaped}"`));
});

it("keeps an ordinary WorkingDirectory absolute without quote characters", {skip: !bash}, (t) => {
    const result = upgrade(t);
    assert.equal(result.status, 0, result.output);
    const value = result.unit.split("\n").find((line) => line.startsWith("WorkingDirectory=")).split("=")[1];
    assert.equal(value, result.installation);
    assert.equal(value[0], "/");
});

// systemd rejects these executable-path characters even after quoted-word
// decoding. Exercise preflight only, so Windows need not create such paths.
for (const directory of ["/opt/my\\speed", '/opt/my"speed', "/opt/my'speed",
    "/opt/my\nspeed", "/opt/my\tspeed", "/opt/myspeed "]) {
    it(`refuses an unrepresentable systemd path before install work: ${JSON.stringify(directory)}`, {skip: !bash}, (t) => {
        const source = readSource("scripts/install.sh").split("if [ $EUID -ne 0 ]; then")[0];
        const root = fs.mkdtempSync(path.join(os.tmpdir(), "myspeed-path-"));
        t.after(() => fs.rmSync(root, {recursive: true, force: true}));
        const script = path.join(root, "preflight.sh");
        fs.writeFileSync(script, `systemctl() { :; }\nset -- -d "$TEST_INSTALLATION_PATH"\n${source}`);
        const result = spawnSync(bash, [script], {
            env: {...process.env, TEST_INSTALLATION_PATH: directory}, encoding: "utf8", timeout: TIMEOUT
        });
        assert.ifError(result.error);
        assert.equal(result.status, 1, result.stdout + result.stderr);
        assert.match(result.stdout, /installation path.*systemd/i);
    });
}

it("preserves manual-install paths when systemd is unavailable", {skip: !bash}, (t) => {
    const source = readSource("scripts/install.sh").split("if [ $EUID -ne 0 ]; then")[0];
    // Shadow command only for the systemd availability check.
    const withoutSystemd = 'command() { if [ "$1" = -v ] && [ "$2" = systemctl ]; then return 1; fi; builtin command "$@"; }\n';
    const directory = '/opt/my "quoted"\\speed ';
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "myspeed-path-"));
    t.after(() => fs.rmSync(root, {recursive: true, force: true}));
    const script = path.join(root, "preflight.sh");
    fs.writeFileSync(script, `${withoutSystemd}set -- -d "$TEST_INSTALLATION_PATH"\n${source}\nprintf '%s' "$INSTALLATION_PATH"`);
    const result = spawnSync(bash, [script], {
        env: {...process.env, TEST_INSTALLATION_PATH: directory}, encoding: "utf8", timeout: TIMEOUT
    });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(result.stdout, directory);
});

it("stops only after download and restarts after replacement", {skip: !bash && "Bash unavailable"}, (t) => {
    const result = upgrade(t);
    assert.equal(result.status, 0, result.output);
    assert.equal(result.binary, "new binary");
    assert.equal(result.active, true);
    assert.match(result.calls, /download[\s\S]*stop myspeed[\s\S]*move[\s\S]*restart myspeed/);
});

it("names the download unpredictably, beside the binary, and leaves nothing behind", {skip: !bash && "Bash unavailable"}, (t) => {
    const result = upgrade(t);
    assert.equal(result.status, 0, result.output);
    assert.equal(result.binary, "new binary");
    assert.deepEqual(result.leftovers, [], "a download temp file survived the rename");
});

it("takes the installation root back from a service-owned directory without recursing", {skip: !bash && "Bash unavailable"}, (t) => {
    const result = upgrade(t, "", true, {serviceOwned: true});
    assert.equal(result.status, 0, result.output);
    assert.match(result.calls, new RegExp(`chown root ${result.installation}\n`));
    assert.doesNotMatch(result.calls, /chown -\w*R\w* root/);
    assert.match(result.output, /owned by myspeed.*root/i);
    assert.ok(result.calls.indexOf("chown root") < result.calls.indexOf("download"),
        "the root was reclaimed after the download had started");
});

it("leaves a directory owned by anyone else alone", {skip: !bash && "Bash unavailable"}, (t) => {
    const result = upgrade(t);
    assert.equal(result.status, 0, result.output);
    assert.doesNotMatch(result.calls, /chown root/);
});

it("stops before downloading when the root cannot be taken back", {skip: !bash && "Bash unavailable"}, (t) => {
    const result = upgrade(t, "reclaim", true, {serviceOwned: true});
    assert.equal(result.status, 1, result.output);
    assert.match(result.output, /left untouched/i);
    assert.equal(result.binary, "old binary");
    assert.equal(result.active, true);
    assert.doesNotMatch(result.calls, /download|stop|move/);
});

it("a failing mktemp leaves the existing installation untouched and says so", {skip: !bash && "Bash unavailable"}, (t) => {
    const result = upgrade(t, "mktemp");
    assert.equal(result.status, 1, result.output);
    assert.match(result.output, /left untouched/i);
    assert.doesNotMatch(result.calls, /download/);
});

const ALLOW_UNVERIFIED = "--allow-unverified";
const FLAG_HINT = new RegExp(ALLOW_UNVERIFIED);

// The two ways a download cannot be checked at all, each with what the refusal
// has to tell the operator beyond the flag.
for (const [failure, mentions] of [["no-sums", /SHA256SUMS/], ["no-sha-tool", /sha256sum.*shasum.*openssl/]]) {
    it(`refuses an unverifiable download by default (${failure})`, {skip: !bash && "Bash unavailable"}, (t) => {
        const result = upgrade(t, failure);
        assert.equal(result.status, 1, result.output);
        assert.match(result.output, mentions);
        assert.match(result.output, FLAG_HINT, "the refusal does not name the way out");
        assert.match(result.output, /left untouched/i);
        assert.equal(result.binary, "old binary");
        assert.equal(result.active, true);
        assert.deepEqual(result.leftovers, [], "the unverified download was not removed");
        assert.doesNotMatch(result.calls, /stop|move|start/);
        assert.doesNotMatch(result.output, /Installation completed/);
    });

    it(`installs it with ${ALLOW_UNVERIFIED}, after warning (${failure})`, {skip: !bash && "Bash unavailable"}, (t) => {
        const result = upgrade(t, failure, true, {args: [ALLOW_UNVERIFIED]});
        assert.equal(result.status, 0, result.output);
        assert.match(result.output, /could not be verified/);
        assert.equal(result.binary, "new binary");
    });
}

it(`${ALLOW_UNVERIFIED} does not excuse a checksum mismatch`, {skip: !bash && "Bash unavailable"}, (t) => {
    const result = upgrade(t, "checksum", true, {args: [ALLOW_UNVERIFIED]});
    assert.equal(result.status, 1, result.output);
    assert.match(result.output, /does not match the checksum/);
    assert.equal(result.binary, "old binary");
    assert.deepEqual(result.leftovers, []);
});

// Fetching an existing SHA256SUMS can fail too; that leaves nothing to compare
// against and has to land in the hard "does not cover" refusal, not a warning.
it(`${ALLOW_UNVERIFIED} does not excuse a checksum list that cannot be fetched`, {skip: !bash && "Bash unavailable"}, (t) => {
    for (const args of [[], [ALLOW_UNVERIFIED]]) {
        const result = upgrade(t, "sums-unreachable", true, {args});
        assert.equal(result.status, 1, result.output);
        assert.match(result.output, /does not cover/);
        assert.equal(result.binary, "old binary");
        assert.deepEqual(result.leftovers, []);
    }
});
