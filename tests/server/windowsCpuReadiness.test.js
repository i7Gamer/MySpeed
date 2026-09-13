import {describe, it} from "node:test";
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const SCRIPT = path.resolve("scripts/qualification/windows-cpu-readiness.ps1");
const POWERSHELL = process.platform === "win32"
    ? `${process.env.SystemRoot ?? "C:\\Windows"}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`
    : "pwsh";
const MODES = ["cpuid", "known-good", "known-bad", "illegal", "sse42", "popcnt", "avx", "avx2"];
const SHA = "0123456789abcdef0123456789abcdef01234567";
const NONCE = "0123456789abcdef0123456789abcdef";
const TEST_TIMEOUT_MS = 30_000;
const HAS_POWERSHELL = process.platform === "win32" ||
    childProcess.spawnSync(POWERSHELL, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "exit 0"],
        {encoding: "utf8", timeout: 10_000}).status === 0;
const ILLEGAL_INSTRUCTION_EXIT = 0xc000_001d;
const CONTROL_RESULTS = Object.freeze({
    "known-good": {result: 42, exitCode: 0},
    "known-bad": {result: 13, exitCode: 19},
    sse42: {result: 2_276_049_685, exitCode: 0},
    popcnt: {result: 32, exitCode: 0},
    avx: {result: 72, exitCode: 0},
    avx2: {result: 72, exitCode: 0}
});
const boundedTest = (name, fn) => it(name, {timeout: TEST_TIMEOUT_MS, skip: !HAS_POWERSHELL && "PowerShell unavailable"}, fn);

const invoke = (mode, input = {}) => childProcess.spawnSync(POWERSHELL, [
    "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
    "-File", SCRIPT, "-Mode", mode, "-InputJson", JSON.stringify(input)
], {encoding: "utf8", timeout: 10_000});

const run = (mode, input = {}) => {
    const result = invoke(mode, input);
    assert.equal(result.error, undefined, result.error?.message);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    return result.stdout.trim() === "" ? null : JSON.parse(result.stdout);
};

const reject = (mode, input, pattern) => {
    const result = invoke(mode, input);
    assert.equal(result.error, undefined, result.error?.message);
    assert.notEqual(result.status, 0, "expected helper rejection");
    assert.match(`${result.stdout}\n${result.stderr}`, pattern);
};

const hostedContext = () => ({
    environment: {
        GITHUB_REPOSITORY: "i7Gamer/MySpeed",
        GITHUB_ACTIONS: "true",
        CI: "true",
        RUNNER_OS: "Windows",
        RUNNER_ARCH: "X64",
        RUNNER_ENVIRONMENT: "github-hosted",
        ImageOS: "win25-vs2026",
        ImageVersion: "20260907.229.1",
        GITHUB_RUN_ID: "12345",
        GITHUB_RUN_ATTEMPT: "2",
        GITHUB_SHA: SHA
    },
    expectedRunId: "12345",
    expectedRunAttempt: "2",
    expectedEventSha: SHA,
    expectedSourceSha: SHA,
    nonce: NONCE
});

const closureManifest = () => ({
    schemaVersion: 1,
    kind: "myspeed-windows-cpu-readiness-closure",
    expectedRunId: "12345",
    expectedRunAttempt: "2",
    expectedSourceSha: SHA,
    expectedEventSha: SHA,
    nonce: NONCE,
    files: [
        {name: "windows-cpu-floor-probe.c", bytes: 100, sha256: "a".repeat(64)},
        {name: "windows-cpu-readiness.ps1", bytes: 200, sha256: "b".repeat(64)},
        {name: "windows-cpu-readiness-controller.ps1", bytes: 300, sha256: "c".repeat(64)},
        {name: "windows-cpu-tool-child.ps1", bytes: 400, sha256: "d".repeat(64)},
        {name: "windows-cpu-file-identity.ps1", bytes: 500, sha256: "e".repeat(64)},
        {name: "media-job-launcher.ps1", bytes: 600, sha256: "f".repeat(64)}
    ]
});

