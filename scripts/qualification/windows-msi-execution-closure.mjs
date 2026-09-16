/*
 * The exact source closures the post-release MSI lifecycle executes.
 *
 * Two of them, and they are not the same set. The controller closure is every module the Linux
 * controller loads, plus the installed-base seal helper, which is staged and run as its own process
 * rather than imported - an import trace alone would miss it. The guest closure is what is written
 * onto the seed medium for the disposable Windows guest: the matrix executor and the modules it
 * imports, the four PowerShell helpers, and the oracle scripts the rows invoke.
 *
 * The earlier eight-module Stage 2 closure is not either of these. It predates the installed-base
 * helpers and the MSI controller, and sealing it would leave the execution job resolving imports
 * that the sealed tree does not contain.
 *
 * The execution phase runs from the sealed tree with no checkout, so the inventory has to be exact
 * in both directions: a missing member breaks the run, and an unlisted member is source that nobody
 * bound a hash to. `tests/server/windowsMsiExecutionClosure.test.js` recomputes both closures from
 * the repository and fails when either list drifts from what the code actually imports.
 */
import {createHash} from "node:crypto";

const SCHEMA_VERSION = 1;
const MANIFEST_KIND = "myspeed-windows-msi-execution-closure";
const MAX_MEMBER_BYTES = 4_194_304;
const SHA256 = /^[0-9a-f]{64}$/u;
const SHA1 = /^[0-9a-f]{40}$/u;
const NONCE = /^[0-9a-f]{32}$/u;
const DECIMAL = /^[1-9][0-9]{0,19}$/u;
const REPOSITORY = /^[A-Za-z0-9._-]{1,100}\/[A-Za-z0-9._-]{1,100}$/u;
const MEMBER_PATH = /^(?:scripts)\/(?:qualification|release)\/[A-Za-z0-9._-]{1,128}$/u;

export const WINDOWS_MSI_CONTROLLER_ENTRY = "scripts/release/post-release-msi-linux-controller.mjs";
export const WINDOWS_MSI_GUEST_ENTRY = "scripts/qualification/windows-msi-guest-matrix-executor.mjs";

/*
 * Closure members that no import trace can find, because the execution job reaches them itself: the
 * installed-base seal helper is staged and run as its own process from
 * `<closureRoot>/scripts/qualification/windows-msi-installed-base-seal-helper.mjs`, the privileged
 * KVM capability CLI produces the reviewed-sudo observation the Stage 2 request carries, and the
 * Stage 2 request builder and the budget admission are imported by the job's own steps from the
 * sealed tree rather than by the controller entry. Every one of them
 * executes, so every one of them is sealed and re-hashed like any other member.
 */
export const WINDOWS_MSI_CONTROLLER_INVOKED_MEMBERS = Object.freeze([
    "scripts/qualification/windows-msi-installed-base-seal-helper.mjs",
    "scripts/qualification/linux-kvm-privileged-capability.mjs",
    "scripts/qualification/windows-msi-stage2-request.mjs"
]);

/*
 * A second guest entry beside the matrix executor: the guest stages this one and runs it through the
 * same generic launcher to produce the containment calibration before any matrix row starts.
 */
export const WINDOWS_MSI_GUEST_PREFLIGHT_ENTRY =
    "scripts/qualification/windows-msi-guest-containment-preflight-executor.mjs";

