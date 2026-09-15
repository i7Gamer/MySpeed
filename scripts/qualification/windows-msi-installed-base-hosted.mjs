import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import {validateHostedContext} from "./linux-kvm-capability.mjs";
import {runHostedOwnedProcess} from "./linux-windows-cpu-floor-stage2-hosted.mjs";
import {validateStage2Paths} from "./linux-windows-cpu-floor-stage2.mjs";

const EXPECTED_NODE_VERSION = "22.19.0";
const HELPER_NAME = "windows-msi-installed-base-seal-helper.mjs";
const HELPER_RELATIVE_PATH = `scripts/qualification/${HELPER_NAME}`;
const SHA256 = /^[a-f0-9]{64}$/u;
const MAX_HELPER_BYTES = 262_144;
const MAX_TOOL_BYTES = 268_435_456;
const MAX_IMAGE_BYTES = 63_986_931_712;
const MAX_STREAM_BYTES = 4_096;
const COMMAND_TIMEOUT_MILLISECONDS = 30_000;
const PRIVILEGED_TIMEOUT_SECONDS = 25;
const VIRTUAL_BYTES = 51_539_607_552;
const SUDO = "/usr/bin/sudo";
const TIMEOUT = "/usr/bin/timeout";
const INSTALL = "/usr/bin/install";
const ENV = "/usr/bin/env";

function sha256(bytes) { return crypto.createHash("sha256").update(bytes).digest("hex"); }

function exactKeys(value, expected, label) {
    if (!value || typeof value !== "object" || Array.isArray(value) ||
        JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...expected].sort()))
        throw new TypeError(`${label} keys are invalid`);
}

function successful(observation, label) {
    if (!observation?.process || observation.process.exitCode !== 0 || observation.process.signal !== null ||
        observation.process.timedOut !== false || observation.process.stdoutOverflow !== false ||
        observation.process.stderrOverflow !== false || observation.process.cleanupProven !== true ||
        observation.process.errorObserved !== false) throw new Error(`${label} did not complete safely`);
    return observation;
}

export function inspectHostedInstalledBaseFile(input, fileSystem = fs) {
    const target = typeof input === "string" ? input : input.path;
    const maximumBytes = typeof input === "string" ? MAX_IMAGE_BYTES : input.maximumBytes ?? MAX_IMAGE_BYTES;
    if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1 || maximumBytes > MAX_IMAGE_BYTES)
        throw new TypeError("hosted file bound is invalid");
    const canonical = fileSystem.realpathSync(target);
    if (canonical !== target) throw new Error("hosted file path is not canonical");
    const descriptor = fileSystem.openSync(target, fileSystem.constants.O_RDONLY | fileSystem.constants.O_NOFOLLOW);
    const digest = crypto.createHash("sha256");
    let before;
    try {
        before = fileSystem.fstatSync(descriptor, {bigint: true});
        if (!before.isFile() || before.nlink !== 1n || before.size < 1n || before.size > BigInt(maximumBytes))
            throw new Error("hosted file identity is invalid");
        if (fileSystem.realpathSync(`/proc/self/fd/${descriptor}`) !== target)
            throw new Error("hosted opened file path differs");
        const buffer = Buffer.allocUnsafe(1_048_576);
        let offset = 0n;
        while (offset < before.size) {
            const count = fileSystem.readSync(descriptor, buffer, 0, Number(
                before.size - offset > BigInt(buffer.length) ? BigInt(buffer.length) : before.size - offset), offset);
            if (count <= 0) throw new Error("hosted file read was truncated");
            digest.update(buffer.subarray(0, count));
            offset += BigInt(count);
        }
        const after = fileSystem.fstatSync(descriptor, {bigint: true});
        if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size ||
            before.mtimeNs !== after.mtimeNs || before.mode !== after.mode || before.uid !== after.uid ||
            before.gid !== after.gid || after.nlink !== 1n) throw new Error("hosted file changed while hashing");
    } finally { fileSystem.closeSync(descriptor); }
    return {path: canonical, kind: "file", dev: before.dev.toString(), ino: before.ino.toString(),
        bytes: before.size.toString(), sha256: digest.digest("hex"), ownership: {uid: before.uid.toString(),
            gid: before.gid.toString(), mode: Number(before.mode & 0o7777n).toString(8),
            ordinaryUserWritable: (before.mode & 0o022n) !== 0n}};
}

const defaultInspectFile = input => inspectHostedInstalledBaseFile(input);

