import assert from "node:assert/strict";
import {spawnSync} from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {before, describe, it} from "node:test";
import {fileURLToPath} from "node:url";

import {WINDOWS_BASELINE_RUNTIME_BUNDLE_CONSTANTS} from
    "../../scripts/qualification/windows-baseline-guest-runtime-bundle.mjs";

/*
 * The guest runtime bundle ships a fixed list of files and nothing else. Inside the guest they run
 * under a pinned node.exe from a temporary directory with no node_modules and no repository, so a
 * file a member reaches that is not in the list fails inside a virtual machine, half an hour into a
 * thirty-five minute sequence, on a host nobody can attach a debugger to.
 *
 * This suite guarantees two things. The bundle loads by itself under the guest's layout, proven by
 * running it rather than by reading it. And every byte of every member is content a human approved,
 * proven by hashing the files rather than by understanding them.
 *
 * The second half used to be cleverer, and the story is worth keeping because it is the reason this
 * is not. Five versions of this file tried to single out the *interesting* parts of each member -
 * the expressions that name a script or ask where the module is - so that ordinary edits would not
 * cost an approval. The earlier ones matched import syntax and scanned strings; the last pinned the
 * source text of the expressions it recognised. Eight rounds of adversarial review found
 * a way past every one of them: an import behind a comment, a filename moved into a constant, a
 * computed key, an escaped template, a destructured binding, a renamed one, a default value,
 * `globalThis.process`. Each fix closed the reported spelling; the next round found another, twice
 * inside the fix for the one before.
 *
 * It ended on an example that cannot be recognised at all:
 *
 *     const base = path.resolve();
 *
 * `path.resolve()` with no arguments returns the working directory. There is no `process`, no `cwd`,
 * no member read, no pattern - nothing for any recogniser to match, and it is ordinary code. A named
 * import (`import {cwd} from "node:process"`) and `Reflect.get(process, "cwd")` are the same shape of
 * counterexample. So the recogniser was not incomplete in a way more rules could fix; the premise was
 * wrong. Deciding which edits matter requires understanding what the code does, and a test that
 * understood that would need to be more trustworthy than the code it guards.
 *
 * So it stopped deciding. The gate is now "did this file change at all", which no spelling can slip
 * past because it does not look at spellings. The price is that any edit to a bundle member needs an
 * approval line, including edits that have nothing to do with reaching files. That is the honest cost
 * of the guarantee, and the promise the old design was built on - only bother the reviewer for
 * relevant changes - is exactly the promise that could not be kept.
 *
 * Stated so nobody reads more into a green run than it says:
 * - An approved hash means a human said this content is correct for the guest. It does not mean the
 *   content is correct. A hash updated without reading the diff proves nothing at all, and that is a
 *   review risk no test can remove.
 * - Nothing inside a scenario runs here. The wrapper hashes the controllers it is handed.
 * - The fixture's own inventory belongs to fixtureInventoryParity, and the request contract to the
 *   materializer's suite. This is about the bundle standing alone, not about what it then does.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPOSITORY = path.resolve(HERE, "..", "..");
const {RUNTIME_PATHS} = WINDOWS_BASELINE_RUNTIME_BUNDLE_CONSTANTS;
const MEMBERS = RUNTIME_PATHS.filter(name => name.endsWith(".mjs"));
const CONTROLLERS = RUNTIME_PATHS.filter(name => name.endsWith(".ps1"));
const LOAD_TIMEOUT_MILLISECONDS = 60_000;
const REPORT_NAME = "closure-report.json";
const PROBE_SENTINEL = "closure-probe-reached-operations";
const MANIFEST = path.join(HERE, "windowsBaselineGuestRuntimeBundleClosure.approved.json");

const PROBE = `
import fs from "node:fs"; import path from "node:path"; import {pathToFileURL} from "node:url";
const root = process.cwd(), url = m => pathToFileURL(path.join(root, ...m.split("/"))).href;
const report = {imports: {}, probes: {}};
const brief = e => (e?.code ? e.code + ": " : "") + String(e?.message ?? e).split("\\n")[0];
for (const m of JSON.parse(process.env.BUNDLE_MEMBERS)) {
  try { await import(url(m)); report.imports[m] = "ok"; }
  catch (e) { report.imports[m] = "FAIL " + brief(e); }
}
if (Object.values(report.imports).every(v => v === "ok")) {
  try {
    const {checkResetDatabase} = await import(url("scripts/qualification/sqlite-check.mjs"));
    const v = await checkResetDatabase(":memory:");
    report.probes.sqlite = JSON.stringify(v) === '{"integrity":"ok","configTable":false}'
      ? "ok" : "FAIL " + JSON.stringify(v);
  } catch (e) { report.probes.sqlite = "FAIL " + brief(e); }
  try {
    const {runMacosRuntimeIsolation} = await import(url("scripts/qualification/check-artifact.mjs"));
    let loads = 0;
    const v = await runMacosRuntimeIsolation({platform: "win32"}, {loadIsolationProbe: () => {
      loads += 1; return Promise.reject(new Error("probe loaded on win32")); }});
    report.probes.macos = v === null && loads === 0 ? "ok"
      : "FAIL value=" + JSON.stringify(v) + " loads=" + loads;
  } catch (e) { report.probes.macos = "FAIL " + brief(e); }
  try {
    const {executeWindowsBaselineGuest} =
      await import(url("scripts/qualification/windows-baseline-guest-executor.mjs"));
    const sha = "0".repeat(64), controller = {bytes: "2", sha256: sha};
    const out = await executeWindowsBaselineGuest(
      {requestPath: "request", expectedRequestSha256: sha, executionPath: "execution",
       expectedExecutionSha256: sha, resultPath: "result"},
      {assertGuest: async () => {}, readJson: (i, label) => label.includes("execution")
         ? {candidateController: controller, cleanStopController: controller} : {},
       writeResult: () => {}, createOperations: () => { throw new Error(${JSON.stringify(PROBE_SENTINEL)}); },
       runtimeConfiguration: {powershellPath: "powershell.exe"}});
    report.probes.wrapper = out?.result?.failure === ${JSON.stringify(PROBE_SENTINEL)}
      ? "ok" : "FAIL " + JSON.stringify(out?.result);
  } catch (e) { report.probes.wrapper = "FAIL " + brief(e); }
}
fs.writeFileSync(path.join(root, ${JSON.stringify(REPORT_NAME)}), JSON.stringify(report));
`;

/*
 * Copies the bundle into a bare directory and imports it in one child process. The child gets the
 * runner's own node - which both seal batteries pin to the guest's version - with NODE_OPTIONS and
 * NODE_PATH stripped, no repository, and none of the test harness's loader hooks. That is the guest.
 */