export const WINDOWS_MSI_CONTROLLER_IMPORT_CLOSURE = Object.freeze([
    "scripts/qualification/linux-kvm-capability.mjs",
    "scripts/qualification/linux-windows-cpu-floor-admission.mjs",
    "scripts/qualification/linux-windows-cpu-floor-stage2-controller.mjs",
    "scripts/qualification/linux-windows-cpu-floor-stage2-hosted.mjs",
    "scripts/qualification/linux-windows-cpu-floor-stage2-qmp.mjs",
    "scripts/qualification/linux-windows-cpu-floor-stage2.mjs",
    "scripts/qualification/linux-windows-msi-lifecycle-host.mjs",
    "scripts/qualification/windows-baseline-guest-fixture-bundle.mjs",
    "scripts/qualification/windows-baseline-guest-runtime-bundle.mjs",
    "scripts/qualification/windows-msi-containment-preflight-host.mjs",
    "scripts/qualification/windows-msi-containment-preflight.mjs",
    "scripts/qualification/windows-msi-guest-bootstrap.mjs",
    "scripts/qualification/windows-msi-guest-containment-preflight-executor.mjs",
    "scripts/qualification/windows-msi-guest-lifecycle-evidence.mjs",
    "scripts/qualification/windows-msi-guest-matrix-executor.mjs",
    "scripts/qualification/windows-msi-guest-matrix-operations.mjs",
    "scripts/qualification/windows-msi-guest-matrix-row.mjs",
    "scripts/qualification/windows-msi-guest-seed-documents.mjs",
    "scripts/qualification/windows-msi-installed-base-hosted.mjs",
    "scripts/qualification/windows-msi-installed-base.mjs",
    "scripts/qualification/windows-msi-lifecycle-budget.mjs",
    "scripts/qualification/windows-msi-matrix-contract.mjs",
    "scripts/qualification/windows-msi-post-setup-activation.mjs",
    "scripts/qualification/windows-msi-prerequisite-evidence.mjs",
    "scripts/qualification/windows-msi-scenario0-calibration.mjs",
    "scripts/release/post-release-msi-acquisition.mjs",
    "scripts/release/post-release-msi-baseline-input-preparation.mjs",
    "scripts/release/post-release-msi-envelope.mjs",
    "scripts/release/post-release-msi-fixture-preparation.mjs",
    "scripts/release/post-release-msi-host-bridge.mjs",
    "scripts/release/post-release-msi-host-request.mjs",
    "scripts/release/post-release-msi-hosted-prepare.mjs",
    "scripts/release/post-release-msi-linux-controller.mjs",
    "scripts/release/post-release-msi-linux-fixture.mjs",
    "scripts/release/post-release-target.mjs"
]);

export const WINDOWS_MSI_CONTROLLER_CLOSURE = Object.freeze([...WINDOWS_MSI_CONTROLLER_IMPORT_CLOSURE,
    ...WINDOWS_MSI_CONTROLLER_INVOKED_MEMBERS].sort());

/*
 * Seeded onto the guest medium under their basenames, which is how the guest's own relative imports
 * resolve. The four PowerShell helpers and the oracle scripts are invoked as processes, so they are
 * closure members that no import trace reaches either.
 */
export const WINDOWS_MSI_GUEST_IMPORT_CLOSURE = Object.freeze([
    "scripts/qualification/windows-msi-guest-matrix-executor.mjs",
    "scripts/qualification/windows-msi-guest-matrix-operations.mjs",
    "scripts/qualification/windows-msi-guest-matrix-row.mjs",
    "scripts/qualification/windows-msi-matrix-contract.mjs",
    "scripts/qualification/check-artifact.mjs",
    "scripts/qualification/safety.mjs",
    "scripts/qualification/fixture.mjs",
    "scripts/qualification/sqlite-check.mjs"
]);

export const WINDOWS_MSI_GUEST_INVOKED_MEMBERS = Object.freeze([
    WINDOWS_MSI_GUEST_PREFLIGHT_ENTRY,
    "scripts/qualification/media-job-launcher.ps1",
    "scripts/qualification/windows-msi-guest-runner.ps1",
    "scripts/qualification/windows-msi-guest-rollback.ps1",
    "scripts/qualification/windows-msi-guest-containment.ps1"
]);

export const WINDOWS_MSI_GUEST_CLOSURE = Object.freeze([...WINDOWS_MSI_GUEST_IMPORT_CLOSURE,
    ...WINDOWS_MSI_GUEST_INVOKED_MEMBERS].sort());

const isObject = value => value !== null && typeof value === "object" && !Array.isArray(value);

const exactKeys = (value, expected, label) => {
    if (!isObject(value)) throw new TypeError(`${label} differs`);
    const actual = Object.keys(value).sort();
    const wanted = [...expected].sort();
    if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index]))
        throw new TypeError(`${label} differs`);
    return value;
};

