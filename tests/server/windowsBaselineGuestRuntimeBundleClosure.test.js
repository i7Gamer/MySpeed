import assert from "node:assert/strict";
import {execFileSync, spawnSync} from "node:child_process";
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
 * `path.resolve()` with no arguments returns the working directory. Nothing in it names a location -
 * no `process`, no `cwd`, no `__dirname` - so no rule about which properties mean "where am I" can
 * reach it, and it is ordinary code. A named import (`import {cwd} from "node:process"`) and
 * `Reflect.get(process, "cwd")` are the same shape of counterexample. Each could of course be added
 * to the list; the point is that the list was never finishable, because the set of ways to obtain a
 * location is the set of things code can do. So the recogniser was not incomplete in a way more
 * rules could fix; the premise was wrong. Deciding which edits matter requires understanding what the code does, and a test that
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
const MANIFEST_PATH = path.relative(REPOSITORY, MANIFEST).replaceAll("\\", "/");
const APPROVAL_SEARCH_LIMIT = 25;
const MAX_BLOB_BYTES = 8 * 1024 * 1024;

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
        /*
         * The scan below walks to the root of the volume holding the temporary directory. Under a
         * UNC root that is not where Node stops: from \\server\share\x it also searches
         * \\server\node_modules, which is a sibling share this loop never reaches. Rather than claim
         * an isolation the scan cannot establish, refuse the root it cannot reason about.
         */
        const localRoot = process.platform === "win32" ? /^[a-z]:[\\/]/iu : /^\/(?!\/)/u;
        assert.match(root, localRoot,
            `the temporary directory is at ${root}, and this proves nothing about a bundle laid out`
            + " there: Node's search from a UNC or device path reaches shares this scan does not"
            + " walk. Point TMP at a local drive.");
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
 * The bytes on disk, hashed exactly as they are. Nothing is normalised, excused or interpreted,
 * because every rule about which bytes do not count has turned out to be a rule about which changes
 * are invisible.
 *
 * Two versions of this got that wrong in the same shape. The first decoded the file as utf8 before
 * hashing, and an invalid byte decodes to U+FFFD, so two members differing only there shared a hash.
 * The second hashed bytes but removed every CR LF pair as a line ending, which is a claim about the
 * encoding rather than about the bytes: in UTF-16LE that pair is the character U+0A0D. Fencing the
 * digest to ASCII closed that and left a smaller version of it - a file holding a bare CR is stored
 * by Git verbatim while `check-attr` still calls it `text=auto`, so two versions differing by one CR
 * are both committable under one approved hash. Measured, not reasoned: two such files produce
 * different blobs and one digest.
 *
 * So the normalisation is gone, and the property it was standing in for is enforced where it belongs.
 * .gitattributes pins these thirteen paths to `text eol=lf`, which makes Git store and check out one
 * form on every machine, and the test below holds it there. Drift in that attribute now shows up as a
 * failed hash rather than as two files Git considers equally correct.
 */
const digestOf = bytes => crypto.createHash("sha256").update(bytes).digest("hex");

const approvedHash = member => digestOf(fs.readFileSync(path.join(REPOSITORY, member)));

const git = (args, encoding) => execFileSync("git", args,
    {cwd: REPOSITORY, encoding, maxBuffer: MAX_BLOB_BYTES, stdio: ["ignore", "pipe", "ignore"]});

/*
 * Where to diff a changed member from. The obvious answer - the commit that last moved the manifest -
 * is wrong often enough to matter: in a single-commit CI checkout it resolves to HEAD, whose member
 * is the changed one, and the printed diff comes back empty. That is the same silence this whole
 * message replaced, so the base is not guessed. A commit is only offered once the member stored there
 * digests to the approved value, which is exact now that nothing is normalised. When none of the
 * recent approvals holds it, that is said rather than papered over with a command that prints nothing.
 */
/*
 * Hashing raw bytes has one failure that looks like tampering and is not. A clone made before these
 * paths were pinned to `eol=lf` still holds them with CRLF, and git will not report that as a change
 * - it normalises on comparison - so the digest differs while every diff comes back empty. Saying
 * "this member differs, here is nothing" is precisely the silence the rest of this message exists to
 * avoid, so the case is named.
 *
 * Named, not diagnosed. Bytes that match after line endings are set aside are also what you get from
 * an edit *to* a line ending, and from an edit to a character whose bytes happen to contain CR LF -
 * two U+0A0D in UTF-16 against one U+0A0A is a different word, and this comparison cannot tell it
 * from a stale checkout. So this reports the relationship and whether the index is the approved
 * content, and leaves the conclusion to the reader.
 */