function defaultInspectDirectory(target) {
    const lexical = fs.lstatSync(target, {bigint: true});
    const canonical = fs.realpathSync(target);
    const value = fs.statSync(canonical, {bigint: true});
    if (canonical !== target || !lexical.isDirectory() || !value.isDirectory() || lexical.dev !== value.dev ||
        lexical.ino !== value.ino) throw new Error("hosted directory identity is invalid");
    return {path: canonical, uid: value.uid.toString(), gid: value.gid.toString(),
        mode: Number(value.mode & 0o7777n).toString(8), ordinaryUserWritable: (value.mode & 0o022n) !== 0n,
        sticky: (value.mode & 0o1000n) !== 0n};
}

function defaultGroupAlive(processGroupId) {
    try { process.kill(-processGroupId, 0); return true; }
    catch (error) { if (error.code === "ESRCH") return false; throw error; }
}

function validateRuntime(context, environment, runtime) {
    if (runtime.platform !== "linux" || runtime.architecture !== "x64" || runtime.nodeVersion !== EXPECTED_NODE_VERSION ||
        environment.GITHUB_ACTIONS !== "true" || environment.CI !== "true" || environment.RUNNER_OS !== "Linux" ||
        environment.RUNNER_ARCH !== "X64" || environment.RUNNER_ENVIRONMENT !== "github-hosted" ||
        environment.GITHUB_REPOSITORY !== context.repository || environment.GITHUB_SHA !== context.eventSha ||
        environment.MYSPEED_SOURCE_SHA !== context.sourceSha ||
        environment.GITHUB_RUN_ID !== context.runId || environment.GITHUB_RUN_ATTEMPT !== context.runAttempt ||
        environment.ImageOS !== context.environment.ImageOS || environment.ImageVersion !== context.environment.ImageVersion ||
        !path.posix.isAbsolute(runtime.nodePath) || path.posix.normalize(runtime.nodePath) !== runtime.nodePath)
        throw new Error("hosted installed-base runtime is invalid");
}

function assertFile(value, expectedPath, expected = null) {
    exactKeys(value, ["bytes", "dev", "ino", "kind", "ownership", "path", "sha256"], "hosted file identity");
    exactKeys(value.ownership, ["gid", "mode", "ordinaryUserWritable", "uid"], "hosted file ownership");
    if (value.path !== expectedPath || value.kind !== "file" || !/^(?:0|[1-9][0-9]*)$/u.test(value.ownership.uid) ||
        !/^(?:0|[1-9][0-9]*)$/u.test(value.ownership.gid) || !/^[0-7]{3,4}$/u.test(value.ownership.mode) ||
        typeof value.ownership.ordinaryUserWritable !== "boolean" ||
        !/^[1-9][0-9]*$/u.test(value.dev) || !/^[1-9][0-9]*$/u.test(value.ino) ||
        !/^[1-9][0-9]*$/u.test(value.bytes) ||
        !SHA256.test(value.sha256) || (expected && (value.bytes !== String(expected.bytes) ||
        value.sha256 !== expected.sha256))) throw new Error("hosted root-owned file identity differs");
    return value;
}

function assertRootFile(value, expectedPath, expected = null) {
    const checked = assertFile(value, expectedPath, expected);
    if (checked.ownership.uid !== "0" || checked.ownership.gid !== "0" ||
        checked.ownership.ordinaryUserWritable !== false ||
        (Number.parseInt(checked.ownership.mode, 8) & 0o022) !== 0)
        throw new Error("hosted root-owned file identity differs");
    return checked;
}

function assertPortableRoot(inspectDirectory, portableRoot) {
    const value = inspectDirectory(portableRoot);
    if (value.path !== portableRoot || value.uid !== "0" || value.gid !== "0" || value.mode !== "755" ||
        value.ordinaryUserWritable !== false || value.sticky !== false)
        throw new Error("portable root identity is invalid");
}

