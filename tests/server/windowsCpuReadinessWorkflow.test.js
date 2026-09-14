import {describe, it} from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import {spawnSync} from "node:child_process";
import {parse} from "yaml";
import {readSource} from "../helpers/source.js";

const WORKFLOW = ".github/workflows/windows-cpu-readiness.yml";
const CONTROLLER = "scripts/qualification/windows-cpu-readiness-controller.ps1";
const CORE = "scripts/qualification/windows-cpu-readiness.ps1";
const FILES = ["windows-cpu-floor-probe.c", "windows-cpu-readiness.ps1",
    "windows-cpu-readiness-controller.ps1", "windows-cpu-tool-child.ps1",
    "windows-cpu-file-identity.ps1", "media-job-launcher.ps1"];
const SOURCE = "${{ github.event_name == 'pull_request' && github.event.pull_request.head.sha || github.sha }}";
const JOB_TIMEOUT_MINUTES = 20;
const SHELL_TIMEOUT_MS = 15_000;
const MAX_MANIFEST_BYTES = 8_192;
const MAX_RESULT_BYTES = 262_144;
const MAX_DISASSEMBLY_BYTES = 2_097_152;
const MAX_AGGREGATE_BYTES = 33_554_432;
const MAX_EVIDENCE_ENTRIES = 256;
const SOURCE_SHA = "a".repeat(40);
const EVENT_SHA = "b".repeat(40);
const NONCE = "123e4567e89b42d3a456426614174000";
const RUN_ID = "123456789";
const RUN_ATTEMPT = "2";
const POWERSHELL = process.platform === "win32" ? "pwsh.exe" : "pwsh";
const HAS_POWERSHELL = spawnSync(POWERSHELL, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "exit 0"],
    {timeout: SHELL_TIMEOUT_MS}).status === 0;
const config = () => parse(readSource(WORKFLOW));
const action = (job, name) => job.steps.find(({uses}) => uses?.startsWith(`${name}@`));
const MODES = ["cpuid", "known-good", "known-bad", "illegal", "sse42", "popcnt", "avx", "avx2"];
const INSTRUCTION_MODES = ["cpuid", "illegal", "sse42", "popcnt", "avx", "avx2"];
const EXPECTED_EXITS = {cpuid: 0, "known-good": 0, "known-bad": 19, illegal: 3_221_225_501,
    sse42: 0, popcnt: 0, avx: 0, avx2: 0};
const OPERATION_IDS = ["discover-vswhere", "environment-preflight",
    ...MODES.flatMap(mode => [`compile-${mode}`, `link-${mode}`]),
    ...INSTRUCTION_MODES.map(mode => `disassemble-${mode}`), ...MODES.map(mode => `probe-${mode}`)];
const CLASSIFICATION = "windows-native-host-observation-nonqualifying";
const IMAGE_VERSION = "win25-vs2026";
const COMPILE_ARGUMENTS = ["/nologo", "/TC", "/c", "/W4", "/WX", "/O2", "/Oi", "/GS", "/guard:cf", "/MT"];
const LINK_ARGUMENTS = ["/NOLOGO", "/INCREMENTAL:NO", "/SUBSYSTEM:CONSOLE", "/MACHINE:X64",
    "/DYNAMICBASE", "/NXCOMPAT", "/HIGHENTROPYVA", "/GUARD:CF", "/MANIFEST:NO"];
const COMPILER_ENVIRONMENT_NAMES = ["CL", "_CL_", "LINK", "_LINK_"];
const COMPILER_ENVIRONMENT_FAILURE_EXIT = 71;
const sha256 = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const syntheticCpuid = () => ({
    schemaVersion: 1, kind: "cpuid", maxBasicLeaf: 7,
    leaf1: {eax: "0x000106a3", ebx: "0x00000800", ecx: "0x18900000", edx: "0x078bfbfd"},
    leaf7Subleaf0: {eax: "0x00000000", ebx: "0x00000020", ecx: "0x00000000", edx: "0x00000000"},
    xcr0: "0x0000000000000007", features: {sse42: true, popcnt: true, osxsave: true, avx: true, avx2: true}
});
const probeOutput = mode => {
    if (mode === "cpuid") return JSON.stringify(syntheticCpuid());
    if (mode === "illegal") return "";
    const result = {"known-good": 42, "known-bad": 13, sse42: 2_276_049_685, popcnt: 32, avx: 72, avx2: 72}[mode];
    return JSON.stringify({schemaVersion: 1, kind: mode, result});
};
const disassemblyText = mode => {
    const symbol = {cpuid: "main", illegal: "main", sse42: "run_sse42", popcnt: "run_popcnt",
        avx: "run_avx", avx2: "run_avx2"}[mode];
    const instructions = {cpuid: ["cpuid", "xgetbv"], illegal: ["ud2"], sse42: ["crc32"],
        popcnt: ["popcnt"], avx: ["vaddps"], avx2: ["vpaddd"]}[mode];
    return `${symbol}:\n${instructions.map((instruction, index) =>
        `  00000000000000${index}:  90 ${instruction} eax, eax`).join("\n")}\nnext_symbol:\n`;
};
const quoteCmdToken = value => value.length === 0 || /[\s\\()]/u.test(value) ? `"${value}"` : value;
const renderVcCommand = (vcvarsPath, toolPath, operationArguments) => [
    "@echo off", "setlocal DisableDelayedExpansion",
    ...COMPILER_ENVIRONMENT_NAMES.map(name => `if defined ${name} exit /b ${COMPILER_ENVIRONMENT_FAILURE_EXIT}`),
    `call "${vcvarsPath}" >nul`, "if errorlevel 1 exit /b %errorlevel%",
    ...COMPILER_ENVIRONMENT_NAMES.flatMap(name => [
        `if defined ${name} exit /b ${COMPILER_ENVIRONMENT_FAILURE_EXIT}`, `set "${name}="`]),
    `"${toolPath}" ${operationArguments.map(quoteCmdToken).join(" ")}`, "exit /b %errorlevel%", ""
].join("\r\n");
const renderPreflightCommand = vcvarsPath => [
    "@echo off", "setlocal DisableDelayedExpansion",
    ...COMPILER_ENVIRONMENT_NAMES.map(name => `if defined ${name} exit /b ${COMPILER_ENVIRONMENT_FAILURE_EXIT}`),
    `call "${vcvarsPath}" >nul`, "if errorlevel 1 exit /b %errorlevel%",
    ...COMPILER_ENVIRONMENT_NAMES.flatMap(name => [
        `if defined ${name} exit /b ${COMPILER_ENVIRONMENT_FAILURE_EXIT}`, `set "${name}="`]),
    "echo MYSPEED_ENV_BEGIN", ...["VCToolsVersion", "VCToolsInstallDir", "WindowsSdkDir", "WindowsSDKVersion"]
        .map(name => `echo ${name}=%${name}%`), "echo MYSPEED_ENV_END", "exit /b 0", ""
].join("\r\n");