const exactString = (value, label, pattern) => {
    if (typeof value !== "string" || !pattern.test(value)) throw new TypeError(`${label} differs`);
    return value;
};

const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");

const assertContext = value => {
    exactKeys(value, ["repository", "sourceSha", "eventSha", "runId", "runAttempt", "nonce"],
        "MSI execution closure context");
    exactString(value.repository, "MSI execution closure repository", REPOSITORY);
    exactString(value.sourceSha, "MSI execution closure source SHA-1", SHA1);
    exactString(value.eventSha, "MSI execution closure event SHA-1", SHA1);
    exactString(value.runId, "MSI execution closure run", DECIMAL);
    exactString(value.runAttempt, "MSI execution closure attempt", /^[1-9][0-9]{0,9}$/u);
    exactString(value.nonce, "MSI execution closure nonce", NONCE);
    return value;
};

const groupDigest = members => sha256(Buffer.from(JSON.stringify(members
    .map(member => [member.path, member.bytes, member.sha256])), "utf8"));

/*
 * Exact in both directions: the observed set has to be the declared set, with no member missing,
 * repeated or added, and every member has to arrive with its own recomputed length and digest.
 */
const bindGroup = (declared, observed, entry, label) => {
    if (!Array.isArray(observed)) throw new TypeError(`${label} observations differ`);
    const byPath = new Map();
    for (const item of observed) {
        exactKeys(item, ["path", "bytes", "sha256"], `${label} member`);
        exactString(item.path, `${label} member path`, MEMBER_PATH);
        exactString(item.bytes, `${label} member bytes`, /^[1-9][0-9]{0,9}$/u);
        exactString(item.sha256, `${label} member SHA-256`, SHA256);
        if (Number(item.bytes) > MAX_MEMBER_BYTES)
            throw new Error(`${label} member ${item.path} exceeds its bound`);
        if (byPath.has(item.path)) throw new Error(`${label} member ${item.path} is repeated`);
        byPath.set(item.path, item);
    }
    const members = declared.map(item => {
        const observation = byPath.get(item);
        if (!observation) throw new Error(`${label} member ${item} is absent`);
        byPath.delete(item);
        return Object.freeze({path: item, bytes: observation.bytes, sha256: observation.sha256});
    });
    if (byPath.size > 0)
        throw new Error(`${label} carries unlisted source: ${[...byPath.keys()].sort().join(", ")}`);
    if (!declared.includes(entry)) throw new Error(`${label} entry ${entry} is not a member`);
    return Object.freeze({entry, files: Object.freeze(members), sha256: groupDigest(members)});
};

export const sealWindowsMsiExecutionClosure = ({context, controller, guest}) => {
    const expected = assertContext(context);
    const controllerGroup = bindGroup(WINDOWS_MSI_CONTROLLER_CLOSURE, controller,
        WINDOWS_MSI_CONTROLLER_ENTRY, "MSI controller closure");
    const guestGroup = bindGroup(WINDOWS_MSI_GUEST_CLOSURE, guest, WINDOWS_MSI_GUEST_ENTRY,
        "MSI guest closure");
    const manifest = {schemaVersion: SCHEMA_VERSION, kind: MANIFEST_KIND, qualifying: false,
        repository: expected.repository, sourceSha: expected.sourceSha, eventSha: expected.eventSha,
        runId: expected.runId, runAttempt: expected.runAttempt, nonce: expected.nonce,
        controller: controllerGroup, guest: guestGroup,
        sha256: sha256(Buffer.from(JSON.stringify([controllerGroup.sha256, guestGroup.sha256]), "utf8")),
        releaseGatesCleared: Object.freeze([])};
    return Object.freeze(manifest);
};