const checkoutNote = member => {
    try {
        const stored = git(["cat-file", "blob", `:${member}`]);
        const onDisk = fs.readFileSync(path.join(REPOSITORY, member));
        if (stored.equals(onDisk)) return null;
        const alike = stored.toString("latin1").replaceAll("\r\n", "\n")
            === onDisk.toString("latin1").replaceAll("\r\n", "\n");
        return alike ? {indexApproved: digestOf(stored) === APPROVED[member]} : null;
    } catch {
        return null;
    }
};

/*
 * What one changed member gets told to the reader. The file on disk comes first and unconditionally,
 * because those are the bytes the replacement digest is taken over: a command that shows any other
 * version - HEAD, the index, a base - describes something the reviewer is not being asked to approve.
 * A diff narrows that down when there is a base worth trusting, and it is an addition to the file,
 * never a substitute, because git normalises the working side of a comparison and can print nothing
 * at all for a difference that is really there.
 */
const reportOn = entry => {
    const lines = [`  ${entry.member}`,
        `    approved ${Object.hasOwn(APPROVED, entry.member)
            ? String(entry.approved) : "(none - this member is new)"}`,
        `    actual   ${entry.actual}`,
        `    the bytes being approved are the ones on disk, so read that file: ${entry.member}`,
        entry.base === null
            ? `    no verified base was found in the last ${APPROVAL_SEARCH_LIMIT} commits to touch`
              + "\n    the manifest, so there is no diff to narrow it down with"
            : `    what changed since it was approved: git diff ${entry.base} -- ${entry.member}`];
    if (entry.checkout !== null) {
        lines.push("    your copy and the index agree once every CR LF in each is read as LF. A"
            + "\n    checkout older than the eol=lf rule looks like that - so does an edit to a line"
            + "\n    ending, and so does an edit to a character whose bytes contain CR LF, and this"
            + "\n    cannot tell them apart. The index "
            + `${entry.checkout.indexApproved ? "does" : "does NOT"} hold the approved bytes.`
            /*
             * Removed first rather than overwritten in place. `checkout-index -f` decides whether to
             * rewrite by consulting the index's cached stat for the file, and a reviewer who has just
             * run the diff above has given git every chance to record the stale file's stat as clean.
             * Deleting takes that decision away. Two commands rather than one chained with `&&`,
             * which is a parse error in the Windows PowerShell this repository is developed in.
             */
            + "\n    To replace your copy with the index, losing anything only your copy has:"
            + `\n      rm ${entry.member}`
            + `\n      git checkout-index -f -- ${entry.member}`);
    }
    return lines.join("\n");
};

const approvalBaseFor = member => {
    let commits;
    try {
        commits = git(["log", `--max-count=${APPROVAL_SEARCH_LIMIT}`, "--format=%H", "--",
            MANIFEST_PATH], "utf8").split("\n").filter(line => line.trim() !== "");
    } catch {
        return null;
    }
    for (const commit of commits) {
        try {
            if (digestOf(git(["cat-file", "blob", `${commit}:${member}`])) === APPROVED[member]) {
                return commit;
            }
        } catch {
            continue;
        }
    }
    return null;
};

/*
 * The manifest is read as text and normalised, unlike the members below, because it is compared for
 * shape rather than hashed - and it stays under `text=auto`, so it checks out either way. Nothing can
 * hide in that difference: JSON has no raw CR or LF inside a string, and every key and value here is
 * held to an exact path or a 64-character digest.
 */