const writeIdentityFile = (filePath, name, role, content, sequence) => {
    const bytes = Buffer.from(content);
    fs.mkdirSync(path.dirname(filePath), {recursive: true});
    fs.writeFileSync(filePath, bytes);
    return {schemaVersion: 1, name, role, path: filePath, finalPath: filePath,
        volumeSerial: "00000001", fileId: sequence.toString(16).padStart(16, "0"), bytes: bytes.length,
        lastWriteFileTime: "01dc000000000001", linkCount: 1, sha256: sha256(bytes),
        fileVersion: null, productVersion: null};
};
const readIdentityFile = (filePath, name, role, sequence) => {
    const bytes = fs.readFileSync(filePath);
    return {schemaVersion: 1, name, role, path: filePath, finalPath: filePath,
        volumeSerial: "00000001", fileId: sequence.toString(16).padStart(16, "0"), bytes: bytes.length,
        lastWriteFileTime: "01dc000000000001", linkCount: 1, sha256: sha256(bytes),
        fileVersion: null, productVersion: null};
};
const rewriteIdentityFile = (identity, value) => {
    const bytes = Buffer.from(typeof value === "string" ? value : JSON.stringify(value));
    fs.writeFileSync(identity.path, bytes);
    identity.bytes = bytes.length;
    identity.sha256 = sha256(bytes);
};