const probeJson = (kind, result) => JSON.stringify({schemaVersion: 1, kind, result});
const nativeCpuid = (overrides = {}) => {
    const features = {sse42: true, popcnt: true, osxsave: true, avx: true, avx2: true, ...overrides};
    let leaf1Ecx = 1;
    for (const [name, bit] of Object.entries({sse42: 20, popcnt: 23, osxsave: 27, avx: 28}))
        if (features[name]) leaf1Ecx |= (1 << bit);
    const leaf7Ebx = features.avx2 ? (1 << 5) : 0;
    const hex32 = value => `0x${(value >>> 0).toString(16).padStart(8, "0")}`;
    return {
        schemaVersion: 1,
        kind: "cpuid",
        maxBasicLeaf: 7,
        leaf1: {eax: "0x000106a3", ebx: "0x00000800", ecx: hex32(leaf1Ecx), edx: "0x078bfbfd"},
        leaf7Subleaf0: {eax: "0x00000000", ebx: hex32(leaf7Ebx), ecx: "0x00000000", edx: "0x00000000"},
        xcr0: features.osxsave ? "0x0000000000000007" : null,
        features
    };
};
const nativeCalibration = () => ({
    schemaVersion: 1,
    kind: "myspeed-windows-native-calibration-input",
    runs: MODES.map(mode => {
        if (mode === "cpuid") return {mode, exitCode: 0, stdout: JSON.stringify(nativeCpuid()), stderr: ""};
        if (mode === "illegal") return {mode, exitCode: ILLEGAL_INSTRUCTION_EXIT, stdout: "", stderr: ""};
        const expected = CONTROL_RESULTS[mode];
        return {mode, exitCode: expected.exitCode, stdout: probeJson(mode, expected.result), stderr: ""};
    })
});

describe("CPU readiness deterministic contract", () => {
    boundedTest("pins all eight builds, limits, tools, and nonqualifying sequence", () => {
        const contract = run("GetContract");
        assert.deepEqual(contract.modes.map(value => value.name), MODES);
        assert.deepEqual(contract.modes.map(value => value.architecture), [
            "/arch:SSE2", "/arch:SSE2", "/arch:SSE2", "/arch:SSE2",
            "/arch:SSE2", "/arch:SSE2", "/arch:AVX", "/arch:AVX2"
        ]);
        assert.deepEqual(contract.sequence, MODES);
        assert.equal(contract.wrapperRelativePath, "System32\\WindowsPowerShell\\v1.0\\powershell.exe");
        assert.equal(contract.qualifying, false);
        assert.equal(contract.classification, "windows-native-host-observation-nonqualifying");
        assert.equal(contract.limits.toolStreamBytes, 65_536);
        assert.equal(contract.limits.probeStreamBytes, 4_096);
        assert.equal(contract.limits.disassemblyFileBytes, 2_097_152);
        assert.equal(contract.limits.resultJsonBytes, 262_144);
        assert.equal(contract.limits.aggregateArtifactBytes, 33_554_432);
        assert.deepEqual(contract.disassembly.cpuid, ["cpuid", "xgetbv"]);
        assert.deepEqual(contract.linkArguments, [
            "/NOLOGO", "/INCREMENTAL:NO", "/SUBSYSTEM:CONSOLE", "/MACHINE:X64",
            "/DYNAMICBASE", "/NXCOMPAT", "/HIGHENTROPYVA", "/GUARD:CF", "/MANIFEST:NO"
        ]);
    });

    it("is import-safe and leaves native execution only to the guarded controller", () => {
        const source = fs.readFileSync(SCRIPT, "utf8");
        assert.doesNotMatch(source, /Start-Process|Invoke-Expression|New-Service|Set-ItemProperty|Invoke-WebRequest/);
        assert.doesNotMatch(source, /NewEvidence|InvokeHostedReadiness|Native readiness execution is not implemented/);
    });
});