const MANIFEST_TEXT = fs.readFileSync(MANIFEST, "utf8").replaceAll("\r\n", "\n");
const APPROVED = Object.freeze(JSON.parse(MANIFEST_TEXT));

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
            .filter(entry => entry.actual !== entry.approved)
            .map(entry => ({...entry, checkout: checkoutNote(entry.member),
                base: approvalBaseFor(entry.member)}));
        if (changed.length === 0) return;
        assert.fail(`${changed.length} bundle member(s) differ from the approved content.\n`
            + changed.map(reportOn).join("\n")
            + "\n\nEvery member runs in the guest with no node_modules and no repository, so read the"
            + "\ndiff for anything it now reaches - an import, a path, a spawn, a PowerShell dot-source"
            + "\n- and check the file is in RUNTIME_PATHS. Then approve it by replacing the entries in"
            + `\n${MANIFEST_PATH} with:\n`
            + `${JSON.stringify(Object.fromEntries(
                RUNTIME_PATHS.map(member => [member, approvedHash(member)])), null, 4)}`);
    });

    /*
     * Nothing is normalised away, so a line ending is content like any other byte. Two earlier
     * versions of this digest excused a class of byte - a utf8 decode, then a CR LF pair - and each
     * excuse turned out to be a pair of different files sharing one approval.
     */
    /*
     * The advice is the product of a failure, so it is pinned like one. Both of these were real:
     * `&&` does not parse in Windows PowerShell 5.1, and overwriting in place leaves `checkout-index`
     * free to decide the file is already current from its cached stat.
     */
    it("prescribes a recovery that runs in this repository's shell and cannot no-op", () => {
        const advice = reportOn({member: MEMBERS[0], actual: "a".repeat(64),
            approved: APPROVED[MEMBERS[0]], base: null, checkout: {indexApproved: true}});
        assert.ok(advice.includes(`\n      rm ${MEMBERS[0]}\n`),
            "the refresh no longer removes the file first, so git may decide it is already current");
        assert.ok(advice.includes(`git checkout-index -f -- ${MEMBERS[0]}`),
            "the refresh no longer restores the index content");
        assert.ok(!advice.includes("&&"),
            "&& is a parse error in Windows PowerShell 5.1, where this repository is developed");
    });

    it("digests the bytes as they are, excusing nothing", () => {
        assert.notEqual(digestOf(Buffer.from("a\r\nb")), digestOf(Buffer.from("a\nb")),
            "a line ending is being excused again, so a CRLF checkout would hide a change");
        assert.notEqual(digestOf(Buffer.from([0x80])), digestOf(Buffer.from([0x81])),
            "the digest is decoding before hashing, so invalid bytes collapse together");
        assert.equal(digestOf(Buffer.from("")), digestOf(Buffer.alloc(0)),
            "the same bytes are digesting differently");
    });

    /*
     * Hashing raw bytes only gives the same answer everywhere if Git hands everyone the same bytes.
     * `text=auto` does not promise that: it reports "auto" for a file holding a bare CR while storing
     * that file verbatim, and two versions differing by one CR are then both committable under one
     * hash. `eol=lf` forces a single stored and checked-out form, so this is where the guarantee
     * actually lives - the digest above only measures it.
     */
    it("pins every member to the line ending the digests were taken over", () => {
        /* -z rather than the readable form: a path is not guaranteed to be free of ": " or newlines. */
        const fields = execFileSync("git", ["check-attr", "-z", "text", "eol", "--", ...RUNTIME_PATHS],
            {cwd: REPOSITORY, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"]}).split("\0");
        const records = [];
        for (let index = 0; index + 2 < fields.length; index += 3) {
            records.push({member: fields[index], attribute: fields[index + 1], value: fields[index + 2]});
        }
        /* Two attributes asked for, so two records per member, in the order they were asked for. */
        assert.equal(records.length, RUNTIME_PATHS.length * 2,
            "git did not report both attributes for every member");
        const wrong = RUNTIME_PATHS.filter((member, index) => {
            const [text, eol] = [records[index * 2], records[index * 2 + 1]];
            return text.member !== member || eol.member !== member
                || text.value !== "set" || eol.value !== "lf";
        });
        assert.deepEqual(wrong, [],
            "these members are not pinned to `text eol=lf` in .gitattributes, so git may store or"
            + " check them out with endings the approved digests were not taken over");
    });

    /*
     * The manifest is what a reviewer reads to see what was approved, so it has to say one thing.
     * JSON.parse keeps the last of a duplicated key, which would let a stale line sit above the live
     * one and read as the approval. Holding the file to exactly the block the failure message prints
     * rejects that, and keeps the paste workflow from drifting into a hand-edited file.
     */
    it("holds the manifest to the one form the failure message prints", () => {
        assert.deepEqual(
            Object.entries(APPROVED).filter(([, digest]) => !/^[0-9a-f]{64}$/u.test(digest)), [],
            "an approved entry is not a sha256 digest");
        assert.deepEqual(Object.keys(APPROVED), [...RUNTIME_PATHS],
            "the manifest lists members in a different order from the bundle");
        assert.equal(MANIFEST_TEXT, `${JSON.stringify(APPROVED, null, 4)}\n`,
            `${MANIFEST_PATH} is not the canonical serialisation of what it parses to - a duplicated`
            + " key, or whitespace that was hand-edited. This failure's expected value below is the"
            + " form to write; nothing else about the approvals has to change.");
    });

    it("approves every file the bundle declares, and nothing else", () => {
        assert.equal(MEMBERS.length + CONTROLLERS.length, RUNTIME_PATHS.length,
            "the bundle should carry only modules and PowerShell controllers");
        assert.deepEqual(Object.keys(APPROVED).sort(), [...RUNTIME_PATHS].sort(),
            "the approved list and the bundle's own list have drifted apart");
    });
});