const makeCompletedEvidence = root => {
    const evidenceRoot = path.join(root, `myspeed-cpu-readiness-${NONCE}`);
    const closureRoot = path.join(root, "windows-cpu-readiness-closure");
    fs.mkdirSync(evidenceRoot);
    fs.mkdirSync(closureRoot);
    let sequence = 1;
    const closureRecords = FILES.map(name => {
        const source = name === "windows-cpu-readiness.ps1" || name === "windows-cpu-file-identity.ps1"
            ? fs.readFileSync(path.join("scripts", "qualification", name)) : Buffer.from(`synthetic ${name}\n`);
        return writeIdentityFile(path.join(closureRoot, name), `closure-${FILES.indexOf(name)}`,
            name === FILES[0] ? "source" : "closure", source, sequence++);
    });
    const manifest = {schemaVersion: 1, kind: "myspeed-windows-cpu-readiness-closure",
        expectedRunId: RUN_ID, expectedRunAttempt: RUN_ATTEMPT, expectedSourceSha: SOURCE_SHA,
        expectedEventSha: EVENT_SHA, nonce: NONCE,
        files: FILES.map((name, index) => ({name, bytes: closureRecords[index].bytes,
            sha256: closureRecords[index].sha256}))};
    const manifestIdentity = writeIdentityFile(path.join(closureRoot, "closure.json"), "closure-manifest", "closure",
        JSON.stringify(manifest), sequence++);
    const vcToolsVersion = "14.0.00000";
    const systemRoot = process.env.SystemRoot;
    const programFilesX86 = path.join(root, "Program Files (x86)");
    const installationPath = path.join(root, "Visual Studio");
    const vcToolRoot = path.join(installationPath, "VC", "Tools", "MSVC", vcToolsVersion, "bin", "Hostx64", "x64");
    const toolPaths = {
        powershell: path.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
        cmd: path.join(systemRoot, "System32", "cmd.exe"),
        vswhere: path.join(programFilesX86, "Microsoft Visual Studio", "Installer", "vswhere.exe"),
        vcvars: path.join(installationPath, "VC", "Auxiliary", "Build", "vcvars64.bat"),
        cl: path.join(vcToolRoot, "cl.exe"), link: path.join(vcToolRoot, "link.exe"),
        dumpbin: path.join(vcToolRoot, "dumpbin.exe")
    };
    const tools = Object.fromEntries(Object.entries(toolPaths).map(([name, toolPath]) => [name,
        ["powershell", "cmd"].includes(name)
            ? readIdentityFile(toolPath, name, "system-tool", sequence++)
            : writeIdentityFile(toolPath, name, "system-tool", `synthetic ${name}\n`, sequence++)]));
    const versionFile = writeIdentityFile(path.join(installationPath, "VC", "Auxiliary", "Build",
        "Microsoft.VCToolsVersion.default.txt"), "vc-version", "system-tool", `${vcToolsVersion}\n`, sequence++);
    const operations = OPERATION_IDS.map((operationId, index) => {
        const isProbe = operationId.startsWith("probe-");
        const mode = isProbe ? operationId.slice("probe-".length) : null;
        const toolName = isProbe ? `${mode.replaceAll("-", "_")}-executable` :
            operationId === "discover-vswhere" ? "vswhere" : "cmd";
        const operationArguments = isProbe ? [] : operationId === "discover-vswhere"
            ? ["-latest", "-products", "*", "-requires", "Microsoft.VisualStudio.Component.VC.Tools.x86.x64",
                "-property", "installationPath", "-format", "value", "-utf8"]
            : ["/d", "/s", "/c", `.\\${operationId}.cmd`];
        return {operationId, tool: toolName, toolSha256: isProbe ? "c".repeat(64) : tools[toolName].sha256,
        arguments: operationArguments, isProbe, classification: CLASSIFICATION,
        launcher: {schemaVersion: 1, authorizesTransfer: false, processId: 1000 + index,
            exitCode: 0, timedOut: false, processTreeExitProven: true},
        wrapper: {schemaVersion: 1, status: "completed", childProcessId: 2000 + index,
            exitCode: isProbe ? EXPECTED_EXITS[mode] : 0, timedOut: false, durationMilliseconds: 1,
            stdoutBytes: 0, stderrBytes: 0, outputDrainProven: true,
            childJobMembershipProven: true, errorModeRestored: true},
        childProofs: {parentJobMembershipProven: true, childExitProven: true, handlesClosedProven: true},
        errorMode: isProbe ? {required: true, requiredFlags: 3, before: 0, during: 3, after: 0, restored: true}
            : {required: false, requiredFlags: 0, before: null, during: null, after: null, restored: true},
        request: null, result: null};
    });
    const build = MODES.map(mode => {
        const stem = mode.replaceAll("-", "_");
        const macro = `PROBE_${stem.toUpperCase()}`;
        const architecture = mode === "avx" ? "/arch:AVX" : mode === "avx2" ? "/arch:AVX2" : "/arch:SSE2";
        const object = writeIdentityFile(path.join(evidenceRoot, `${stem}.obj`), `${stem}-object`,
            "generated-command", "object", sequence++);
        const executable = writeIdentityFile(path.join(evidenceRoot, `${stem}.exe`), `${stem}-executable`,
            "generated-command", "executable", sequence++);
        return {mode, macro, architecture,
            compileArguments: [...COMPILE_ARGUMENTS, `/Fo${object.path}`, `/D${macro}`,
                path.join(closureRoot, FILES[0]), architecture],
            linkArguments: [...LINK_ARGUMENTS, `/OUT:${executable.path}`, object.path], object, executable};
    });
    for (const mode of MODES) operations.find(item => item.operationId === `probe-${mode}`).toolSha256 =
        build.find(item => item.mode === mode).executable.sha256;
    const disassembly = INSTRUCTION_MODES.map(mode => {
        const file = writeIdentityFile(path.join(evidenceRoot, `${mode}.disasm`),
            `${mode.replaceAll("-", "_")}-disassembly`, "generated-command", disassemblyText(mode), sequence++);
        const product = build.find(item => item.mode === mode);
        return {mode, arguments: ["/NOLOGO", "/DISASM:BYTES", `/OUT:${file.path}`, product.object.path], file,
            contract: {accepted: true, symbol: {cpuid: "main", illegal: "main", sse42: "run_sse42",
                popcnt: "run_popcnt", avx: "run_avx", avx2: "run_avx2"}[mode]}};
    });
    fs.writeFileSync(path.join(evidenceRoot, "environment-preflight.cmd"), renderPreflightCommand(tools.vcvars.path));
    for (const product of build) {
        fs.writeFileSync(path.join(evidenceRoot, `compile-${product.mode}.cmd`),
            renderVcCommand(tools.vcvars.path, tools.cl.path, product.compileArguments));
        fs.writeFileSync(path.join(evidenceRoot, `link-${product.mode}.cmd`),
            renderVcCommand(tools.vcvars.path, tools.link.path, product.linkArguments));
    }
    for (const entry of disassembly) fs.writeFileSync(path.join(evidenceRoot, `disassemble-${entry.mode}.cmd`),
        renderVcCommand(tools.vcvars.path, tools.dumpbin.path, entry.arguments));
    const preflight = {VCToolsVersion: vcToolsVersion,
        VCToolsInstallDir: path.join(installationPath, "VC", "Tools", "MSVC", vcToolsVersion),
        WindowsSdkDir: path.join(root, "Windows SDK"), WindowsSDKVersion: "10.0.26100.0\\"};
    const preflightOutput = ["MYSPEED_ENV_BEGIN", ...Object.entries(preflight).map(([name, value]) => `${name}=${value}`),
        "MYSPEED_ENV_END", ""].join("\r\n");
    const operationFiles = new Map();
    for (const operation of operations) {
        const {operationId, isProbe} = operation;
        const mode = isProbe ? operationId.slice("probe-".length) : null;
        const toolIdentity = isProbe ? build.find(item => item.mode === mode).executable : tools[operation.tool];
        const requestPath = path.join(evidenceRoot, `${operationId}.request.json`);
        const resultPath = path.join(evidenceRoot, `${operationId}.result.json`);
        const streamLimitBytes = isProbe ? 4_096 : 65_536;
        const maximumDurationMilliseconds = isProbe ? 10_000 : 30_000;
        const requestBody = {schemaVersion: 1, expectedRunId: RUN_ID, expectedRunAttempt: RUN_ATTEMPT,
            expectedEventSha: EVENT_SHA, expectedSourceSha: SOURCE_SHA, nonce: NONCE, operationId,
            toolPath: toolIdentity.path, toolSha256: toolIdentity.sha256, arguments: operation.arguments,
            workingDirectory: evidenceRoot, streamLimitBytes, maximumDurationMilliseconds, isProbe, resultPath};
        const request = writeIdentityFile(requestPath, `${operationId}-request`, "generated-command",
            JSON.stringify(requestBody), sequence++);
        const stdout = operationId === "discover-vswhere" ? `${installationPath}\r\n` :
            operationId === "environment-preflight" ? preflightOutput : isProbe ? probeOutput(mode) : "";
        const stderr = "";
        operation.wrapper.stdoutBytes = Buffer.byteLength(stdout);
        operation.wrapper.stderrBytes = Buffer.byteLength(stderr);
        const resultBody = {schemaVersion: 1, status: "completed", classification: CLASSIFICATION,
            bindings: {requestPath, requestSha256: request.sha256, expectedRunId: RUN_ID,
                expectedRunAttempt: RUN_ATTEMPT, expectedEventSha: EVENT_SHA, expectedSourceSha: SOURCE_SHA,
                nonce: NONCE, operationId, toolPath: toolIdentity.path, toolSha256: toolIdentity.sha256,
                toolSha256Before: toolIdentity.sha256, toolSha256After: toolIdentity.sha256,
                arguments: operation.arguments, workingDirectory: evidenceRoot, streamLimitBytes,
                maximumDurationMilliseconds, isProbe, resultPath},
            parentJobMembershipProven: true, childExitProven: true, handlesClosedProven: true,
            errorMode: operation.errorMode, wrapper: operation.wrapper,
            stdoutBase64: Buffer.from(stdout).toString("base64"), stderrBase64: Buffer.from(stderr).toString("base64"),
            failures: []};
        const childResult = writeIdentityFile(resultPath, `${operationId}-result`, "generated-command",
            JSON.stringify(resultBody), sequence++);
        operation.request = request;
        operation.result = childResult;
        operationFiles.set(operationId, {request, result: childResult, requestBody, resultBody});
    }
    const runs = MODES.map(mode => ({mode, exitCode: EXPECTED_EXITS[mode], stdout: probeOutput(mode), stderr: "",
        operation: operations.find(operation => operation.operationId === `probe-${mode}`)}));
    const assessment = {schemaVersion: 1, kind: "myspeed-windows-native-calibration", status: "completed",
        calibrationPassed: true, qualifying: false, classification: CLASSIFICATION,
        sequence: [...MODES], reasons: [], cpuid: syntheticCpuid()};
    const result = {schemaVersion: 1, kind: "myspeed-windows-cpu-readiness", status: "completed",
        qualifying: false, calibrationPassed: true, classification: CLASSIFICATION,
        sourceSha: SOURCE_SHA, eventSha: EVENT_SHA, runId: RUN_ID, runAttempt: RUN_ATTEMPT, nonce: NONCE,
        imageVersion: IMAGE_VERSION, failures: [], observations: {closureFiles: [...closureRecords, manifestIdentity],
            discovery: {installationPath, vcToolsVersion, versionFile, tools}, preflight,
            build, disassembly, calibration: {calibrationPassed: true, assessment, runs}, operations,
            cleanup: {allOperationProofsPassed: true, operationCount: OPERATION_IDS.length,
                aggregate: {files: fs.readdirSync(evidenceRoot).length,
                    bytes: fs.readdirSync(evidenceRoot).reduce((total, name) =>
                        total + fs.statSync(path.join(evidenceRoot, name)).size, 0), accepted: true}}}};
    return {evidenceRoot, closureRoot, result, operationFiles, programFilesX86};
};

