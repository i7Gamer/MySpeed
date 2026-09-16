import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {spawnSync} from "node:child_process";
import {after, describe, it} from "node:test";

import {
    WINPE_DIAGNOSTIC_CACHE_PROBES,
    WINPE_DIAGNOSTIC_EXIT_CODES,
    WINPE_DIAGNOSTIC_MEMBERS,
    WINPE_DIAGNOSTIC_OUTPUT_MARKER_NAME,
    WINPE_DIAGNOSTIC_PRODUCTION_SEAM,
    WINPE_DIAGNOSTIC_SEED_MARKER_NAME,
    renderWinpeDiagnosticScript,
    winpeDiagnosticOutputMarker,
    winpeDiagnosticSeedMarker
} from "../../scripts/qualification/linux-windows-cpu-floor-stage2.mjs";

const NONCE = "0123456789abcdef0123456789abcdef";
const OTHER_NONCE = "fedcba9876543210fedcba9876543210";
const SEED_MARKER = winpeDiagnosticSeedMarker(NONCE);
const OUTPUT_MARKER = winpeDiagnosticOutputMarker(NONCE);
/*
 * findstr /x only sees a line that is terminated, so a marker file without its trailing CRLF never
 * matches. Every well-formed fixture therefore writes exactly what the seed builder writes.
 */
const CRLF = "\r\n";
const SEED_MARKER_FILE = `${SEED_MARKER}${CRLF}`;
const OUTPUT_MARKER_FILE = `${OUTPUT_MARKER}${CRLF}`;
/*
 * The script drives cmd.exe, so it can only be executed where cmd.exe is. Everything that does not
 * need a shell - the rendered body, the seam boundary, the allowlists - is asserted everywhere.
 */
const WINDOWS = process.platform === "win32";
const roots = [];

after(() => {
    for (const root of roots) try { fs.rmSync(root, {recursive: true, force: true}); } catch { /* best effort */ }
});

function seamFor(root, volumes) {
    return {
        seed: `${path.join(root, "seed")}\\`,
        seedVolume: path.join(root, "seed"),
        volumePrefix: "type ",
        volumeSuffix: "\\label.txt",
        roots: volumes.map(name => `"${path.join(root, name)}"`).join(" "),
        sources: [path.join(root, "src", "setupact.log"), path.join(root, "src", "setuperr.log"),
            path.join(root, "src", "btact.log")],
        cacheProbes: WINPE_DIAGNOSTIC_CACHE_PROBES.map((value, index) =>
            path.join(root, "src", `probe${index + 1}.bin`))
    };
}

/*
 * One case = one fresh task directory holding a seed, some candidate volumes and some sources. No
 * real drive root is enumerated, read or written; nothing is mounted, substituted or partitioned;
 * the seam is the only thing that changes between this and the production script.
 */
function runCase({seed = {marker: SEED_MARKER_FILE, label: "MYSPEEDSEED"}, volumes = [], sources = {},
    sourceDirectories = [], probes = {}, preexisting = {}} = {}) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "myspeed-winpe-script-"));
    roots.push(root);
    fs.mkdirSync(path.join(root, "seed"));
    fs.mkdirSync(path.join(root, "src"));
    if (seed !== null) {
        if (seed.marker !== null)
            fs.writeFileSync(path.join(root, "seed", WINPE_DIAGNOSTIC_SEED_MARKER_NAME), seed.marker);
        fs.writeFileSync(path.join(root, "seed", "label.txt"), `${seed.label}\r\n`);
    }
    for (const [name, bytes] of Object.entries(sources))
        fs.writeFileSync(path.join(root, "src", name), bytes);
    for (const name of sourceDirectories) fs.mkdirSync(path.join(root, "src", name));
    for (const [name, bytes] of Object.entries(probes))
        fs.writeFileSync(path.join(root, "src", name), bytes);
    for (const volume of volumes) {
        const directory = path.join(root, volume.name);
        fs.mkdirSync(directory);
        fs.writeFileSync(path.join(directory, "label.txt"), `${volume.label ?? ""}\r\n`);
        if (volume.marker !== null && volume.marker !== undefined)
            fs.writeFileSync(path.join(directory, WINPE_DIAGNOSTIC_OUTPUT_MARKER_NAME), volume.marker);
    }
    for (const [volumeName, names] of Object.entries(preexisting))
        for (const name of names) fs.writeFileSync(path.join(root, volumeName, name), "stale\r\n");
    const script = path.join(root, "seed", "diag.cmd");
    fs.writeFileSync(script, renderWinpeDiagnosticScript(NONCE, seamFor(root, volumes.map(v => v.name))));
    const observed = spawnSync(process.env.ComSpec ?? "cmd.exe", ["/d", "/c", script],
        {encoding: "utf8", timeout: 60_000, windowsHide: true, stdio: ["ignore", "pipe", "pipe"]});
    const written = Object.fromEntries(volumes.map(volume => [volume.name,
        fs.readdirSync(path.join(root, volume.name)).sort()]));
    const read = (volumeName, member) => {
        try { return fs.readFileSync(path.join(root, volumeName, member), "utf8"); }
        catch { return null; }
    };
    return {root, status: observed.status, signal: observed.signal, stderr: observed.stderr, written, read};
}