function validateStage2Runtime(value, paths) {
    const toolchain = value?.toolchain;
    if (!toolchain?.qemuImg || !toolchain?.runtime?.loader || !Array.isArray(toolchain.runtime.libraryPath))
        throw new TypeError("installed-base qemu-img runtime is invalid");
    const expectedQemuImg = `${paths.portableRoot}/usr/bin/qemu-img`;
    const expectedLoader = `${paths.portableRoot}/usr/lib/x86_64-linux-gnu/ld-linux-x86-64.so.2`;
    const validateTool = (tool, expectedPath, invocation) => {
        exactKeys(tool, invocation ? ["bytes", "invocationPath", "ownership", "path", "sha256"] :
            ["bytes", "ownership", "path", "sha256"], "Stage 2 sealing tool");
        exactKeys(tool.ownership, ["gid", "mode", "ordinaryUserWritable", "uid"], "Stage 2 sealing tool ownership");
        if (tool.path !== expectedPath || invocation && tool.invocationPath !== expectedPath ||
            !/^[1-9][0-9]*$/u.test(tool.bytes) || !SHA256.test(tool.sha256) || tool.ownership.uid !== "0" ||
            tool.ownership.gid !== "0" || tool.ownership.ordinaryUserWritable !== false ||
            !/^[4567][045][045]$/u.test(tool.ownership.mode))
            throw new TypeError("installed-base qemu-img runtime is invalid");
        return structuredClone(tool);
    };
    const qemuImg = validateTool(toolchain.qemuImg, expectedQemuImg, true);
    const loader = validateTool(toolchain.runtime.loader, expectedLoader, false);
    const libraryPath = [path.posix.dirname(expectedLoader), `${paths.portableRoot}/usr/lib/7zip`];
    if (JSON.stringify(toolchain.runtime.libraryPath) !== JSON.stringify(libraryPath))
        throw new TypeError("installed-base qemu-img library path is invalid");
    return {qemuImg, runtime: {loader, libraryPath}};
}