describe("candidate-neutral Windows CPU readiness workflow", () => {
    it("limits triggers, identity and authority to nonpublishing same-repository work", () => {
        const workflow = config();
        assert.deepEqual(Object.keys(workflow.on).sort(), ["pull_request", "push", "workflow_call", "workflow_dispatch"]);
        assert.deepEqual(workflow.on.push.branches, ["development"]);
        assert.deepEqual(workflow.permissions, {actions: "read", contents: "read"});
        assert.deepEqual(Object.keys(workflow.jobs), ["prepare", "readiness"]);
        assert.match(workflow.jobs.prepare.if, /github.repository == 'i7Gamer\/MySpeed'/);
        assert.match(workflow.jobs.prepare.if, /head.repo.full_name == github.repository/);
        assert.equal(workflow.env.EXPECTED_SOURCE_SHA, SOURCE);
        assert.equal(workflow.env.EXPECTED_EVENT_SHA, "${{ github.sha }}");
        assert.equal(workflow.env.EXPECTED_RUN_ID, "${{ github.run_id }}");
        assert.equal(workflow.env.EXPECTED_RUN_ATTEMPT, "${{ github.run_attempt }}");
        for (const event of ["pull_request", "push"]) {
            for (const file of FILES) assert.ok(workflow.on[event].paths.includes(`scripts/qualification/${file}`));
            assert.ok(workflow.on[event].paths.includes(WORKFLOW));
        }
    });

    it("transfers only the six-source immutable closure to a no-checkout execution job", () => {
        const {prepare, readiness} = config().jobs;
        for (const job of [prepare, readiness]) {
            assert.equal(job["runs-on"], "windows-2025");
            assert.equal(job["timeout-minutes"], JOB_TIMEOUT_MINUTES);
            for (const step of job.steps) {
                if (step.uses) assert.match(step.uses, /@[a-f0-9]{40}$/);
                if (step.run) assert.doesNotMatch(step.run, /\$\{\{/);
            }
        }
        assert.deepEqual(action(prepare, "actions/checkout").with, {ref: SOURCE, "persist-credentials": false});
        assert.equal(action(prepare, "actions/setup-node").with["node-version"], "22.19.0");
        const helperTests = prepare.steps.find(({name}) => name === "Test CPU validation and owned-process helpers").run;
        for (const name of ["windowsCpuFloorProbe", "windowsCpuReadiness", "windowsCpuReadinessController",
            "windowsCpuToolChild", "windowsCpuFileIdentity", "mediaJobLauncher"])
            assert.ok(helperTests.includes(`tests/server/${name}.test.js`), name);
        assert.doesNotMatch(helperTests, /Get-ChildItem|windowsCpu\*|Workflow\.test|npm install|bun install/);
        assert.equal(action(readiness, "actions/checkout"), undefined);
        assert.equal(readiness.needs, "prepare");
        const download = action(readiness, "actions/download-artifact").with;
        assert.equal(download["artifact-ids"], "${{ needs.prepare.outputs.artifact_id }}");
        assert.equal(download["merge-multiple"], true);
        assert.equal(download.pattern, undefined);
        assert.equal(download.name, undefined);
        assert.deepEqual(action(prepare, "actions/upload-artifact").with.path.trim().split("\n"),
            [...FILES, "closure.json"].map(name => `\${{ runner.temp }}/windows-cpu-readiness-closure/${name}`));
    });

    it("checks closure bytes before invoking only the pinned inbox PowerShell controller", () => {
        const run = config().jobs.readiness.steps.find(({id}) => id === "calibrate").run;
        const boundary = run.indexOf("# NATIVE_BOUNDARY");
        assert.ok(boundary > run.indexOf("Get-FileHash") && run.indexOf("Get-FileHash") > 0);
        for (const term of ["ReparsePoint", "LinkType", "-Stream", "MAX_SOURCE_BYTES", "MAX_MANIFEST_BYTES",
            "expectedRunAttempt", "expectedSourceSha", "expectedEventSha", "expectedRunId", "sha256", "[string]", "[long]"])
            assert.ok(run.slice(0, boundary).includes(term), term);
        assert.match(run.slice(boundary), /System32\\WindowsPowerShell\\v1\.0\\powershell\.exe/);
        assert.match(run.slice(boundary), /-Mode InvokeHostedReadiness/);
        for (const argument of ["ExpectedRunId", "ExpectedRunAttempt", "ExpectedSourceSha", "ExpectedEventSha", "Nonce", "ClosureRoot", "ManifestPath", "EvidencePath"])
            assert.ok(run.slice(boundary).includes(`-${argument} `), argument);
        assert.doesNotMatch(run, /Disable-Net|Set-Net|msiexec|MySpeed\.exe|qemu|Invoke-WebRequest|Start-BitsTransfer/);
    });

    it("keeps the local preflight command generator byte-identical to the reviewed controller", {
        skip: !HAS_POWERSHELL && "PowerShell unavailable"
    }, () => {
        const corePath = path.resolve(CORE).replaceAll("'", "''");
        const controllerPath = path.resolve(CONTROLLER).replaceAll("'", "''");
        const vcvarsPath = "C:\\Synthetic\\VC\\Auxiliary\\Build\\vcvars64.bat";
        const script = `$core=New-Module -ScriptBlock { param($p); . $p -Mode Library } -ArgumentList '${corePath}'; ` +
            `. '${controllerPath}' -Mode Library; $script:ControllerNative=[ordered]@{core=$core}; ` +
            `[Convert]::ToBase64String([Text.Encoding]::ASCII.GetBytes((New-MyspeedPreflightCommand '${vcvarsPath}')))`;
        const result = spawnSync(POWERSHELL, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
            {timeout: SHELL_TIMEOUT_MS, encoding: "utf8"});
        assert.equal(result.status, 0, result.stderr);
        assert.equal(Buffer.from(result.stdout.trim(), "base64").toString("ascii"), renderPreflightCommand(vcvarsPath));
    });

    it("requires nonqualifying completion and independently caps every uploaded evidence file", () => {
        const job = config().jobs.readiness;
        const continuation = job.steps.find(({name}) => name === "Confirm successful runner continuation");
        assert.match(continuation.run, /calibrationPassed -isnot \[bool\]/);
        assert.match(continuation.run, /calibrationPassed -ne \$true/);
        assert.match(continuation.run, /status -cne 'completed'/);
        for (const term of ["EXPECTED_OPERATION_COUNT", "expectedOperationIds", "childProofs", "errorMode",
            "Assert-MyspeedOwnedOperation", "Test-MyspeedNativeCalibration", "Assert-MyspeedDisassembly",
            "Assert-ConsumerCurrentIdentity", "allOperationProofsPassed"])
            assert.ok(continuation.run.includes(term), term);
        const check = job.steps.find(({id}) => id === "bound_evidence");
        const upload = action(job, "actions/upload-artifact");
        assert.equal(check.if, "always()");
        assert.equal(upload.if, "always() && steps.bound_evidence.outcome == 'success'");
        for (const term of ["MAX_AGGREGATE_BYTES", "MAX_RESULT_BYTES", "ReparsePoint", "LinkType"])
            assert.ok(check.run.includes(term), term);
        assert.doesNotMatch(check.run, /ConvertFrom-Json|calibrationPassed/);
        assert.equal(upload.with["if-no-files-found"], "error");
        assert.doesNotMatch(JSON.stringify(config()), /continue-on-error|secrets\.|contents.*write|packages.*write/);
        assert.match(readSource(WORKFLOW), /nonqualifying|non-qualifying/);
    });
});

describe("CPU retained evidence and continuation use the actual workflow checks", {
    skip: (process.platform !== "win32" || !HAS_POWERSHELL) && "Windows PowerShell stream checks unavailable"
}, () => {
    const validate = (context, stepName, mutate = () => {}, afterWrite = () => {}) => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), "myspeed-cpu-evidence-"));
        context.after(() => fs.rmSync(root, {recursive: true, force: true}));
        const fixture = makeCompletedEvidence(root);
        const {evidenceRoot, result} = fixture;
        const environment = {RUNNER_TEMP: root, EXPECTED_RUN_ID: RUN_ID, EXPECTED_RUN_ATTEMPT: RUN_ATTEMPT,
            EXPECTED_SOURCE_SHA: SOURCE_SHA, EXPECTED_EVENT_SHA: EVENT_SHA, EXPECTED_NONCE: NONCE,
            ImageVersion: IMAGE_VERSION, "ProgramFiles(x86)": fixture.programFilesX86};
        fs.writeFileSync(path.join(evidenceRoot, "result.json"), JSON.stringify(result));
        mutate({root, evidenceRoot, result, environment, ...fixture});
        fs.writeFileSync(path.join(evidenceRoot, "result.json"), JSON.stringify(result));
        afterWrite({root, evidenceRoot, result, environment, ...fixture});
        const run = config().jobs.readiness.steps.find(({name}) => name === stepName).run;
        assert.doesNotMatch(run, /InvokeHostedReadiness|Add-Type|Start-Process/);
        const scriptPath = path.join(root, "workflow-step.ps1");
        fs.writeFileSync(scriptPath, run);
        const outcome = spawnSync(POWERSHELL, ["-NoLogo", "-NoProfile", "-NonInteractive", "-File", scriptPath], {
            timeout: SHELL_TIMEOUT_MS, encoding: "utf8", env: {...process.env, ...environment}
        });
        return {...outcome, evidenceRoot};
    };
    const boundStep = "Bound and validate retained evidence";
    const continuationStep = "Confirm successful runner continuation";
    it("retains bound positive evidence", context => {
        const outcome = validate(context, boundStep);
        assert.equal(outcome.status, 0, outcome.stderr || outcome.error?.message);
    });
    it("retains bound negative evidence without accepting calibration", context => {
        const negative = ({result}) => { result.status = "failed"; result.calibrationPassed = false; };
        const retained = validate(context, boundStep, negative);
        assert.equal(retained.status, 0, retained.stderr);
        const rejected = validate(context, continuationStep, negative);
        assert.notEqual(rejected.status, 0, rejected.stdout);
    });
    it("retains physically safe malformed JSON for crash diagnosis", context => {
        const malformed = ({evidenceRoot}) => fs.writeFileSync(path.join(evidenceRoot, "result.json"), "{crashed");
        const outcome = validate(context, boundStep, undefined, malformed);
        assert.equal(outcome.status, 0, outcome.stderr);
        assert.equal(fs.readFileSync(path.join(outcome.evidenceRoot, "result.json"), "utf8"), "{crashed");
        const rejected = validate(context, continuationStep, undefined, malformed);
        assert.notEqual(rejected.status, 0, rejected.stdout);
    });
    for (const absent of ["result", "root"]) it(`retains a workflow-owned diagnostic for absent ${absent}`, context => {
        const outcome = validate(context, boundStep, undefined, ({evidenceRoot}) => {
            const target = absent === "root" ? evidenceRoot : path.join(evidenceRoot, "result.json");
            fs.rmSync(target, {recursive: absent === "root"});
        });
        assert.equal(outcome.status, 0, outcome.stderr);
        const diagnostic = JSON.parse(fs.readFileSync(path.join(outcome.evidenceRoot, "workflow-diagnostic.json"), "utf8"));
        assert.equal(diagnostic.kind, "myspeed-windows-cpu-readiness-workflow-diagnostic");
        assert.equal(diagnostic.qualifying, false);
        assert.equal(diagnostic.runId, RUN_ID);
        assert.equal(fs.existsSync(path.join(outcome.evidenceRoot, "result.json")), false);
    });
    it("accepts only an explicit positive continuation", context => {
        const outcome = validate(context, continuationStep);
        assert.equal(outcome.status, 0, outcome.stderr || outcome.error?.message);
    });
    for (const [label, field, value] of [
        ["wrong source", "sourceSha", EVENT_SHA], ["wrong event", "eventSha", SOURCE_SHA],
        ["wrong run", "runId", "111"], ["stale attempt", "runAttempt", "1"],
        ["numeric run", "runId", Number(RUN_ID)], ["array nonce", "nonce", [NONCE]],
        ["Boolean schema", "schemaVersion", true], ["qualifying result", "qualifying", true],
        ["string verdict", "calibrationPassed", "true"], ["unknown status", "status", "success"]
    ]) it(`rejects ${label} before accepting calibration`, context => {
        const outcome = validate(context, continuationStep, ({result}) => { result[field] = value; });
        assert.notEqual(outcome.status, 0, outcome.stdout);
        const retained = validate(context, boundStep, ({result}) => { result[field] = value; });
        assert.equal(retained.status, 0, retained.stderr);
    });
    for (const [label, mutate] of [
        ["oversized JSON", ({evidenceRoot}) => fs.writeFileSync(path.join(evidenceRoot, "tool.JSON"), Buffer.alloc(MAX_RESULT_BYTES + 1))],
        ["oversized disassembly", ({evidenceRoot}) => fs.writeFileSync(path.join(evidenceRoot, "probe.DISASM"), Buffer.alloc(MAX_DISASSEMBLY_BYTES + 1))],
        ["aggregate overflow", ({evidenceRoot}) => fs.writeFileSync(path.join(evidenceRoot, "large.bin"), Buffer.alloc(MAX_AGGREGATE_BYTES))],
        ["excess membership", ({evidenceRoot}) => {
            for (let index = 0; index < MAX_EVIDENCE_ENTRIES; index++) fs.writeFileSync(path.join(evidenceRoot, `item-${index}`), "");
        }],
        ["alternate stream", ({evidenceRoot}) => {
            const file = path.join(evidenceRoot, "child.txt");
            fs.writeFileSync(file, "synthetic");
            fs.writeFileSync(`${file}:unexpected`, "x");
        }],
        ["hard link", ({root, evidenceRoot}) => fs.linkSync(path.join(evidenceRoot, "result.json"), path.join(root, "linked-result"))],
        ["linked ancestor", ({root, environment}) => {
            const alias = path.join(root, "alias");
            fs.symlinkSync(root, alias, "junction");
            environment.RUNNER_TEMP = alias;
        }]
    ]) it(`rejects ${label} before upload`, context => {
        const outcome = validate(context, boundStep, mutate);
        assert.notEqual(outcome.status, 0, outcome.stdout);
    });
    for (const [field, value] of [["status", "failed"], ["calibrationPassed", false],
        ["calibrationPassed", "true"], ["qualifying", true], ["qualifying", "false"]])
        it(`rejects continuation ${field}=${JSON.stringify(value)}`, context => {
            const outcome = validate(context, continuationStep, ({result}) => { result[field] = value; });
            assert.notEqual(outcome.status, 0, outcome.stdout);
        });
    for (const [label, mutate] of [
        ["unexpected top-level field", ({result}) => { result.unexpected = true; }],
        ["wrong classification", ({result}) => { result.classification = "windows-cpu-qualified"; }],
        ["wrong image", ({result}) => { result.imageVersion = "win25-unreviewed"; }],
        ["reported failure", ({result}) => { result.failures.push("synthetic failure"); }],
        ["missing observation", ({result}) => { delete result.observations.disassembly; }],
        ["wrong Visual Studio installation root", ({result}) => {
            result.observations.discovery.installationPath = "C:\\Unreviewed\\Visual Studio";
        }],
        ["wrong VC version-file path", ({result}) => {
            const version = result.observations.discovery.versionFile;
            version.path = version.finalPath = "C:\\Unreviewed\\Microsoft.VCToolsVersion.default.txt";
        }],
        ["wrong compiler path with matching command bytes", ({result, evidenceRoot}) => {
            const discovery = result.observations.discovery;
            discovery.tools.cl.path = discovery.tools.cl.finalPath = "C:\\Unreviewed\\cl.exe";
            for (const product of result.observations.build) fs.writeFileSync(
                path.join(evidenceRoot, `compile-${product.mode}.cmd`),
                renderVcCommand(discovery.tools.vcvars.path, discovery.tools.cl.path, product.compileArguments));
        }],
        ["wrong preflight VC tools root", ({result}) => {
            result.observations.preflight.VCToolsInstallDir = "C:\\Unreviewed\\VC";
        }],
        ["cross-bound but wrong operation request working directory", ({result, operationFiles}) => {
            const operation = result.observations.operations[2];
            const files = operationFiles.get(operation.operationId);
            files.requestBody.workingDirectory = "C:\\Unreviewed";
            rewriteIdentityFile(operation.request, files.requestBody);
            files.resultBody.bindings.requestSha256 = operation.request.sha256;
            files.resultBody.bindings.workingDirectory = files.requestBody.workingDirectory;
            rewriteIdentityFile(operation.result, files.resultBody);
        }],
        ["cross-bound but wrong child result tool hash", ({result, operationFiles}) => {
            const operation = result.observations.operations[2];
            const files = operationFiles.get(operation.operationId);
            files.resultBody.bindings.toolSha256Before = "d".repeat(64);
            files.resultBody.bindings.toolSha256After = "d".repeat(64);
            rewriteIdentityFile(operation.result, files.resultBody);
        }],
        ["cross-bound but wrong child output", ({result, operationFiles}) => {
            const operation = result.observations.operations.find(({operationId}) => operationId === "probe-cpuid");
            const files = operationFiles.get(operation.operationId);
            const priorBytes = operation.result.bytes;
            const stdout = "{}";
            operation.wrapper.stdoutBytes = Buffer.byteLength(stdout);
            files.resultBody.wrapper.stdoutBytes = operation.wrapper.stdoutBytes;
            files.resultBody.stdoutBase64 = Buffer.from(stdout).toString("base64");
            rewriteIdentityFile(operation.result, files.resultBody);
            result.observations.cleanup.aggregate.bytes += operation.result.bytes - priorBytes;
        }],
        ["unexpected request field with matching identity", ({result, operationFiles}) => {
            const operation = result.observations.operations[2];
            const files = operationFiles.get(operation.operationId);
            files.requestBody.unexpected = true;
            rewriteIdentityFile(operation.request, files.requestBody);
            files.resultBody.bindings.requestSha256 = operation.request.sha256;
            rewriteIdentityFile(operation.result, files.resultBody);
        }],
        ["unexpected child-result field with matching identity", ({result, operationFiles}) => {
            const operation = result.observations.operations[2];
            const files = operationFiles.get(operation.operationId);
            files.resultBody.unexpected = true;
            rewriteIdentityFile(operation.result, files.resultBody);
        }],
        ["child request hash binding mismatch", ({result, operationFiles}) => {
            const operation = result.observations.operations[2];
            const files = operationFiles.get(operation.operationId);
            files.resultBody.bindings.requestSha256 = "d".repeat(64);
            rewriteIdentityFile(operation.result, files.resultBody);
        }],
        ["noncanonical child stream encoding", ({result, operationFiles}) => {
            const operation = result.observations.operations[2];
            const files = operationFiles.get(operation.operationId);
            files.resultBody.stdoutBase64 = "eA";
            rewriteIdentityFile(operation.result, files.resultBody);
        }],
        ["vswhere stream mismatch", ({result, operationFiles}) => {
            const operation = result.observations.operations[0];
            const files = operationFiles.get(operation.operationId);
            const stdout = "C:\\Unreviewed\\Visual Studio\r\n";
            operation.wrapper.stdoutBytes = Buffer.byteLength(stdout);
            files.resultBody.wrapper.stdoutBytes = operation.wrapper.stdoutBytes;
            files.resultBody.stdoutBase64 = Buffer.from(stdout).toString("base64");
            rewriteIdentityFile(operation.result, files.resultBody);
        }],
        ["preflight stream mismatch", ({result, operationFiles}) => {
            const operation = result.observations.operations[1];
            const files = operationFiles.get(operation.operationId);
            const stdout = Buffer.from(files.resultBody.stdoutBase64, "base64").toString().replace(
                "WindowsSDKVersion=10.0.26100.0\\", "WindowsSDKVersion=10.0.99999.0\\");
            operation.wrapper.stdoutBytes = Buffer.byteLength(stdout);
            files.resultBody.wrapper.stdoutBytes = operation.wrapper.stdoutBytes;
            files.resultBody.stdoutBase64 = Buffer.from(stdout).toString("base64");
            rewriteIdentityFile(operation.result, files.resultBody);
        }],
        ["manifest contents changed with matching identity", ({result}) => {
            const identity = result.observations.closureFiles.at(-1);
            const manifest = JSON.parse(fs.readFileSync(identity.path, "utf8"));
            manifest.expectedRunId = "987654321";
            rewriteIdentityFile(identity, manifest);
        }],
        ["generated request hard link", ({root, result}) => {
            fs.linkSync(result.observations.operations[2].request.path, path.join(root, "linked-operation-request.json"));
        }],
        ["reordered operation", ({result}) => { result.observations.operations.reverse(); }],
        ["false child proof", ({result}) => {
            result.observations.operations[0].childProofs.handlesClosedProven = false;
        }],
        ["unexpected operation field", ({result}) => { result.observations.operations[0].unexpected = true; }],
        ["wrong operation classification", ({result}) => {
            result.observations.operations[0].classification = "qualifying";
        }],
        ["forged tool hash", ({result}) => { result.observations.operations[0].toolSha256 = "d".repeat(64); }],
        ["joined vswhere argument alias", ({result}) => {
            const operation = result.observations.operations[0];
            operation.arguments = [operation.arguments.join("\n")];
        }],
        ["joined command argument alias", ({result}) => {
            const operation = result.observations.operations[1];
            operation.arguments = [operation.arguments.join("\n")];
        }],
        ["unrestored probe error mode", ({result}) => {
            result.observations.operations.at(-1).errorMode.restored = false;
        }],
        ["probe error-mode flags mismatch", ({result}) => {
            result.observations.operations.at(-1).errorMode.requiredFlags = 1;
        }],
        ["outer process tree not exited", ({result}) => {
            result.observations.operations[0].launcher.processTreeExitProven = false;
        }],
        ["wrapper output not drained", ({result}) => {
            result.observations.operations[0].wrapper.outputDrainProven = false;
        }],
        ["wrong probe exit", ({result}) => {
            result.observations.operations.at(-1).wrapper.exitCode = 19;
        }],
        ["cleanup count mismatch", ({result}) => { result.observations.cleanup.operationCount--; }],
        ["cleanup aggregate rejected", ({result}) => { result.observations.cleanup.aggregate.accepted = false; }],
        ["cleanup byte total mismatch", ({result}) => { result.observations.cleanup.aggregate.bytes++; }],
        ["unexpected retained evidence member", ({evidenceRoot}) => {
            fs.writeFileSync(path.join(evidenceRoot, "unexpected-safe.txt"), "unexpected");
        }],
        ["calibration order mismatch", ({result}) => { result.observations.calibration.runs.reverse(); }],
        ["assessment mismatch", ({result}) => { result.observations.calibration.assessment.reasons.push("forged"); }],
        ["altered compile argument", ({result}) => { result.observations.build[0].compileArguments[0] = "/Od"; }],
        ["altered link argument", ({result}) => { result.observations.build[0].linkArguments[0] = "/DEBUG"; }],
        ["altered disassembly argument", ({result}) => { result.observations.disassembly[0].arguments[1] = "/HEADERS"; }],
        ["altered command bytes", ({evidenceRoot}) => {
            fs.writeFileSync(path.join(evidenceRoot, "compile-cpuid.cmd"), "synthetic altered command\r\n");
        }],
        ["altered preflight command bytes", ({evidenceRoot}) => {
            fs.writeFileSync(path.join(evidenceRoot, "environment-preflight.cmd"), "synthetic altered preflight\r\n");
        }],
        ["disassembly contract mismatch", ({result}) => { result.observations.disassembly[0].contract.accepted = false; }],
        ["disassembly bytes mismatch", ({evidenceRoot}) => {
            fs.writeFileSync(path.join(evidenceRoot, "cpuid.disasm"), "main:\n  0000000000000000: 90 nop\n");
        }],
        ["operation request bytes mismatch", ({evidenceRoot}) => {
            fs.writeFileSync(path.join(evidenceRoot, `${OPERATION_IDS[0]}.request.json`), "{\"changed\":true}");
        }],
        ["built executable bytes mismatch", ({evidenceRoot}) => {
            fs.appendFileSync(path.join(evidenceRoot, "avx2.exe"), "drift");
        }],
        ["closure core bytes mismatch", ({closureRoot}) => {
            fs.appendFileSync(path.join(closureRoot, "windows-cpu-readiness.ps1"), "# changed\n");
        }]
    ]) it(`rejects positive evidence with ${label}`, context => {
        const outcome = validate(context, continuationStep, mutate);
        assert.notEqual(outcome.status, 0, outcome.stdout);
    });
});