const loadBundle = (omit = null) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "myspeed-bundle-closure-"));
    try {
        for (const member of RUNTIME_PATHS) {
            if (member === omit) continue;
            const target = path.join(root, ...member.split("/"));
            fs.mkdirSync(path.dirname(target), {recursive: true});
            fs.copyFileSync(path.join(REPOSITORY, member), target);
        }
        /* Includes the filesystem root: a package at / would resolve for the child like any other. */
        for (let ancestor = root; ; ancestor = path.dirname(ancestor)) {
            assert.ok(!fs.existsSync(path.join(ancestor, "node_modules")),
                `${ancestor} has node_modules, so this cannot prove the bundle stands alone`);
            if (ancestor === path.dirname(ancestor)) break;
        }
        const environment = {...process.env, BUNDLE_MEMBERS: JSON.stringify(MEMBERS)};
        delete environment.NODE_OPTIONS;
        delete environment.NODE_PATH;
        const result = spawnSync(process.execPath,
            ["--input-type=module", "--unhandled-rejections=strict",
                "--disable-warning=ExperimentalWarning", "-e", PROBE],
            {cwd: root, env: environment, encoding: "utf8",
                timeout: LOAD_TIMEOUT_MILLISECONDS, killSignal: "SIGKILL"});
        const tail = () => String(result.stderr ?? "").split(/\r?\n/u).slice(-3).join(" | ");
        /*
         * A child that writes a good report and then fails - a nonzero exit, a leaked handle killed
         * at the timeout, a shutdown hook that throws - was accepted before this check. The report
         * is only believable if the process that wrote it finished cleanly.
         */
        assert.equal(result.error, undefined, `the bundle load could not run: ${result.error}`);
        assert.equal(result.signal, null, `the bundle load was killed with ${result.signal}: ${tail()}`);
        assert.equal(result.status, 0, `the bundle load exited ${result.status}: ${tail()}`);
        const reportPath = path.join(root, REPORT_NAME);
        assert.ok(fs.existsSync(reportPath), `the bundle load produced no report: ${tail()}`);
        const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
        /* An empty inventory must not read as "nothing failed". */
        assert.deepEqual(Object.keys(report.imports).sort(),
            MEMBERS.filter(member => member !== omit).sort(),
            "the bundle load did not report on every member");
        return report;
    } finally {
        fs.rmSync(root, {recursive: true, force: true});
    }
};

/*
 * Line endings are a checkout mode, not content: this repository stores LF and checks out CRLF, so
 * hashing the bytes on disk as they are would fail on a colleague's machine rather than on a change.
 * Everything else is hashed exactly as written, including whitespace, because deciding which bytes
 * matter is the judgement this file no longer makes.
 *
 * The normalisation runs through latin1, which maps every byte to one code unit and back without
 * loss. Decoding as utf8 first would lose bytes instead: an invalid one becomes U+FFFD, so two
 * members differing only there would share an approved hash. Every member is ASCII today, where the
 * two agree, which is why this correction moved no approved entry - see the test below.
 */