export async function prepareHostedInstalledBaseOperations(input, dependencies = {}) {
    exactKeys(input, ["context", "helperSource", "paths", "stage2Result"], "hosted installed-base input");
    const context = validateHostedContext(input.context);
    const paths = validateStage2Paths(input.paths, context);
    const environment = dependencies.environment ?? process.env;
    const runtime = dependencies.runtime ?? {platform: process.platform, architecture: process.arch,
        nodeVersion: process.versions.node, nodePath: process.execPath};
    validateRuntime(context, environment, runtime);
    exactKeys(input.helperSource, ["bytes", "path", "sha256"], "installed-base helper source");
    const closureRoot = `/home/runner/work/_temp/myspeed-stage2-closure-${context.nonce}`;
    if (input.helperSource.path !== `${closureRoot}/${HELPER_RELATIVE_PATH}` ||
        !Number.isSafeInteger(input.helperSource.bytes) || input.helperSource.bytes < 1 ||
        input.helperSource.bytes > MAX_HELPER_BYTES || !SHA256.test(input.helperSource.sha256))
        throw new TypeError("installed-base helper closure identity is invalid");
    const toolchain = validateStage2Runtime(input.stage2Result, paths);
    const io = {inspectFile: dependencies.inspectFile ?? defaultInspectFile,
        inspectDirectory: dependencies.inspectDirectory ?? defaultInspectDirectory,
        pathExists: dependencies.pathExists ?? fs.existsSync,
        runOwned: dependencies.runOwned ?? ((command, argv, options) => runHostedOwnedProcess(command, argv, options)),
        isProcessGroupAlive: dependencies.isProcessGroupAlive ?? defaultGroupAlive};
    assertFile(io.inspectFile({path: input.helperSource.path, maximumBytes: MAX_HELPER_BYTES}),
        input.helperSource.path, input.helperSource);
    assertPortableRoot(io.inspectDirectory, paths.portableRoot);
    const helperPath = `${paths.portableRoot}/${HELPER_NAME}`;
    const stagedNodePath = `${paths.portableRoot}/node-v${EXPECTED_NODE_VERSION}`;
    if (io.pathExists(helperPath) || io.pathExists(stagedNodePath))
        throw new Error("installed-base staged target already exists");
    const nodeSource = assertFile(io.inspectFile({path: runtime.nodePath, maximumBytes: MAX_TOOL_BYTES}),
        runtime.nodePath);
    const fixedTools = new Map([SUDO, TIMEOUT, INSTALL, ENV].map(target =>
        [target, assertRootFile(io.inspectFile({path: target, maximumBytes: MAX_TOOL_BYTES}), target)]));
    const stage = async (sourcePath, targetPath, mode, label) => {
        const install = ["-n", "--", TIMEOUT, "--foreground", "--signal=KILL", `${PRIVILEGED_TIMEOUT_SECONDS}s`,
            INSTALL, "-o", "root", "-g", "root", "-m", mode, "--", sourcePath, targetPath];
        successful(await io.runOwned(SUDO, install,
            {timeoutMs: COMMAND_TIMEOUT_MILLISECONDS, maxStreamBytes: MAX_STREAM_BYTES}), label);
    };
    await stage(input.helperSource.path, helperPath, "0444", "helper staging");
    await stage(runtime.nodePath, stagedNodePath, "0555", "Node runtime staging");
    assertPortableRoot(io.inspectDirectory, paths.portableRoot);
    const helperIdentity = assertRootFile(io.inspectFile({path: helperPath, maximumBytes: MAX_HELPER_BYTES}),
        helperPath, input.helperSource);
    const nodeIdentity = assertRootFile(io.inspectFile({path: stagedNodePath, maximumBytes: MAX_TOOL_BYTES}),
        stagedNodePath, nodeSource);
    const unchanged = (expected, label, maximumBytes = MAX_TOOL_BYTES) => {
        const observed = assertRootFile(io.inspectFile({path: expected.path, maximumBytes}), expected.path, expected);
        if ((expected.dev !== undefined && observed.dev !== expected.dev) ||
            (expected.ino !== undefined && observed.ino !== expected.ino)) throw new Error(`${label} identity differs`);
        return observed;
    };
    const assertLaunchClosure = () => {
        assertPortableRoot(io.inspectDirectory, paths.portableRoot);
        unchanged(nodeIdentity, "Node runtime"); unchanged(helperIdentity, "installed-base helper", MAX_HELPER_BYTES);
        for (const [target, expected] of fixedTools) unchanged(expected, target);
    };
    return Object.freeze({
        inspectFile: request => io.inspectFile({...request, maximumBytes: MAX_IMAGE_BYTES}),
        async observeQemuGroup(request) {
            return {processGroupId: request.processGroupId,
                activeProcesses: io.isProcessGroupAlive(request.processGroupId) ? 1 : 0};
        },
        async inspectQcow2(request) {
            if (request.path !== paths.systemDisk || request.qemuImgPath !== toolchain.qemuImg.path)
                throw new TypeError("installed-base qemu-img request differs");
            assertPortableRoot(io.inspectDirectory, paths.portableRoot);
            unchanged(toolchain.runtime.loader, "portable runtime loader");
            unchanged(toolchain.qemuImg, "portable qemu-img");
            const argv = ["--argv0", toolchain.qemuImg.invocationPath, "--library-path",
                toolchain.runtime.libraryPath.join(":"), toolchain.qemuImg.path, "info", "--output=json", request.path];
            const observation = successful(await io.runOwned(toolchain.runtime.loader.path, argv,
                {timeoutMs: COMMAND_TIMEOUT_MILLISECONDS, maxStreamBytes: MAX_STREAM_BYTES}), "qemu-img inspection");
            let value;
            try { value = JSON.parse(observation.stdout.toString("utf8")); }
            catch { throw new Error("qemu-img metadata is invalid"); }
            if (!value || typeof value !== "object" || Array.isArray(value) || value.format !== "qcow2" ||
                value["virtual-size"] !== VIRTUAL_BYTES ||
                (value["backing-filename"] !== undefined && value["backing-filename"] !== null))
                throw new Error("qemu-img metadata differs");
            return {format: "qcow2", virtualBytes: String(VIRTUAL_BYTES), backingFilename: null};
        },
        async sealExact(request) {
            exactKeys(request, ["dev", "gid", "ino", "kind", "mode", "path", "uid"],
                "installed-base privileged seal request");
            if (request.path !== paths.systemDisk || request.kind !== "file" || request.uid !== "0" ||
                request.gid !== "0" || request.mode !== "444") throw new TypeError("privileged seal request differs");
            assertLaunchClosure();
            const hostedEnvironment = ["GITHUB_ACTIONS=true", "CI=true", "RUNNER_OS=Linux", "RUNNER_ARCH=X64",
                "RUNNER_ENVIRONMENT=github-hosted"];
            const argv = ["-n", "--", TIMEOUT, "--foreground", "--signal=KILL", `${PRIVILEGED_TIMEOUT_SECONDS}s`,
                ENV, "-i", ...hostedEnvironment, stagedNodePath, helperPath, "seal", "--nonce", context.nonce,
                "--path", request.path, "--dev", request.dev, "--ino", request.ino];
            successful(await io.runOwned(SUDO, argv,
                {timeoutMs: COMMAND_TIMEOUT_MILLISECONDS, maxStreamBytes: MAX_STREAM_BYTES}),
            "installed-base descriptor seal");
        }
    });
}