/*
 * The KVM subtree the execution job actually invokes.
 *
 * `linux-kvm-capability.mjs` pins its own closure root to `$RUNNER_TEMP/linux-kvm-capability-closure`
 * and refuses anything else, so the execution job cannot reach the copies inside the verified MSI
 * closure through the KVM contract: it has to carry a second tree of the same two modules, with the
 * two manifests the seal job generates beside them. That tree travels inside the same artifact, and
 * `validateClosureManifest` checks the module's bytes against the manifest sitting next to it - which
 * is a tree validating itself, and proves nothing about who wrote it.
 *
 * So the seal job seals this tree too and publishes only the digest, as a job output that travels
 * through the workflow run rather than inside the artifact. The execution job re-derives the digest
 * from the files it is about to execute and compares. The member list is exact in both directions:
 * a missing member, an unlisted member and a changed byte are each refused.
 */
const KVM_SUBTREE_KIND = "myspeed-windows-msi-kvm-subtree";

export const WINDOWS_MSI_KVM_SUBTREE_MEMBERS = Object.freeze(["closure.json",
    "linux-kvm-capability.mjs", "linux-kvm-privileged-capability.mjs", "privileged-closure.json"]);

const bindKvmFiles = files => {
    if (files === null || typeof files !== "object" || Array.isArray(files))
        throw new TypeError("MSI KVM subtree differs");
    const present = Object.keys(files).sort();
    const wanted = [...WINDOWS_MSI_KVM_SUBTREE_MEMBERS];
    if (present.length !== wanted.length || present.some((name, index) => name !== wanted[index]))
        throw new Error("MSI KVM subtree membership differs");
    return WINDOWS_MSI_KVM_SUBTREE_MEMBERS.map(name => {
        const bytes = files[name];
        if (!Buffer.isBuffer(bytes) || bytes.length < 1 || bytes.length > MAX_MEMBER_BYTES)
            throw new Error(`MSI KVM subtree member ${name} differs`);
        return Object.freeze({name, bytes: String(bytes.length), sha256: sha256(bytes)});
    });
};

export const sealWindowsMsiKvmSubtree = ({files}) => {
    const bound = bindKvmFiles(files);
    return Object.freeze({schemaVersion: SCHEMA_VERSION, kind: KVM_SUBTREE_KIND, qualifying: false,
        files: Object.freeze(bound),
        sha256: sha256(Buffer.from(JSON.stringify(bound.map(file =>
            [file.name, file.bytes, file.sha256])), "utf8")),
        releaseGatesCleared: Object.freeze([])});
};

export const verifyWindowsMsiKvmSubtree = ({files, expectedSha256}) => {
    if (typeof expectedSha256 !== "string" || !SHA256.test(expectedSha256))
        throw new TypeError("MSI KVM subtree expected digest differs");
    const sealed = sealWindowsMsiKvmSubtree({files});
    if (sealed.sha256 !== expectedSha256)
        throw new Error("MSI KVM subtree differs from the digest sealed beside it");
    return sealed.files;
};

export const validateWindowsMsiExecutionClosureManifest = (value, context) => {
    const expected = assertContext(context);
    exactKeys(value, ["schemaVersion", "kind", "qualifying", "repository", "sourceSha", "eventSha",
        "runId", "runAttempt", "nonce", "controller", "guest", "sha256", "releaseGatesCleared"],
    "MSI execution closure manifest");
    if (value.schemaVersion !== SCHEMA_VERSION || value.kind !== MANIFEST_KIND || value.qualifying !== false)
        throw new TypeError("MSI execution closure manifest differs");
    for (const name of ["repository", "sourceSha", "eventSha", "runId", "runAttempt", "nonce"])
        if (value[name] !== expected[name])
            throw new Error(`MSI execution closure manifest ${name} differs from the execution context`);
    if (!Array.isArray(value.releaseGatesCleared) || value.releaseGatesCleared.length !== 0)
        throw new Error("MSI execution closure manifest cleared gates differ");
    const rebound = sealWindowsMsiExecutionClosure({context: expected,
        controller: value.controller?.files, guest: value.guest?.files});
    if (value.controller?.entry !== rebound.controller.entry
        || value.guest?.entry !== rebound.guest.entry
        || value.controller?.sha256 !== rebound.controller.sha256
        || value.guest?.sha256 !== rebound.guest.sha256 || value.sha256 !== rebound.sha256)
        throw new Error("MSI execution closure manifest digests differ");
    return rebound;
};