describe("CPU closure prefix rejects tampering without executing any helper", {
    skip: !HAS_POWERSHELL && "PowerShell unavailable; static workflow checks still run"
}, () => {
    const validate = (context, mutate = () => {}) => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), "myspeed-cpu-closure-"));
        context.after(() => fs.rmSync(root, {recursive: true, force: true}));
        const closure = path.join(root, "windows-cpu-readiness-closure");
        fs.mkdirSync(closure);
        const files = FILES.map(name => {
            const bytes = Buffer.from("throw 'Synthetic closure must never execute'\n");
            fs.writeFileSync(path.join(closure, name), bytes);
            return {name, bytes: bytes.length, sha256: crypto.createHash("sha256").update(bytes).digest("hex")};
        });
        const manifest = {schemaVersion: 1, kind: "myspeed-windows-cpu-readiness-closure",
            expectedRunId: RUN_ID, expectedRunAttempt: RUN_ATTEMPT, expectedSourceSha: SOURCE_SHA,
            expectedEventSha: EVENT_SHA, nonce: NONCE, files};
        mutate({root, closure, manifest});
        fs.writeFileSync(path.join(closure, "closure.json"), JSON.stringify(manifest));
        const run = config().jobs.readiness.steps.find(({id}) => id === "calibrate").run;
        const boundary = run.indexOf("# NATIVE_BOUNDARY");
        assert.ok(boundary > 0);
        const prefix = run.slice(0, boundary);
        assert.doesNotMatch(prefix, /InvokeHostedReadiness|Add-Type|Start-Process/);
        return spawnSync(POWERSHELL, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command",
            `${prefix}\nWrite-Output 'validation-accepted'`], {
            timeout: SHELL_TIMEOUT_MS, encoding: "utf8",
            env: {...process.env, RUNNER_TEMP: root, EXPECTED_RUN_ID: RUN_ID, EXPECTED_RUN_ATTEMPT: RUN_ATTEMPT,
                EXPECTED_SOURCE_SHA: SOURCE_SHA, EXPECTED_EVENT_SHA: EVENT_SHA, EXPECTED_NONCE: NONCE}
        });
    };

    it("accepts exact synthetic membership with distinct source/event identities", context => {
        const result = validate(context);
        assert.equal(result.status, 0, result.stderr);
        assert.equal(result.stdout.trim(), "validation-accepted");
    });
    const mutations = [
        ["extra file", ({closure}) => fs.writeFileSync(path.join(closure, "unexpected"), "x")],
        ["extra directory", ({closure}) => fs.mkdirSync(path.join(closure, "unexpected"))],
        ["missing file", ({closure}) => fs.unlinkSync(path.join(closure, FILES[0]))],
        ["changed bytes", ({closure}) => fs.appendFileSync(path.join(closure, FILES[0]), "drift")],
        ["empty file", ({closure}) => fs.writeFileSync(path.join(closure, FILES[0]), "")],
        ["extra key", ({manifest}) => { manifest.unexpected = true; }],
        ["Boolean schema", ({manifest}) => { manifest.schemaVersion = true; }],
        ["array nonce", ({manifest}) => { manifest.nonce = [NONCE]; }],
        ["wrong run", ({manifest}) => { manifest.expectedRunId = "987654321"; }],
        ["stale attempt", ({manifest}) => { manifest.expectedRunAttempt = "1"; }],
        ["wrong source", ({manifest}) => { manifest.expectedSourceSha = EVENT_SHA; }],
        ["wrong event", ({manifest}) => { manifest.expectedEventSha = SOURCE_SHA; }],
        ["numeric run", ({manifest}) => { manifest.expectedRunId = Number(RUN_ID); }],
        ["extra file key", ({manifest}) => { manifest.files[0].unexpected = true; }],
        ["Boolean bytes", ({manifest}) => { manifest.files[0].bytes = true; }],
        ["fractional bytes", ({manifest}) => { manifest.files[0].bytes += 0.4; }],
        ["wrong order", ({manifest}) => { manifest.files.reverse(); }],
        ["invalid hash", ({manifest}) => { manifest.files[0].sha256 = "X".repeat(64); }],
        ["oversized manifest", ({manifest}) => { manifest.unexpected = "x".repeat(MAX_MANIFEST_BYTES); }]
    ];
    if (process.platform === "win32") mutations.push(
        ["alternate stream", ({closure}) => fs.writeFileSync(`${path.join(closure, FILES[0])}:unexpected`, "x")],
        ["hard link", ({root, closure}) => fs.linkSync(path.join(closure, FILES[0]), path.join(root, "linked-source"))]
    );
    for (const [label, mutate] of mutations) it(`rejects ${label} before execution`, context => {
        const result = validate(context, mutate);
        assert.notEqual(result.status, 0, result.stdout);
        assert.doesNotMatch(result.stdout, /validation-accepted/);
        assert.match(result.stderr, /Closure/);
    });
});
