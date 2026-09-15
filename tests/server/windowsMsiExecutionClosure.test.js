import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {describe, it} from "node:test";

import {sealWindowsMsiExecutionClosure, validateWindowsMsiExecutionClosureManifest,
    WINDOWS_MSI_CONTROLLER_CLOSURE, WINDOWS_MSI_CONTROLLER_ENTRY,
    WINDOWS_MSI_CONTROLLER_IMPORT_CLOSURE, WINDOWS_MSI_CONTROLLER_INVOKED_MEMBERS,
    WINDOWS_MSI_GUEST_CLOSURE, WINDOWS_MSI_GUEST_ENTRY, WINDOWS_MSI_GUEST_IMPORT_CLOSURE,
    WINDOWS_MSI_GUEST_INVOKED_MEMBERS, WINDOWS_MSI_KVM_SUBTREE_MEMBERS,
    sealWindowsMsiKvmSubtree, verifyWindowsMsiKvmSubtree} from
    "../../scripts/qualification/windows-msi-execution-closure.mjs";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");

const CONTEXT = Object.freeze({repository: "i7Gamer/MySpeed", sourceSha: "1".repeat(40),
    eventSha: "2".repeat(40), runId: "34900000001", runAttempt: "1", nonce: "9".repeat(32)});

const SPECIFIER = /(?:from\s*|import\s*|import\(\s*)(["'])(\.[^"']*)\1/g;

/*
 * Recomputed from the repository rather than declared, so the inventory cannot quietly drift away
 * from what the code actually imports. A module added to the controller or the guest shows up here
 * as a failing list comparison before it shows up as a missing file in a hosted execution job with
 * no checkout to fall back on.
 */
const importClosure = entries => {
    const seen = new Set();
    const walk = relative => {
        if (seen.has(relative)) return;
        seen.add(relative);
        const absolute = path.join(ROOT, relative);
        const source = fs.readFileSync(absolute, "utf8");
        for (const match of source.matchAll(SPECIFIER)) {
            const base = path.posix.join(path.posix.dirname(relative.replaceAll("\\", "/")), match[2]);
            const resolved = [base, `${base}.mjs`, `${base}.js`]
                .find(candidate => fs.existsSync(path.join(ROOT, candidate)));
            assert.ok(resolved, `${relative} imports ${match[2]}, which does not resolve`);
            walk(resolved);
        }
    };
    for (const entry of entries) walk(entry);
    return [...seen].sort();
};

const observe = inventory => inventory.map(item => {
    const bytes = fs.readFileSync(path.join(ROOT, item));
    return {path: item, bytes: String(bytes.length), sha256: sha256(bytes)};
});

const kvmFiles = (overrides = {}) => Object.fromEntries(
    ["closure.json", "linux-kvm-capability.mjs", "linux-kvm-privileged-capability.mjs",
        "privileged-closure.json"].map(name =>
        [name, Buffer.from(overrides[name] ?? `sealed-${name}`, "utf8")]));

describe("Windows MSI execution closure", () => {
    it("declares exactly the modules the controller imports", () => {
        assert.deepEqual([...WINDOWS_MSI_CONTROLLER_IMPORT_CLOSURE].sort(),
            importClosure([WINDOWS_MSI_CONTROLLER_ENTRY]));
    });

    it("declares exactly the modules the guest imports plus the scripts it invokes", () => {
        assert.deepEqual([...WINDOWS_MSI_GUEST_IMPORT_CLOSURE].sort(),
            importClosure([WINDOWS_MSI_GUEST_ENTRY, "scripts/qualification/check-artifact.mjs"]));
        for (const member of [...WINDOWS_MSI_GUEST_INVOKED_MEMBERS,
            ...WINDOWS_MSI_CONTROLLER_INVOKED_MEMBERS])
            assert.ok(fs.existsSync(path.join(ROOT, member)), member);
    });

    /*
     * The Stage 2 closure that predates the installed-base helpers is not this closure; sealing it
     * would leave the execution job resolving imports the sealed tree does not contain.
     */
    it("is larger than the earlier Stage 2 closure and covers the installed-base helpers", () => {
        assert.ok(WINDOWS_MSI_CONTROLLER_CLOSURE.length > 8);
        for (const member of ["scripts/qualification/windows-msi-installed-base.mjs",
            "scripts/qualification/windows-msi-installed-base-hosted.mjs",
            "scripts/qualification/windows-msi-installed-base-seal-helper.mjs",
            "scripts/qualification/windows-msi-prerequisite-evidence.mjs",
            "scripts/qualification/windows-msi-lifecycle-budget.mjs",
            "scripts/qualification/linux-kvm-privileged-capability.mjs"])
            assert.ok(WINDOWS_MSI_CONTROLLER_CLOSURE.includes(member), member);
        assert.equal(WINDOWS_MSI_CONTROLLER_CLOSURE.includes(WINDOWS_MSI_CONTROLLER_ENTRY), true);
        assert.equal(WINDOWS_MSI_GUEST_CLOSURE.includes(WINDOWS_MSI_GUEST_ENTRY), true);
    });

    it("seals both closures from observed bytes and rebinds them on validation", () => {
        const manifest = sealWindowsMsiExecutionClosure({context: CONTEXT,
            controller: observe(WINDOWS_MSI_CONTROLLER_CLOSURE),
            guest: observe(WINDOWS_MSI_GUEST_CLOSURE)});
        assert.equal(manifest.kind, "myspeed-windows-msi-execution-closure");
        assert.equal(manifest.qualifying, false);
        assert.deepEqual(manifest.releaseGatesCleared, []);
        assert.equal(manifest.controller.files.length, WINDOWS_MSI_CONTROLLER_CLOSURE.length);
        assert.equal(manifest.guest.files.length, WINDOWS_MSI_GUEST_CLOSURE.length);
        assert.notEqual(manifest.controller.sha256, manifest.guest.sha256);
        assert.deepEqual(validateWindowsMsiExecutionClosureManifest(manifest, CONTEXT), manifest);
        for (const member of manifest.controller.files)
            assert.equal(member.sha256,
                sha256(fs.readFileSync(path.join(ROOT, member.path))));
    });

    it("refuses a closure that is missing a member, carries an unlisted one, or was retyped", () => {
        const controller = observe(WINDOWS_MSI_CONTROLLER_CLOSURE);
        const guest = observe(WINDOWS_MSI_GUEST_CLOSURE);
        const seal = (over = {}) => sealWindowsMsiExecutionClosure({context: CONTEXT, controller, guest,
            ...over});
        assert.throws(() => seal({controller: controller.slice(1)}), /is absent/i);
        assert.throws(() => seal({controller: [...controller,
            {path: "scripts/release/post-release-target.mjs", bytes: "10", sha256: "a".repeat(64)}]}),
        /repeated/i);
        assert.throws(() => seal({controller: [...controller,
            {path: "scripts/qualification/macos-isolation.mjs", bytes: "10", sha256: "a".repeat(64)}]}),
        /unlisted source/i);
        assert.throws(() => seal({guest: guest.map(item => ({...item, bytes: Number(item.bytes)}))}),
            /member bytes/i);
        assert.throws(() => seal({guest: guest.map(item => ({...item, sha256: "z".repeat(64)}))}),
            /member SHA-256/i);
        assert.throws(() => seal({controller: controller.map(item => ({...item,
            path: item.path.replace("scripts/", "../")}))}), /member path/i);
    });

    it("refuses a manifest bound to another run, digest or gate claim", () => {
        const manifest = sealWindowsMsiExecutionClosure({context: CONTEXT,
            controller: observe(WINDOWS_MSI_CONTROLLER_CLOSURE),
            guest: observe(WINDOWS_MSI_GUEST_CLOSURE)});
        assert.throws(() => validateWindowsMsiExecutionClosureManifest(manifest,
            {...CONTEXT, runId: "34900000002"}), /execution context/i);
        assert.throws(() => validateWindowsMsiExecutionClosureManifest(manifest,
            {...CONTEXT, nonce: "8".repeat(32)}), /execution context/i);
        for (const mutate of [
            value => { value.sha256 = "f".repeat(64); },
            value => { value.controller.sha256 = "f".repeat(64); },
            value => { value.guest.entry = WINDOWS_MSI_CONTROLLER_ENTRY; },
            value => { value.releaseGatesCleared = ["windows-msi-lifecycle"]; },
            value => { value.qualifying = true; },
            value => { value.controller.files[0].sha256 = "f".repeat(64); }
        ]) {
            const changed = structuredClone(manifest);
            mutate(changed);
            assert.throws(() => validateWindowsMsiExecutionClosureManifest(changed, CONTEXT));
        }
    });

    /*
     * The KVM contract pins its own closure root to `$RUNNER_TEMP/linux-kvm-capability-closure`, so
     * the execution job cannot invoke the verified MSI copies through it: it has to carry a second
     * tree of the same two modules. That tree ships inside the same artifact and carries its own
     * generated manifests, which means it validates itself - a tree cannot establish its own
     * authority. The digest below is computed in the seal job, travels as a job output rather than
     * inside the artifact, and is what the execution job checks the actual invoked copies against.
     */
    it("seals the KVM subtree the execution job actually invokes", () => {
        assert.deepEqual([...WINDOWS_MSI_KVM_SUBTREE_MEMBERS], ["closure.json",
            "linux-kvm-capability.mjs", "linux-kvm-privileged-capability.mjs", "privileged-closure.json"]);
        const files = kvmFiles();
        const sealed = sealWindowsMsiKvmSubtree({files});
        assert.equal(sealed.kind, "myspeed-windows-msi-kvm-subtree");
        assert.equal(sealed.qualifying, false);
        assert.deepEqual(sealed.releaseGatesCleared, []);
        assert.deepEqual(sealed.files.map(file => file.name), [...WINDOWS_MSI_KVM_SUBTREE_MEMBERS]);
        assert.match(sealed.sha256, /^[0-9a-f]{64}$/u);
        /* The same tree seals to the same digest; one changed byte does not. */
        assert.equal(sealWindowsMsiKvmSubtree({files: kvmFiles()}).sha256, sealed.sha256);
        assert.notEqual(sealWindowsMsiKvmSubtree({files: kvmFiles(
            {"linux-kvm-capability.mjs": "tampered"})}).sha256, sealed.sha256);
    });

    it("refuses an invoked KVM copy that was tampered with after the seal", () => {
        const sealed = sealWindowsMsiKvmSubtree({files: kvmFiles()});
        assert.deepEqual(verifyWindowsMsiKvmSubtree({files: kvmFiles(), expectedSha256: sealed.sha256}),
            sealed.files);
        /* The executed module itself, swapped for something else of the same shape. */
        assert.throws(() => verifyWindowsMsiKvmSubtree({
            files: kvmFiles({"linux-kvm-capability.mjs": "attacker module"}),
            expectedSha256: sealed.sha256}), /KVM subtree/iu);
        /* And the manifest the module would otherwise validate itself against. */
        assert.throws(() => verifyWindowsMsiKvmSubtree({
            files: kvmFiles({"closure.json": "{\"module\":\"attacker\"}"}),
            expectedSha256: sealed.sha256}), /KVM subtree/iu);
        /* A member removed, a member added, and a digest that names a different tree. */
        const missing = kvmFiles();
        delete missing["privileged-closure.json"];
        assert.throws(() => verifyWindowsMsiKvmSubtree({files: missing,
            expectedSha256: sealed.sha256}), /KVM subtree/iu);
        assert.throws(() => verifyWindowsMsiKvmSubtree({
            files: {...kvmFiles(), "extra.mjs": Buffer.from("extra")},
            expectedSha256: sealed.sha256}), /KVM subtree/iu);
        assert.throws(() => verifyWindowsMsiKvmSubtree({files: kvmFiles(),
            expectedSha256: "f".repeat(64)}), /KVM subtree/iu);
        assert.throws(() => verifyWindowsMsiKvmSubtree({files: kvmFiles(),
            expectedSha256: "not-a-digest"}), /KVM subtree/iu);
    });
});