/* Only the members the script may leave behind, sorted, next to the fixture's own label marker. */
function expectMembers(written, volume, members, {marker = true} = {}) {
    assert.deepEqual(written[volume], [...members, "label.txt",
        ...(marker ? [WINPE_DIAGNOSTIC_OUTPUT_MARKER_NAME] : [])].sort());
}

describe("WinPE diagnostic guest script rendering", () => {
    it("keeps production and fixture bodies identical outside the seam", () => {
        const production = renderWinpeDiagnosticScript(NONCE).toString("ascii").split("\r\n");
        const fixture = renderWinpeDiagnosticScript(NONCE, seamFor("C:\\t", [])).toString("ascii").split("\r\n");
        const start = production.indexOf("rem ---- seam ----");
        const end = production.indexOf("rem ---- end seam ----");
        assert.ok(start > 0 && end > start);
        assert.equal(fixture.indexOf("rem ---- seam ----"), start);
        assert.equal(fixture.indexOf("rem ---- end seam ----"), end);
        assert.deepEqual(production.slice(0, start + 1), fixture.slice(0, start + 1));
        assert.deepEqual(production.slice(end), fixture.slice(end));
        assert.equal(production.length - (end - start + 1), 89,
            "only the seam may differ; the rest of the body is the tested one");
    });

    it("renders every path separator, tool path and nonce binding it depends on", () => {
        const text = renderWinpeDiagnosticScript(NONCE).toString("ascii");
        assert.ok(text.includes(`set "MSSEEDMARK=${SEED_MARKER}"`));
        assert.ok(text.includes(`set "MSOUTMARK=${OUTPUT_MARKER}"`));
        assert.ok(text.includes("%SystemRoot%\\System32\\findstr.exe"));
        assert.ok(text.includes("\"%MSDEST%\\MSDIAG.OK\""));
        assert.ok(text.includes("setlocal EnableExtensions DisableDelayedExpansion"));
        assert.equal(text.includes(NONCE), true);
        assert.equal(text.includes(OTHER_NONCE), false);
        /* The cached answer file is probed, never copied. */
        assert.ok(WINPE_DIAGNOSTIC_CACHE_PROBES.some(probe => probe.endsWith("unattend.xml")));
        assert.equal(WINPE_DIAGNOSTIC_PRODUCTION_SEAM.sources.some(source => source.endsWith(".xml")), false);
        /* Every retained member is an 8.3 name, so a FAT short-name round trip changes nothing. */
        for (const member of WINPE_DIAGNOSTIC_MEMBERS)
            assert.match(member.name, /^[A-Z0-9]{1,8}\.[A-Z0-9]{1,3}$/u);
        assert.equal(new Set(WINPE_DIAGNOSTIC_MEMBERS.map(member => member.name)).size,
            WINPE_DIAGNOSTIC_MEMBERS.length);
        assert.equal(WINPE_DIAGNOSTIC_PRODUCTION_SEAM.roots.split(" ").length, 23);
        assert.equal(WINPE_DIAGNOSTIC_PRODUCTION_SEAM.roots.includes("x:"), false);
        assert.throws(() => renderWinpeDiagnosticScript("nope"), /nonce/u);
        assert.throws(() => renderWinpeDiagnosticScript(NONCE,
            {...WINPE_DIAGNOSTIC_PRODUCTION_SEAM, sources: ["a"]}), /seam is invalid/u);
    });
});