describe("hosted identity and closure boundaries", () => {
    boundedTest("accepts only the exact bound hosted identity", () => {
        assert.equal(run("AssertContext", hostedContext()).accepted, true);
        for (const mutate of [
            value => { value.environment.GITHUB_REPOSITORY = "other/repo"; },
            value => { value.environment.ImageOS = "win22"; },
            value => { value.environment.GITHUB_RUN_ATTEMPT = "3"; },
            value => { value.environment.GITHUB_SHA = "f".repeat(40); },
            value => { value.environment.GITHUB_RUN_ID = 12345; },
            value => { value.environment.ImageVersion = true; },
            value => { value.expectedRunId = 12345; },
            value => { value.expectedRunAttempt = true; },
            value => { value.nonce = "bad"; }
        ]) {
            const input = hostedContext();
            mutate(input);
            reject("AssertContext", input, /context|nonce|differed/i);
        }
    });

    boundedTest("rejects ambient compiler and linker option injection", () => {
        for (const name of ["CL", "_CL_", "LINK", "_LINK_"]) {
            const input = hostedContext();
            input.environment[name] = "/DUNRECORDED";
            reject("AssertContext", input, /compiler environment/i);
        }
    });

    boundedTest("validates the exact six-file run-bound closure manifest", () => {
        assert.equal(run("ValidateManifest", closureManifest()).accepted, true);
        for (const mutate of [
            value => { value.unexpected = true; },
            value => { value.expectedRunAttempt = "0"; },
            value => { value.schemaVersion = true; },
            value => { value.expectedRunId = 12345; },
            value => { value.files[0].bytes = 0; },
            value => { value.files[0].bytes = true; },
            value => { value.files[0].bytes = 1.4; },
            value => { value.files[0].name = true; },
            value => { value.files[1].sha256 = 7; },
            value => { value.files[1].sha256 += "0"; },
            value => { value.files.push({name: "extra", bytes: 1, sha256: "d".repeat(64)}); }
        ]) {
            const input = closureManifest();
            mutate(input);
            reject("ValidateManifest", input, /manifest|schema|file|hash|bytes/i);
        }
    });
});