const digestOf = bytes =>
    crypto.createHash("sha256")
        .update(Buffer.from(bytes.toString("latin1").replaceAll("\r\n", "\n"), "latin1"))
        .digest("hex");

const approvedHash = member => digestOf(fs.readFileSync(path.join(REPOSITORY, member)));

const APPROVED = Object.freeze(JSON.parse(fs.readFileSync(MANIFEST, "utf8")));

describe("Windows baseline guest runtime bundle closure", () => {
    let report = null;
    before(() => { report = loadBundle(); });

    it("loads with nothing but the bundle, laid out as the guest lays it out", () => {
        assert.deepEqual(Object.entries(report.imports).filter(([, verdict]) => verdict !== "ok"), []);
    });

    it("opens SQLite through the shim's Node branch", () => assert.equal(report.probes.sqlite, "ok"));

    it("never loads the macOS probe on win32", () => assert.equal(report.probes.macos, "ok"));

    it("reads its PowerShell wrapper from its own directory", () =>
        assert.equal(report.probes.wrapper, "ok"));

    /*
     * The probe above passes when the executor reaches the injected operations, which it would also
     * do if it never opened the wrapper at all. Removing the wrapper from the copied tree is the
     * control that tells those apart: if this still passes, the probe above proves nothing.
     */
    it("fails that read when the wrapper is missing, so the probe is not vacuous", () => {
        const without = loadBundle("scripts/qualification/windows-baseline-guest-candidate-wrapper.ps1");
        /* Every module still loads, so the verdict below is the read and not a collapsed import. */
        assert.deepEqual(Object.entries(without.imports).filter(([, verdict]) => verdict !== "ok"), []);
        assert.match(without.probes.wrapper,
            /^FAIL\b.*\bENOENT\b.*windows-baseline-guest-candidate-wrapper\.ps1/su,
            "the wrapper probe did not fail on the missing wrapper, so it proves nothing");
    });

    it("carries only the content a human approved", () => {
        const changed = RUNTIME_PATHS
            .map(member => ({member, actual: approvedHash(member), approved: APPROVED[member]}))
            .filter(entry => entry.actual !== entry.approved);
        if (changed.length === 0) return;
        assert.fail(`${changed.length} bundle member(s) differ from the approved content.\n`
            + changed.map(entry => `  ${entry.member}\n`
                + `    approved ${entry.approved ?? "(none - this member is new)"}\n`
                + `    actual   ${entry.actual}\n`
                + `    read it: git diff -- ${entry.member}`).join("\n")
            + "\n\nEvery member runs in the guest with no node_modules and no repository, so read the"
            + "\ndiff for anything it now reaches - an import, a path, a spawn, a PowerShell dot-source"
            + "\n- and check the file is in RUNTIME_PATHS. Then approve it by replacing the entries in"
            + `\n${path.relative(REPOSITORY, MANIFEST).replaceAll("\\", "/")} with:\n`
            + `${JSON.stringify(Object.fromEntries(
                RUNTIME_PATHS.map(member => [member, approvedHash(member)])), null, 4)}`);
    });

    /*
     * Both bytes below are invalid UTF-8 on their own, so a digest taken over decoded text sees one
     * U+FFFD either way and cannot tell the two apart. A BOM-less .ps1 is read by Windows PowerShell
     * in the system codepage, where they are different characters - so that blindness would let a
     * controller change what it runs without ever asking for an approval.
     */
    it("digests the bytes rather than a decoding of them", () => {
        const left = Buffer.from([0x80]);
        const right = Buffer.from([0x81]);
        assert.equal(left.toString("utf8"), right.toString("utf8"),
            "these bytes no longer decode alike, so this test no longer tests anything");
        assert.notEqual(digestOf(left), digestOf(right),
            "two members differing by one byte share an approved hash");
    });

    it("reads a line ending as a checkout mode and a lone carriage return as content", () => {
        assert.equal(digestOf(Buffer.from("a\r\nb\r\n")), digestOf(Buffer.from("a\nb\n")),
            "a CRLF checkout would need its own manifest");
        assert.notEqual(digestOf(Buffer.from("a\rb\n")), digestOf(Buffer.from("a\nb\n")),
            "a lone carriage return is content, not a checkout mode");
    });

    it("approves every file the bundle declares, and nothing else", () => {
        assert.equal(MEMBERS.length + CONTROLLERS.length, RUNTIME_PATHS.length,
            "the bundle should carry only modules and PowerShell controllers");
        assert.deepEqual(Object.keys(APPROVED).sort(), [...RUNTIME_PATHS].sort(),
            "the approved list and the bundle's own list have drifted apart");
    });
});