describe("WinPE diagnostic guest script under cmd.exe", {skip: WINDOWS ? false : "needs cmd.exe"}, () => {
    it("collects into the one volume carrying both the expected label and this run's marker", () => {
        const observed = runCase({
            volumes: [{name: "vol1", label: "MYSPEEDOUT", marker: OUTPUT_MARKER_FILE}],
            sources: {"setupact.log": "action\r\n", "setuperr.log": "error\r\n"},
            probes: {"probe1.bin": "x".repeat(11), "probe4.bin": "y".repeat(22)}
        });
        assert.equal(observed.status, WINPE_DIAGNOSTIC_EXIT_CODES.complete);
        expectMembers(observed.written, "vol1", ["MSDIAG.STA", "MSACT.LOG", "MSERR.LOG", "MSCACHE.TXT", "MSDIAG.OK"]);
        assert.equal(observed.read("vol1", "MSACT.LOG"), "action\r\n");
        assert.equal(observed.read("vol1", "MSERR.LOG"), "error\r\n");
        assert.equal(observed.read("vol1", "MSDIAG.OK"), `${OUTPUT_MARKER}\r\n`);
        const cache = observed.read("vol1", "MSCACHE.TXT").split("\r\n").filter(line => line.length > 0);
        assert.equal(cache[0], OUTPUT_MARKER);
        assert.deepEqual(cache.slice(1), ["1=1 11", "2=0 0", "3=0 0", "4=1 22", "5=0 0", "6=0 0", "7=0 0"]);
        /* Sizes and flags only - no discovered filesystem name reaches the report. */
        assert.equal(cache.slice(1).some(line => line.includes("probe")), false);
    });

    it("writes nothing at all when no volume, or more than one volume, identifies itself", () => {
        const none = runCase({volumes: [{name: "vol1", label: "MYSPEEDOUT", marker: null}]});
        assert.equal(none.status, WINPE_DIAGNOSTIC_EXIT_CODES.destinationAbsent);
        expectMembers(none.written, "vol1", [], {marker: false});

        const two = runCase({volumes: [
            {name: "vol1", label: "MYSPEEDOUT", marker: OUTPUT_MARKER_FILE},
            {name: "vol2", label: "MYSPEEDOUT", marker: OUTPUT_MARKER_FILE}]});
        assert.equal(two.status, WINPE_DIAGNOSTIC_EXIT_CODES.destinationAmbiguous);
        expectMembers(two.written, "vol1", []);
        expectMembers(two.written, "vol2", []);
    });

    it("refuses a foreign nonce, an extra marker line, and a label that only prefixes or suffixes", () => {
        for (const marker of [`${winpeDiagnosticOutputMarker(OTHER_NONCE)}${CRLF}`, `${OUTPUT_MARKER}\r\nextra\r\n`,
            `extra\r\n${OUTPUT_MARKER}\r\n`, `${OUTPUT_MARKER} trailing\r\n`, "MYSPEEDOUT\r\n"]) {
            const observed = runCase({volumes: [{name: "vol1", label: "MYSPEEDOUT", marker}]});
            assert.equal(observed.status, WINPE_DIAGNOSTIC_EXIT_CODES.destinationAbsent,
                `marker ${JSON.stringify(marker)} must not resolve a destination`);
            expectMembers(observed.written, "vol1", []);
        }
        for (const label of ["MYSPEEDOU", "", "MYSPEED"]) {
            const observed = runCase({volumes: [{name: "vol1", label, marker: OUTPUT_MARKER_FILE}]});
            assert.equal(observed.status, WINPE_DIAGNOSTIC_EXIT_CODES.destinationAbsent);
            expectMembers(observed.written, "vol1", []);
        }
        /*
         * A label the expected one is a substring of still matches, because `vol` renders its label
         * inside localised prose that cannot be anchored. That is a documented weakening of the
         * label check, which is why the marker file - exact, whole-line, nonce-bound - is required
         * as well and is what actually identifies the volume.
         */
        const superset = runCase({volumes: [{name: "vol1", label: "MYSPEEDOUTX", marker: OUTPUT_MARKER_FILE}]});
        assert.equal(superset.status, WINPE_DIAGNOSTIC_EXIT_CODES.complete);
    });

    it("refuses to run at all when the seed it was generated for cannot be identified", () => {
        const absent = runCase({seed: {marker: null, label: "MYSPEEDSEED"},
            volumes: [{name: "vol1", label: "MYSPEEDOUT", marker: OUTPUT_MARKER_FILE}]});
        assert.equal(absent.status, WINPE_DIAGNOSTIC_EXIT_CODES.seedMarkerAbsent);
        expectMembers(absent.written, "vol1", []);

        for (const seed of [{marker: `${winpeDiagnosticSeedMarker(OTHER_NONCE)}${CRLF}`, label: "MYSPEEDSEED"},
            {marker: `${SEED_MARKER}\r\nextra\r\n`, label: "MYSPEEDSEED"},
            {marker: SEED_MARKER_FILE, label: "SOMETHINGELSE"}]) {
            const observed = runCase({seed, volumes: [{name: "vol1", label: "MYSPEEDOUT", marker: OUTPUT_MARKER_FILE}]});
            assert.equal(observed.status, WINPE_DIAGNOSTIC_EXIT_CODES.seedIdentityDiffers);
            expectMembers(observed.written, "vol1", []);
        }
    });

    it("refuses a destination that already carries any retained member", () => {
        for (const member of ["MSDIAG.STA", "MSDIAG.OK", "MSCACHE.TXT", "MSACT.LOG"]) {
            const observed = runCase({volumes: [{name: "vol1", label: "MYSPEEDOUT", marker: OUTPUT_MARKER_FILE}],
                preexisting: {vol1: [member]}, sources: {"setupact.log": "action\r\n"}});
            assert.equal(observed.status, WINPE_DIAGNOSTIC_EXIT_CODES.outputPreexisting);
            expectMembers(observed.written, "vol1", [member]);
            assert.equal(observed.read("vol1", member), "stale\r\n");
        }
    });

    it("records an absent source without failing, and a failed collection without an OK marker", () => {
        const absentSources = runCase({volumes: [{name: "vol1", label: "MYSPEEDOUT", marker: OUTPUT_MARKER_FILE}]});
        assert.equal(absentSources.status, WINPE_DIAGNOSTIC_EXIT_CODES.complete);
        expectMembers(absentSources.written, "vol1", ["MSDIAG.STA", "MSCACHE.TXT", "MSDIAG.OK"]);

        /*
         * A source that exists but cannot be copied is an explicit failure, never a silent OK. The
         * fixture makes the source a directory, which `if exist` accepts and `copy` refuses.
         */
        const blocked = runCase({volumes: [{name: "vol1", label: "MYSPEEDOUT", marker: OUTPUT_MARKER_FILE}],
            sourceDirectories: ["setupact.log"], sources: {"setuperr.log": "error\r\n"}});
        assert.equal(blocked.status, WINPE_DIAGNOSTIC_EXIT_CODES.collectionIncomplete);
        expectMembers(blocked.written, "vol1", ["MSDIAG.STA", "MSERR.LOG", "MSCACHE.TXT", "MSDIAG.ERR"]);
        assert.equal(blocked.read("vol1", "MSDIAG.OK"), null);
        assert.equal(blocked.read("vol1", "MSDIAG.ERR"), `${OUTPUT_MARKER}\r\n`);
    });

    it("keeps the destination directory the only thing it writes, metacharacters included", () => {
        const observed = runCase({volumes: [{name: "vol(1)", label: "MYSPEEDOUT", marker: OUTPUT_MARKER_FILE},
            {name: "plain", label: "OTHER", marker: null}],
        sources: {"setupact.log": "action\r\n"}});
        assert.equal(observed.status, WINPE_DIAGNOSTIC_EXIT_CODES.complete);
        expectMembers(observed.written, "vol(1)", ["MSDIAG.STA", "MSACT.LOG", "MSCACHE.TXT", "MSDIAG.OK"]);
        expectMembers(observed.written, "plain", [], {marker: false});
    });
});