describe("tool command and parser boundaries", () => {
    const commandInput = () => ({
        vcvarsPath: "C:\\Program Files\\Microsoft Visual Studio\\VC\\Auxiliary\\Build\\vcvars64.bat",
        toolPath: "C:\\Program Files\\Microsoft Visual Studio\\VC\\Tools\\MSVC\\14.50.12345\\bin\\Hostx64\\x64\\cl.exe",
        arguments: ["/nologo", "/c", "/DPROBE_CPUID", "C:\\owned\\windows-cpu-floor-probe.c"]
    });

    boundedTest("renders a fixed no-argument command file with post-vcvars injection checks", () => {
        const command = run("RenderCommand", commandInput()).text;
        const call = command.indexOf("call \"C:\\Program Files");
        assert.ok(call >= 0);
        for (const name of ["CL", "_CL_", "LINK", "_LINK_"]) {
            assert.ok(command.indexOf(`if defined ${name}`, call) > call);
            assert.ok(command.indexOf(`set "${name}="`, call) > call);
        }
        assert.match(command, /cl\.exe" \/nologo \/c \/DPROBE_CPUID "C:\\owned\\windows-cpu-floor-probe\.c"/);
        const grouped = run("RenderCommand", {...commandInput(), arguments: ["/DVALUE=(1)"]}).text;
        assert.match(grouped, /"\/DVALUE=\(1\)"/);
        reject("RenderCommand", {...commandInput(), toolPath: "C:\\bad&path\\cl.exe"}, /metacharacter/i);
        reject("RenderCommand", {...commandInput(), toolPath: "C:\\owned\\cl.exe:stream"}, /path|metacharacter/i);
        reject("RenderCommand", {...commandInput(), toolPath: "C:\\owned\\cl*.exe"}, /path|metacharacter/i);
        reject("RenderCommand", {...commandInput(), toolPath: "C:\\owned\\CON.txt\\cl.exe"}, /path|reserved/i);
        reject("RenderCommand", {...commandInput(), toolPath: "C:\\owned\\bad\u0001name\\cl.exe"}, /path|control/i);
        reject("RenderCommand", {...commandInput(), arguments: [true]}, /JSON string/i);
        reject("RenderCommand", {...commandInput(), vcvarsPath: [commandInput().vcvarsPath]}, /JSON string/i);
        reject("RenderCommand", {...commandInput(), arguments: ["@C:\\owned\\hidden.rsp"]}, /response file/i);
    });

    boundedTest("derives only the pinned Hostx64 x64 tool paths", () => {
        const result = run("ResolveToolPaths", {
            installationPath: "C:\\Program Files\\Microsoft Visual Studio\\2026\\Enterprise",
            vcToolsVersion: "14.50.12345"
        });
        assert.equal(result.cl, "C:\\Program Files\\Microsoft Visual Studio\\2026\\Enterprise\\VC\\Tools\\MSVC\\14.50.12345\\bin\\Hostx64\\x64\\cl.exe");
        assert.match(result.link, /\\Hostx64\\x64\\link\.exe$/);
        assert.match(result.dumpbin, /\\Hostx64\\x64\\dumpbin\.exe$/);
        assert.match(result.vcvars, /\\VC\\Auxiliary\\Build\\vcvars64\.bat$/);
        reject("ResolveToolPaths", {installationPath: "C:\\VS", vcToolsVersion: "preview"}, /version/i);
        reject("ResolveToolPaths", {installationPath: ["C:\\VS"], vcToolsVersion: "14.50.12345"}, /JSON string/i);
        reject("ResolveToolPaths", {installationPath: "C:\\VS", vcToolsVersion: ["14.50.12345"]}, /JSON string/i);
    });

    boundedTest("strictly parses one vswhere path and the four-field environment frame", () => {
        assert.equal(run("ParseVsWhere", {text: "C:\\Program Files\\Microsoft Visual Studio\\2026\\Enterprise\r\n"}).value,
            "C:\\Program Files\\Microsoft Visual Studio\\2026\\Enterprise");
        reject("ParseVsWhere", {text: "C:\\one\r\nC:\\two\r\n"}, /one line/i);
        reject("ParseVsWhere", {text: ["C:\\VS"]}, /JSON string/i);
        reject("ParseVsWhere", {text: "C:\\VS\r\n\r\n\r\n"}, /one line/i);
        reject("ParseVsWhere", {text: "C:\\VS", extra: true}, /schema/i);
        const frame = [
            "MYSPEED_ENV_BEGIN", "VCToolsVersion=14.50.12345", "VCToolsInstallDir=C:\\VS\\VC\\Tools\\MSVC\\14.50.12345\\",
            "WindowsSdkDir=C:\\Program Files (x86)\\Windows Kits\\10\\", "WindowsSDKVersion=10.0.26100.0\\", "MYSPEED_ENV_END"
        ].join("\r\n");
        assert.equal(run("ParsePreflight", {text: frame}).value.WindowsSDKVersion, "10.0.26100.0\\");
        assert.equal(run("ParsePreflight", {text: `${frame}\r\n`}).value.VCToolsVersion, "14.50.12345");
        reject("ParsePreflight", {text: `${frame}\r\nextra`}, /frame/i);
        reject("ParsePreflight", {text: `${frame}\r\n\r\n`}, /frame/i);
        reject("ParsePreflight", {text: [frame]}, /JSON string/i);
        reject("ParsePreflight", {text: frame, extra: true}, /schema/i);
    });

    boundedTest("normalizes only 32-bit process exit values", () => {
        assert.equal(run("ConvertExit", {exitCode: -1_073_741_795}).value, 0xc000_001d);
        assert.equal(run("ConvertExit", {exitCode: 19}).value, 19);
        reject("ConvertExit", {exitCode: true}, /32-bit/i);
        reject("ConvertExit", {exitCode: 0.4}, /32-bit/i);
        reject("ConvertExit", {exitCode: 0x1_0000_0000}, /32-bit/i);
        reject("ConvertExit", {exitCode: 0, extra: true}, /schema/i);
    });
});

describe("disassembly, owned-operation, and evidence gates", () => {
    const disassembly = (symbol, instructions) => `${symbol}:\r\n${instructions.map(value => `  00000000: 00 ${value}`).join("\r\n")}\r\nnext_symbol:\r\n  00000010: c3 ret\r\n`;

    boundedTest("accepts required mnemonics only inside the exact unique function region", () => {
        assert.equal(run("CheckDisassembly", {mode: "cpuid", text: disassembly("main", ["cpuid", "xgetbv"])}).accepted, true);
        assert.equal(run("CheckDisassembly", {mode: "avx2", text: disassembly("run_avx2", ["vpaddd ymm0,ymm1,ymm2"])}).accepted, true);
        const localLabel = `main:\r\n  00000000: 0f a2 cpuid\r\n$LN4@main:\r\n  00000002: 0f 01 d0 xgetbv\r\nnext_symbol:\r\n`;
        assert.equal(run("CheckDisassembly", {mode: "cpuid", text: localLabel}).accepted, true);
        reject("CheckDisassembly", {mode: "cpuid", text: disassembly("main", ["call cpuid", "call xgetbv"])}, /cpuid|xgetbv/i);
        reject("CheckDisassembly", {mode: ["cpuid"], text: disassembly("main", ["cpuid", "xgetbv"])}, /JSON string/i);
        reject("CheckDisassembly", {mode: "cpuid", text: [disassembly("main", ["cpuid", "xgetbv"])]}, /JSON string/i);
        reject("CheckDisassembly", {mode: "cpuid", text: disassembly("main", ["cpuid", "xgetbv"]), extra: true}, /schema/i);
        reject("CheckDisassembly", {mode: "cpuid", text: disassembly("main", ["cpuid"]) + disassembly("other", ["xgetbv"])}, /xgetbv/i);
        reject("CheckDisassembly", {mode: "avx", text: disassembly("other", ["vaddps"])}, /region/i);
        reject("CheckDisassembly", {mode: "illegal", text: disassembly("main", ["ud2"]) + disassembly("main", ["ud2"])}, /unique/i);
    });

    boundedTest("requires both wrapper and outer Job proofs with bounded outputs and exact exits", () => {
        const valid = {
            streamLimitBytes: 4_096,
            maximumDurationMilliseconds: 10_000,
            expectedExitCode: 0,
            launcher: {schemaVersion: 1, authorizesTransfer: false, processId: 44, exitCode: 0, timedOut: false, processTreeExitProven: true},
            wrapper: {schemaVersion: 1, status: "completed", childProcessId: 45, exitCode: 0, timedOut: false, durationMilliseconds: 25, stdoutBytes: 20, stderrBytes: 0, outputDrainProven: true, childJobMembershipProven: true, errorModeRestored: true}
        };
        assert.equal(run("ValidateOperation", valid).accepted, true);
        for (const mutate of [
            value => { value.launcher.processTreeExitProven = false; },
            value => { value.wrapper.outputDrainProven = false; },
            value => { value.wrapper.stdoutBytes = 4_097; },
            value => { value.wrapper.stdoutBytes = true; },
            value => { value.wrapper.stderrBytes = 0.4; },
            value => { value.wrapper.durationMilliseconds = 10_001; },
            value => { value.wrapper.durationMilliseconds = 25.4; },
            value => { value.wrapper.outputDrainProven = 1; },
            value => { value.launcher.processTreeExitProven = 1; },
            value => { value.streamLimitBytes = "4096"; },
            value => { value.maximumDurationMilliseconds = 30_000.4; },
            value => { value.expectedExitCode = false; },
            value => { value.launcher.authorizesTransfer = 0; },
            value => { value.launcher.processId = "44"; },
            value => { value.launcher.processId = 0x1_0000_0000; },
            value => { value.launcher.timedOut = 0; },
            value => { value.wrapper.childProcessId = true; },
            value => { value.wrapper.childProcessId = 0x1_0000_0000; },
            value => { value.wrapper.status = false; },
            value => { value.wrapper.exitCode = 19; },
            value => { value.wrapper.exitCode = 0.4; },
            value => { value.wrapper.errorModeRestored = false; }
        ]) {
            const input = structuredClone(valid);
            mutate(input);
            reject("ValidateOperation", input, /operation|output|exit|Job|error mode|JSON boolean|JSON integer|JSON string/i);
        }
    });

});

describe("native probe parsing and nonqualifying calibration", () => {
    boundedTest("strictly parses bounded CPUID and control records", () => {
        const cpuid = nativeCpuid();
        assert.deepEqual(run("ParseProbe", {expectedKind: "cpuid", text: JSON.stringify(cpuid)}).record, cpuid);
        for (const [kind, expected] of Object.entries(CONTROL_RESULTS))
            assert.equal(run("ParseProbe", {expectedKind: kind, text: probeJson(kind, expected.result)}).record.result, expected.result);

        const rawMismatch = nativeCpuid();
        rawMismatch.features.avx = false;
        reject("ParseProbe", {expectedKind: "cpuid", text: JSON.stringify(rawMismatch)}, /raw bit|feature/i);
        reject("ParseProbe", {expectedKind: "cpuid", text: JSON.stringify({...cpuid, extra: true})}, /schema/i);
        reject("ParseProbe", {expectedKind: ["cpuid"], text: JSON.stringify(cpuid)}, /JSON string/i);
        reject("ParseProbe", {expectedKind: "cpuid", text: "x".repeat(4_097)}, /oversized/i);
    });

    boundedTest("accepts all eight native controls but never makes qualifying evidence", () => {
        const result = run("AssessNativeCalibration", nativeCalibration());
        assert.equal(result.status, "completed");
        assert.equal(result.calibrationPassed, true);
        assert.equal(result.qualifying, false);
        assert.equal(result.classification, "windows-native-host-observation-nonqualifying");
        assert.deepEqual(result.sequence, MODES);
        assert.deepEqual(result.reasons, []);
        assert.deepEqual(result.cpuid, nativeCpuid());
    });

    boundedTest("fails closed on control, exception, capability, XCR0, stderr, and schema drift", () => {
        for (const mutate of [
            value => { value.runs[1].stdout = probeJson("known-good", 41); },
            value => { value.runs[2].exitCode = 0; },
            value => { value.runs[3].stdout = "unexpected"; },
            value => { value.runs[4].stderr = "compiler diagnostic"; },
            value => {
                const cpuid = nativeCpuid({avx2: false});
                value.runs[0].stdout = JSON.stringify(cpuid);
            },
            value => {
                const cpuid = {...nativeCpuid(), xcr0: "0x0000000000000002"};
                value.runs[0].stdout = JSON.stringify(cpuid);
            }
        ]) {
            const input = nativeCalibration();
            mutate(input);
            const result = run("AssessNativeCalibration", input);
            assert.equal(result.calibrationPassed, false);
            assert.equal(result.qualifying, false);
            assert.ok(result.reasons.length > 0);
        }
        const malformed = nativeCalibration();
        malformed.runs[0].unexpected = true;
        reject("AssessNativeCalibration", malformed, /schema/i);
    });
});
