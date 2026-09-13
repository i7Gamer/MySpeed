import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import {spawn} from "node:child_process";
import {fileURLToPath} from "node:url";

const SCHEMA_VERSION = 1;
const REPOSITORY = "i7Gamer/MySpeed";
const EXPECTED_IMAGE_OS = "ubuntu24";
const KVM_API_VERSION = 12;
const KVM_EXIT_HLT = 5;
const MODULE_NAME = "linux-kvm-capability.mjs";
const RESULT_NAME = "result.json";
const COMPILER_PATH = "/usr/bin/cc";
const DEVICE_PATH = "/dev/kvm";
const UTF8 = "utf8";
const UINT_DECIMAL = /^(?:0|[1-9][0-9]*)$/;
const POSITIVE_DECIMAL = /^[1-9][0-9]*$/;
const SHA256 = /^[a-f0-9]{64}$/;
const SOURCE_SHA = /^[a-f0-9]{40}$/;
const NONCE = /^[a-f0-9]{32}$/;
const IMAGE_VERSION = /^[0-9A-Za-z._-]+$/;
const SAFE_TEXT = /^[^\x00-\x1f\x7f]+$/;
const MAX_SAFE_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);
const MAX_TOOL_BYTES = 67_108_864;
const MAX_TEXT_CHARACTERS = 4_096;
const MAX_DECIMAL_DIGITS = 32;
const MAX_ARGUMENTS = 32;
const MAX_PROBE_BINARY_BYTES = 1_048_576;
const ALLOWED_FILESYSTEMS = new Set(["ext4", "xfs", "btrfs", "overlay"]);
const PROCESS_KEYS = ["cleanupProven", "errorObserved", "exitCode", "signal", "stderrOverflow", "stdoutOverflow", "timedOut"];
const FACT_KEYS = ["dev", "gid", "ino", "kind", "mode", "rdev", "uid"];
const DEVICE_KEYS = ["fstat", "lstat", "reopen"];
const PROBE_KEYS = ["apiVersion", "cleanupProven", "device", "errno", "exitReason", "schemaVersion", "stage", "status"];
const CONTEXT_KEYS = ["environment", "eventSha", "nonce", "repository", "runAttempt", "runId", "schemaVersion", "sourceSha"];
const ENVIRONMENT_KEYS = ["CI", "GITHUB_ACTIONS", "ImageOS", "ImageVersion", "RUNNER_ARCH", "RUNNER_ENVIRONMENT", "RUNNER_OS"];
const MANIFEST_KEYS = ["context", "module", "schemaVersion"];
const MODULE_KEYS = ["bytes", "name", "sha256"];
const RESOURCE_KEYS = ["cpu", "filesystem", "memory", "tools"];
const FILESYSTEM_KEYS = ["availableBlocks", "blockSize", "mountOptions", "taskPath", "type"];
const MEMORY_KEYS = ["cgroupLevels", "memAvailableBytes"];
const CPU_KEYS = ["cgroupLevels", "logicalProcessors"];
const MEMORY_LEVEL_KEYS = ["currentBytes", "limitBytes", "path"];
const CPU_LEVEL_KEYS = ["path", "period", "quota"];
const TOOLS_KEYS = ["ovmf", "qemuSystemX8664"];
const IOCTL_STAGES = new Set(["get-api-version", "create-vm", "set-memory", "create-vcpu", "get-vcpu-mmap-size",
    "mmap-vcpu", "get-sregs", "set-sregs", "set-regs", "run"]);

export const CAPABILITY_LIMITS = Object.freeze({
    probeTimeoutMs: 30_000,
    cleanupTimeoutMs: 5_000,
    streamBytes: 16_384,
    resultBytes: 131_072,
    probeMemoryBytes: 4_096,
    probeRunMappingBytes: 1_048_576,
    probeBinaryBytes: MAX_PROBE_BINARY_BYTES
});

export const KVM_PROBE_SOURCE = String.raw`#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <inttypes.h>
#include <linux/kvm.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/mman.h>
#include <sys/stat.h>
#include <sys/sysmacros.h>
#include <unistd.h>

#define PROBE_MEMORY_BYTES 4096
#define PROBE_RUN_MAPPING_MAX_BYTES 1048576

struct facts { struct stat value; int present; };

static void print_facts(const struct facts *facts) {
    if (!facts->present) { fputs("null", stdout); return; }
    printf("{\"kind\":\"%s\",\"dev\":\"%ju\",\"ino\":\"%ju\",\"rdev\":\"%ju\",\"mode\":\"%ju\",\"uid\":\"%ju\",\"gid\":\"%ju\"}",
        S_ISCHR(facts->value.st_mode) ? "character-device" : "other",
        (uintmax_t)facts->value.st_dev, (uintmax_t)facts->value.st_ino,
        (uintmax_t)facts->value.st_rdev, (uintmax_t)facts->value.st_mode,
        (uintmax_t)facts->value.st_uid, (uintmax_t)facts->value.st_gid);
}

int main(void) {
    const char *stage = "lstat";
    int saved_errno = 0, status_passed = 0, api_version = -1, exit_reason = -1;
    int kvm_fd = -1, vm_fd = -1, vcpu_fd = -1, reopen_fd = -1;
    void *memory = MAP_FAILED, *run_mapping = MAP_FAILED;
    size_t run_bytes = 0;
    struct facts before = {{0}, 0}, opened = {{0}, 0}, reopened = {{0}, 0};

    if (lstat("/dev/kvm", &before.value) != 0) { saved_errno = errno; goto cleanup; }
    before.present = 1;
    if (!S_ISCHR(before.value.st_mode)) { stage = "device-type"; goto cleanup; }
    stage = "open";
    kvm_fd = open("/dev/kvm", O_RDWR | O_CLOEXEC);
    if (kvm_fd < 0) { saved_errno = errno; goto cleanup; }
    stage = "fstat";
    if (fstat(kvm_fd, &opened.value) != 0) { saved_errno = errno; goto cleanup; }
    opened.present = 1;
    if (!S_ISCHR(opened.value.st_mode) || before.value.st_dev != opened.value.st_dev ||
        before.value.st_ino != opened.value.st_ino || before.value.st_rdev != opened.value.st_rdev) {
        stage = "device-identity"; goto cleanup;
    }
    stage = "get-api-version";
    api_version = ioctl(kvm_fd, KVM_GET_API_VERSION, 0);
    if (api_version < 0) { saved_errno = errno; goto cleanup; }
    if (api_version != KVM_API_VERSION) { stage = "api-version"; goto cleanup; }
    stage = "create-vm";
    vm_fd = ioctl(kvm_fd, KVM_CREATE_VM, 0);
    if (vm_fd < 0) { saved_errno = errno; goto cleanup; }
    stage = "mmap-memory";
    memory = mmap(NULL, PROBE_MEMORY_BYTES, PROT_READ | PROT_WRITE,
        MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
    if (memory == MAP_FAILED) { saved_errno = errno; goto cleanup; }
    ((uint8_t *)memory)[0] = 0xf4;
    struct kvm_userspace_memory_region region = {0};
    region.slot = 0; region.guest_phys_addr = 0; region.memory_size = PROBE_MEMORY_BYTES;
    region.userspace_addr = (uint64_t)(uintptr_t)memory;
    stage = "set-memory";
    if (ioctl(vm_fd, KVM_SET_USER_MEMORY_REGION, &region) != 0) { saved_errno = errno; goto cleanup; }
    stage = "create-vcpu";
    vcpu_fd = ioctl(vm_fd, KVM_CREATE_VCPU, 0);
    if (vcpu_fd < 0) { saved_errno = errno; goto cleanup; }
    stage = "get-vcpu-mmap-size";
    int requested_run_bytes = ioctl(kvm_fd, KVM_GET_VCPU_MMAP_SIZE, 0);
    if (requested_run_bytes < (int)sizeof(struct kvm_run) || requested_run_bytes > PROBE_RUN_MAPPING_MAX_BYTES) {
        saved_errno = requested_run_bytes < 0 ? errno : EINVAL; goto cleanup;
    }
    run_bytes = (size_t)requested_run_bytes;
    stage = "mmap-vcpu";
    run_mapping = mmap(NULL, run_bytes, PROT_READ | PROT_WRITE, MAP_SHARED, vcpu_fd, 0);
    if (run_mapping == MAP_FAILED) { saved_errno = errno; goto cleanup; }
    struct kvm_sregs sregs;
    stage = "get-sregs";
    if (ioctl(vcpu_fd, KVM_GET_SREGS, &sregs) != 0) { saved_errno = errno; goto cleanup; }
    sregs.cs.base = 0; sregs.cs.selector = 0;
    stage = "set-sregs";
    if (ioctl(vcpu_fd, KVM_SET_SREGS, &sregs) != 0) { saved_errno = errno; goto cleanup; }
    struct kvm_regs regs = {0};
    regs.rip = 0; regs.rflags = 2;
    stage = "set-regs";
    if (ioctl(vcpu_fd, KVM_SET_REGS, &regs) != 0) { saved_errno = errno; goto cleanup; }
    stage = "run";
    if (ioctl(vcpu_fd, KVM_RUN, 0) != 0) { saved_errno = errno; goto cleanup; }
    exit_reason = (int)((struct kvm_run *)run_mapping)->exit_reason;
    if (exit_reason != KVM_EXIT_HLT) { stage = "exit-reason"; goto cleanup; }
    stage = "complete"; status_passed = 1;

cleanup:
    {
        int cleanup_ok = 1;
        if (run_mapping != MAP_FAILED && munmap(run_mapping, run_bytes) != 0) cleanup_ok = 0;
        if (vcpu_fd >= 0 && close(vcpu_fd) != 0) cleanup_ok = 0;
        if (memory != MAP_FAILED && munmap(memory, PROBE_MEMORY_BYTES) != 0) cleanup_ok = 0;
        if (vm_fd >= 0 && close(vm_fd) != 0) cleanup_ok = 0;
        if (kvm_fd >= 0 && close(kvm_fd) != 0) cleanup_ok = 0;
        if (opened.present) {
            reopen_fd = open("/dev/kvm", O_RDWR | O_CLOEXEC);
            if (reopen_fd < 0 || fstat(reopen_fd, &reopened.value) != 0) cleanup_ok = 0;
            else reopened.present = 1;
            if (reopen_fd >= 0 && close(reopen_fd) != 0) cleanup_ok = 0;
            if (!reopened.present || before.value.st_dev != reopened.value.st_dev ||
                before.value.st_ino != reopened.value.st_ino || before.value.st_rdev != reopened.value.st_rdev)
                cleanup_ok = 0;
        }
        if (!cleanup_ok) { status_passed = 0; stage = "cleanup"; }
        printf("{\"schemaVersion\":1,\"status\":\"%s\",\"stage\":\"%s\",\"errno\":%d,\"apiVersion\":",
            status_passed ? "passed" : "failed", stage, saved_errno);
        if (api_version < 0) fputs("null", stdout); else printf("%d", api_version);
        fputs(",\"exitReason\":", stdout);
        if (exit_reason < 0) fputs("null", stdout); else printf("%d", exit_reason);
        printf(",\"cleanupProven\":%s,\"device\":{\"lstat\":", cleanup_ok ? "true" : "false");
        print_facts(&before); fputs(",\"fstat\":", stdout); print_facts(&opened);
        fputs(",\"reopen\":", stdout); print_facts(&reopened); fputs("}}\n", stdout);
        return 0;
    }
}
`;

function assertObject(value, name) {
    if (value === null || typeof value !== "object" || Array.isArray(value))
        throw new TypeError(`${name} must be an object`);
    return value;
}

function assertKeys(value, keys, name) {
    assertObject(value, name);
    const actual = Object.keys(value).sort();
    const expected = [...keys].sort();
    if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index]))
        throw new TypeError(`${name} schema mismatch`);
}

function assertExactString(value, pattern, name) {
    if (typeof value !== "string" || value.length > MAX_TEXT_CHARACTERS)
        throw new TypeError(`${name} is invalid`);
    const match = pattern.exec(value);
    if (!match || match[0] !== value)
        throw new TypeError(`${name} is invalid`);
    return value;
}

function assertInteger(value, minimum, maximum, name) {
    if (!Number.isInteger(value) || value < minimum || value > maximum) throw new TypeError(`${name} is invalid`);
    return value;
}

function assertBoolean(value, name) {
    if (typeof value !== "boolean") throw new TypeError(`${name} must be Boolean`);
    return value;
}

function assertDecimal(value, {positive = false, name}) {
    if (typeof value !== "string" || value.length > MAX_DECIMAL_DIGITS) throw new TypeError(`${name} is invalid`);
    assertExactString(value, positive ? POSITIVE_DECIMAL : UINT_DECIMAL, name);
    return BigInt(value);
}

function deepFreeze(value) {
    if (value && typeof value === "object" && !Object.isFrozen(value)) {
        Object.freeze(value);
        for (const child of Object.values(value)) deepFreeze(child);
    }
    return value;
}

function sha256(bytes) {
    return crypto.createHash("sha256").update(bytes).digest("hex");
}

export function validateHostedContext(value) {
    assertKeys(value, CONTEXT_KEYS, "context");
    if (value.schemaVersion !== SCHEMA_VERSION || value.repository !== REPOSITORY)
        throw new TypeError("context identity mismatch");
    assertExactString(value.sourceSha, SOURCE_SHA, "sourceSha");
    assertExactString(value.eventSha, SOURCE_SHA, "eventSha");
    assertExactString(value.runId, POSITIVE_DECIMAL, "runId");
    assertExactString(value.runAttempt, POSITIVE_DECIMAL, "runAttempt");
    assertExactString(value.nonce, NONCE, "nonce");
    assertKeys(value.environment, ENVIRONMENT_KEYS, "environment");
    const expected = {GITHUB_ACTIONS: "true", CI: "true", RUNNER_OS: "Linux", RUNNER_ARCH: "X64",
        RUNNER_ENVIRONMENT: "github-hosted", ImageOS: EXPECTED_IMAGE_OS};
    for (const [key, expectedValue] of Object.entries(expected)) {
        if (value.environment[key] !== expectedValue) throw new TypeError(`environment ${key} mismatch`);
    }
    assertExactString(value.environment.ImageVersion, IMAGE_VERSION, "ImageVersion");
    return deepFreeze(structuredClone(value));
}

export function createClosureManifest({context, moduleBytes}) {
    const checkedContext = validateHostedContext(context);
    if (!Buffer.isBuffer(moduleBytes) || moduleBytes.length === 0 || moduleBytes.length > CAPABILITY_LIMITS.resultBytes)
        throw new TypeError("moduleBytes are invalid");
    return deepFreeze({schemaVersion: SCHEMA_VERSION, context: checkedContext,
        module: {name: MODULE_NAME, bytes: moduleBytes.length, sha256: sha256(moduleBytes)}});
}

export function validateClosureManifest({manifest, moduleBytes, expectedContext}) {
    assertKeys(manifest, MANIFEST_KEYS, "manifest");
    if (manifest.schemaVersion !== SCHEMA_VERSION) throw new TypeError("manifest version mismatch");
    const expected = createClosureManifest({context: manifest.context, moduleBytes});
    assertKeys(manifest.module, MODULE_KEYS, "manifest.module");
    if (manifest.module.name !== expected.module.name || manifest.module.bytes !== expected.module.bytes ||
        manifest.module.sha256 !== expected.module.sha256)
        throw new TypeError("manifest module identity mismatch");
    if (expectedContext && JSON.stringify(validateHostedContext(expectedContext)) !== JSON.stringify(manifest.context))
        throw new TypeError("manifest context mismatch");
    return deepFreeze(structuredClone(manifest));
}

function parseOptionalPath(value, name) {
    if (value === null) return null;
    if (typeof value !== "string" || !value.startsWith("/") || !SAFE_TEXT.test(value))
        throw new TypeError(`${name} is invalid`);
    return value;
}

export function parseResourceObservation(value) {
    assertKeys(value, RESOURCE_KEYS, "resources");
    assertKeys(value.filesystem, FILESYSTEM_KEYS, "resources.filesystem");
    const availableBlocks = assertDecimal(value.filesystem.availableBlocks,
        {name: "filesystem.availableBlocks"});
    const blockSize = assertDecimal(value.filesystem.blockSize,
        {positive: true, name: "filesystem.blockSize"});
    if (!ALLOWED_FILESYSTEMS.has(value.filesystem.type)) throw new TypeError("filesystem type is not approved");
    assertExactString(value.filesystem.mountOptions, SAFE_TEXT, "filesystem.mountOptions");
    if (!value.filesystem.mountOptions.split(",").includes("rw")) throw new TypeError("filesystem is not writable");
    if (parseOptionalPath(value.filesystem.taskPath, "filesystem.taskPath") === null)
        throw new TypeError("filesystem.taskPath is required");

    assertKeys(value.memory, MEMORY_KEYS, "resources.memory");
    const memAvailable = assertDecimal(value.memory.memAvailableBytes,
        {positive: true, name: "memory.memAvailableBytes"});
    if (!Array.isArray(value.memory.cgroupLevels) || value.memory.cgroupLevels.length === 0 ||
        value.memory.cgroupLevels.length > 64) throw new TypeError("memory.cgroupLevels is invalid");
    let headroom = null;
    let previousMemoryPath = "";
    const memoryLevels = value.memory.cgroupLevels.map((level, index) => {
        assertKeys(level, MEMORY_LEVEL_KEYS, `memory.cgroupLevels[${index}]`);
        const levelPath = parseOptionalPath(level.path, `memory.cgroupLevels[${index}].path`);
        if (!levelPath || (previousMemoryPath && !levelPath.startsWith(`${previousMemoryPath}/`)))
            throw new TypeError("memory cgroup ancestry is invalid");
        previousMemoryPath = levelPath;
        if (level.limitBytes === null) {
            if (level.currentBytes !== null) assertDecimal(level.currentBytes,
                {name: `memory.cgroupLevels[${index}].currentBytes`});
            return {...level};
        }
        const current = assertDecimal(level.currentBytes,
            {name: `memory.cgroupLevels[${index}].currentBytes`});
        const limit = assertDecimal(level.limitBytes,
            {positive: true, name: `memory.cgroupLevels[${index}].limitBytes`});
        if (current > limit) throw new TypeError("cgroup memory usage exceeds its limit");
        const available = limit - current;
        if (headroom === null || available < headroom) headroom = available;
        return {...level};
    });

    assertKeys(value.cpu, CPU_KEYS, "resources.cpu");
    assertInteger(value.cpu.logicalProcessors, 1, 1024, "cpu.logicalProcessors");
    if (!Array.isArray(value.cpu.cgroupLevels) || value.cpu.cgroupLevels.length === 0 ||
        value.cpu.cgroupLevels.length > 64) throw new TypeError("cpu.cgroupLevels is invalid");
    let quotaProcessors = value.cpu.logicalProcessors;
    let previousCpuPath = "";
    const cpuLevels = value.cpu.cgroupLevels.map((level, index) => {
        assertKeys(level, CPU_LEVEL_KEYS, `cpu.cgroupLevels[${index}]`);
        const levelPath = parseOptionalPath(level.path, `cpu.cgroupLevels[${index}].path`);
        if (!levelPath || (previousCpuPath && !levelPath.startsWith(`${previousCpuPath}/`)))
            throw new TypeError("CPU cgroup ancestry is invalid");
        previousCpuPath = levelPath;
        if (level.quota === null) {
            if (level.period !== null) {
                const unlimitedPeriod = assertDecimal(level.period,
                    {positive: true, name: `cpu.cgroupLevels[${index}].period`});
                if (unlimitedPeriod > MAX_SAFE_BIGINT) throw new TypeError("cgroup CPU period is too large");
            }
            return {...level};
        }
        const period = assertDecimal(level.period, {positive: true, name: `cpu.cgroupLevels[${index}].period`});
        if (period > MAX_SAFE_BIGINT) throw new TypeError("cgroup CPU period is too large");
        const quota = assertDecimal(level.quota, {positive: true, name: `cpu.cgroupLevels[${index}].quota`});
        if (quota > MAX_SAFE_BIGINT) throw new TypeError("cgroup CPU quota is too large");
        const available = Number(quota) / Number(period);
        if (!Number.isFinite(available) || available <= 0) throw new TypeError("cgroup CPU quota is invalid");
        quotaProcessors = Math.min(quotaProcessors, available);
        return {...level};
    });

    assertKeys(value.tools, TOOLS_KEYS, "resources.tools");
    const qemu = parseOptionalPath(value.tools.qemuSystemX8664, "tools.qemuSystemX8664");
    if (!Array.isArray(value.tools.ovmf) || value.tools.ovmf.length > 32)
        throw new TypeError("tools.ovmf is invalid");
    const ovmf = value.tools.ovmf.map((entry, index) => {
        const parsed = parseOptionalPath(entry, `tools.ovmf[${index}]`);
        if (parsed === null) throw new TypeError(`tools.ovmf[${index}] is required`);
        return parsed;
    });
    const informationalBavailTimesBsize = availableBlocks * blockSize;
    const effective = headroom === null || memAvailable < headroom ? memAvailable : headroom;
    return deepFreeze({
        filesystem: {...value.filesystem,
            informationalBavailTimesBsize: informationalBavailTimesBsize.toString()},
        memory: {memAvailableBytes: value.memory.memAvailableBytes, cgroupLevels: memoryLevels,
            cgroupHeadroomBytes: headroom?.toString() ?? null,
            effectiveAvailableBytes: effective.toString()},
        cpu: {logicalProcessors: value.cpu.logicalProcessors, cgroupLevels: cpuLevels,
            effectiveLogicalProcessors: quotaProcessors},
        tools: {qemuSystemX8664: qemu, ovmf}
    });
}

function validateFacts(value, name) {
    if (value === null) return null;
    assertKeys(value, FACT_KEYS, name);
    if (value.kind !== "character-device" && value.kind !== "other") throw new TypeError(`${name}.kind is invalid`);
    for (const key of FACT_KEYS.filter(key => !["kind"].includes(key)))
        assertDecimal(value[key], {name: `${name}.${key}`});
    return value;
}

function validateDevice(value) {
    assertKeys(value, DEVICE_KEYS, "probe.device");
    return {lstat: validateFacts(value.lstat, "probe.device.lstat"),
        fstat: validateFacts(value.fstat, "probe.device.fstat"),
        reopen: validateFacts(value.reopen, "probe.device.reopen")};
}

function validateProcess(value) {
    assertKeys(value, PROCESS_KEYS, "process");
    if (value.exitCode !== null) assertInteger(value.exitCode, 0, 255, "process.exitCode");
    if (value.signal !== null) assertExactString(value.signal, SAFE_TEXT, "process.signal");
    for (const key of ["timedOut", "stdoutOverflow", "stderrOverflow", "cleanupProven", "errorObserved"])
        assertBoolean(value[key], `process.${key}`);
    return value;
}

function validateProbe(value) {
    assertKeys(value, PROBE_KEYS, "probe");
    if (value.schemaVersion !== SCHEMA_VERSION || !["passed", "failed"].includes(value.status))
        throw new TypeError("probe header is invalid");
    assertExactString(value.stage, /^[a-z][a-z0-9-]*$/, "probe.stage");
    assertInteger(value.errno, 0, 4095, "probe.errno");
    if (value.apiVersion !== null) assertInteger(value.apiVersion, 0, 4095, "probe.apiVersion");
    if (value.exitReason !== null) assertInteger(value.exitReason, 0, 0xffffffff, "probe.exitReason");
    assertBoolean(value.cleanupProven, "probe.cleanupProven");
    return {...value, device: validateDevice(value.device)};
}

function sameDevice(left, right) {
    return FACT_KEYS.every(key => left[key] === right[key]);
}

export function classifyKvmProbe({process: processValue, probe: probeValue}) {
    const observedProcess = validateProcess(processValue);
    if (observedProcess.timedOut) return deepFreeze({classification: "timeout", usable: false, qualifying: false});
    if (observedProcess.stdoutOverflow || observedProcess.stderrOverflow)
        return deepFreeze({classification: "output-overflow", usable: false, qualifying: false});
    if (!observedProcess.cleanupProven)
        return deepFreeze({classification: "cleanup-unproved", usable: false, qualifying: false});
    if (observedProcess.errorObserved || observedProcess.exitCode !== 0 || observedProcess.signal !== null)
        return deepFreeze({classification: "process-failed", usable: false, qualifying: false});
    const probe = validateProbe(probeValue);
    if (!probe.cleanupProven)
        return deepFreeze({classification: "cleanup-unproved", usable: false, qualifying: false});
    if (probe.status === "passed") {
        if (probe.stage !== "complete" || probe.errno !== 0 || probe.apiVersion !== KVM_API_VERSION ||
            probe.exitReason !== KVM_EXIT_HLT || !probe.device.lstat || !probe.device.fstat || !probe.device.reopen ||
            probe.device.lstat.kind !== "character-device" || probe.device.fstat.kind !== "character-device" ||
            probe.device.reopen.kind !== "character-device" || !sameDevice(probe.device.lstat, probe.device.fstat) ||
            !sameDevice(probe.device.lstat, probe.device.reopen))
            throw new TypeError("passed probe evidence is inconsistent");
        return deepFreeze({classification: "usable", usable: true, qualifying: false});
    }
    let classification = "probe-failed";
    if ([2, 19].includes(probe.errno) && ["lstat", "open"].includes(probe.stage)) classification = "device-absent";
    else if ([1, 13].includes(probe.errno) && ["lstat", "open"].includes(probe.stage))
        classification = "permission-denied";
    else if (probe.stage === "api-version") classification = "api-version-mismatch";
    else if (IOCTL_STAGES.has(probe.stage)) classification = probe.stage === "run" ? "run-failed" : "ioctl-failed";
    else if (["device-type", "device-identity"].includes(probe.stage)) classification = "device-invalid";
    else if (probe.stage === "cleanup") classification = "cleanup-unproved";
    return deepFreeze({classification, usable: false, qualifying: false});
}

function serializeObservation(value, name) {
    assertKeys(value, ["process", "stderr", "stdout"], name);
    if (!Buffer.isBuffer(value.stdout) || !Buffer.isBuffer(value.stderr) ||
        value.stdout.length > CAPABILITY_LIMITS.streamBytes || value.stderr.length > CAPABILITY_LIMITS.streamBytes)
        throw new TypeError(`${name} streams are invalid`);
    return {process: structuredClone(validateProcess(value.process)),
        stdout: {bytes: value.stdout.length, sha256: sha256(value.stdout), base64: value.stdout.toString("base64")},
        stderr: {bytes: value.stderr.length, sha256: sha256(value.stderr), base64: value.stderr.toString("base64")}};
}

function validateParsedResources(resources) {
    assertKeys(resources, RESOURCE_KEYS, "resources");
    assertKeys(resources.filesystem, [...FILESYSTEM_KEYS, "informationalBavailTimesBsize"],
        "resources.filesystem");
    assertKeys(resources.memory, [...MEMORY_KEYS, "cgroupHeadroomBytes", "effectiveAvailableBytes"], "resources.memory");
    assertKeys(resources.cpu, [...CPU_KEYS, "effectiveLogicalProcessors"], "resources.cpu");
    assertKeys(resources.tools, TOOLS_KEYS, "resources.tools");
    const raw = {filesystem: Object.fromEntries(FILESYSTEM_KEYS.map(key => [key, resources.filesystem[key]]))};
    raw.memory = Object.fromEntries(MEMORY_KEYS.map(key => [key, resources.memory[key]]));
    raw.cpu = Object.fromEntries(CPU_KEYS.map(key => [key, resources.cpu[key]]));
    raw.tools = structuredClone(resources.tools);
    const recomputed = parseResourceObservation(raw);
    if (resources.filesystem.informationalBavailTimesBsize !==
        recomputed.filesystem.informationalBavailTimesBsize ||
        resources.memory.cgroupHeadroomBytes !== recomputed.memory.cgroupHeadroomBytes ||
        resources.memory.effectiveAvailableBytes !== recomputed.memory.effectiveAvailableBytes ||
        resources.cpu.effectiveLogicalProcessors !== recomputed.cpu.effectiveLogicalProcessors)
        throw new TypeError("derived resource facts mismatch");
    return deepFreeze(structuredClone(resources));
}

export function buildCapabilityEvidence({context, manifest, resources, sourceSha256, probeBinary, compiler,
    process: processValue, rawStreams, probe, startedMonotonicNs, finishedMonotonicNs}) {
    const checkedContext = validateHostedContext(context);
    assertKeys(manifest, MANIFEST_KEYS, "manifest");
    if (JSON.stringify(manifest.context) !== JSON.stringify(checkedContext)) throw new TypeError("manifest context mismatch");
    assertExactString(sourceSha256, SHA256, "sourceSha256");
    if (sourceSha256 !== sha256(Buffer.from(KVM_PROBE_SOURCE))) throw new TypeError("probe source hash mismatch");
    assertKeys(probeBinary, ["after", "before"], "probeBinary");
    if (!Buffer.isBuffer(probeBinary.before) || !Buffer.isBuffer(probeBinary.after) ||
        probeBinary.before.length <= 0 || probeBinary.before.length > MAX_PROBE_BINARY_BYTES ||
        !probeBinary.before.equals(probeBinary.after)) throw new TypeError("probe binary identity is invalid");
    assertKeys(manifest.module, MODULE_KEYS, "manifest.module");
    if (manifest.schemaVersion !== SCHEMA_VERSION || manifest.module.name !== MODULE_NAME ||
        !Number.isInteger(manifest.module.bytes) || manifest.module.bytes <= 0 ||
        manifest.module.bytes > CAPABILITY_LIMITS.resultBytes)
        throw new TypeError("manifest module is invalid");
    assertExactString(manifest.module.sha256, SHA256, "manifest.module.sha256");
    assertKeys(compiler, ["argv", "compileObservation", "path", "sha256", "version", "versionObservation"], "compiler");
    parseOptionalPath(compiler.path, "compiler.path");
    assertExactString(compiler.sha256, SHA256, "compiler.sha256");
    assertExactString(compiler.version, SAFE_TEXT, "compiler.version");
    if (!Array.isArray(compiler.argv) || compiler.argv.length === 0 || compiler.argv.length > MAX_ARGUMENTS ||
        compiler.argv.some(argument => typeof argument !== "string" || argument.length > MAX_TEXT_CHARACTERS ||
            /[\x00-\x1f\x7f]/.test(argument)))
        throw new TypeError("compiler argv is invalid");
    const versionObservation = serializeObservation(compiler.versionObservation, "compiler.versionObservation");
    const compileObservation = serializeObservation(compiler.compileObservation, "compiler.compileObservation");
    if (versionObservation.process.exitCode !== 0 || versionObservation.process.signal !== null ||
        versionObservation.process.timedOut || versionObservation.process.stdoutOverflow ||
        versionObservation.process.stderrOverflow || !versionObservation.process.cleanupProven ||
        versionObservation.process.errorObserved ||
        compileObservation.process.exitCode !== 0 || compileObservation.process.signal !== null ||
        compileObservation.process.timedOut || compileObservation.process.stdoutOverflow ||
        compileObservation.process.stderrOverflow || !compileObservation.process.cleanupProven ||
        compileObservation.process.errorObserved)
        throw new TypeError("compiler observation is not successful");
    const start = assertDecimal(startedMonotonicNs, {name: "startedMonotonicNs"});
    const finish = assertDecimal(finishedMonotonicNs, {name: "finishedMonotonicNs"});
    if (finish < start) throw new TypeError("monotonic interval is invalid");
    const verdict = classifyKvmProbe({process: processValue, probe});
    assertKeys(rawStreams, ["stderr", "stdout"], "rawStreams");
    const streams = serializeObservation({process: processValue, stdout: rawStreams.stdout,
        stderr: rawStreams.stderr}, "probeObservation");
    const expectedStdout = Buffer.from(`${JSON.stringify(probe)}\n`);
    if (!rawStreams.stdout.equals(expectedStdout)) throw new TypeError("raw probe output does not match parsed probe");
    return deepFreeze({
        schemaVersion: SCHEMA_VERSION,
        status: verdict.usable ? "passed" : "failed",
        classification: "github-hosted-linux-kvm-capability-nonqualifying",
        capability: verdict.classification,
        qualifying: false,
        releaseGateCleared: false,
        context: checkedContext,
        closure: structuredClone(manifest.module),
        source: {sha256: sourceSha256, bytes: Buffer.byteLength(KVM_PROBE_SOURCE)},
        probeBinary: {bytes: probeBinary.before.length, sha256: sha256(probeBinary.before)},
        compiler: {...structuredClone(compiler), versionObservation, compileObservation},
        resources: structuredClone(validateParsedResources(resources)),
        process: structuredClone(validateProcess(processValue)),
        streams: {stdout: streams.stdout, stderr: streams.stderr},
        probe: structuredClone(validateProbe(probe)),
        startedMonotonicNs,
        finishedMonotonicNs,
        durationNs: (finish - start).toString()
    });
}

function parseArguments(argv) {
    if (argv.length < 1) throw new TypeError("mode is required");
    const mode = argv[0];
    const options = {};
    for (let index = 1; index < argv.length; index += 2) {
        const name = argv[index];
        if (!name?.startsWith("--") || index + 1 >= argv.length) throw new TypeError("arguments are invalid");
        const key = name.slice(2);
        if (Object.hasOwn(options, key)) throw new TypeError(`duplicate argument: ${name}`);
        options[key] = argv[index + 1];
    }
    return {mode, options};
}

function assertOptionKeys(mode, options) {
    const common = ["event-sha", "nonce", "run-attempt", "run-id", "source-sha"];
    const expected = mode === "emit-manifest" ? [...common, "output"] : mode === "probe" ?
        [...common, "closure-root", "manifest", "result"] : null;
    if (!expected) throw new TypeError("unknown mode");
    const actual = Object.keys(options).sort();
    expected.sort();
    if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index]))
        throw new TypeError(`${mode} option schema mismatch`);
}

function contextFromEnvironment(options, environment) {
    return validateHostedContext({schemaVersion: SCHEMA_VERSION, repository: environment.GITHUB_REPOSITORY,
        sourceSha: options["source-sha"], eventSha: options["event-sha"], runId: options["run-id"],
        runAttempt: options["run-attempt"], nonce: options.nonce,
        environment: {GITHUB_ACTIONS: environment.GITHUB_ACTIONS, CI: environment.CI,
            RUNNER_OS: environment.RUNNER_OS, RUNNER_ARCH: environment.RUNNER_ARCH,
            RUNNER_ENVIRONMENT: environment.RUNNER_ENVIRONMENT, ImageOS: environment.ImageOS,
            ImageVersion: environment.ImageVersion}});
}

function assertDirectChild(parent, child, expectedName) {
    const canonicalParent = fs.realpathSync(parent);
    const resolved = path.resolve(child);
    if (path.dirname(resolved) !== canonicalParent || path.basename(resolved) !== expectedName)
        throw new TypeError(`${expectedName} path is not an exact direct child`);
    return resolved;
}

function boundedAppend(chunks, chunk, state) {
    if (state.overflow) return;
    const bytes = Buffer.from(chunk);
    if (state.bytes + bytes.length > CAPABILITY_LIMITS.streamBytes) {
        state.overflow = true;
        const remaining = CAPABILITY_LIMITS.streamBytes - state.bytes;
        if (remaining > 0) chunks.push(bytes.subarray(0, remaining));
        state.bytes = CAPABILITY_LIMITS.streamBytes;
        return;
    }
    chunks.push(bytes); state.bytes += bytes.length;
}

export async function runOwnedProcess(command, argv, timeoutMs, dependencies = {}) {
    const spawnImpl = dependencies.spawnImpl ?? spawn;
    const setTimer = dependencies.setTimer ?? setTimeout;
    const clearTimer = dependencies.clearTimer ?? clearTimeout;
    const killGroup = dependencies.killGroup ?? (pid => process.kill(-pid, "SIGKILL"));
    const isGroupAlive = dependencies.isGroupAlive ?? (pid => {
        try { process.kill(-pid, 0); return true; }
        catch (error) {
            if (error.code === "ESRCH") return false;
            throw error;
        }
    });
    return await new Promise((resolve, reject) => {
        const child = spawnImpl(command, argv, {stdio: ["ignore", "pipe", "pipe"], detached: true, windowsHide: true});
        const stdout = [], stderr = [];
        const stdoutState = {bytes: 0, overflow: false}, stderrState = {bytes: 0, overflow: false};
        let timedOut = false, errorObserved = false, settled = false, cleanupTimer = null;
        const resolveResult = (exitCode, exitSignal, cleanupProven) => {
            if (settled) return;
            settled = true;
            clearTimer(executionTimer);
            if (cleanupTimer !== null) clearTimer(cleanupTimer);
            resolve({process: {exitCode, signal: exitSignal, timedOut, stdoutOverflow: stdoutState.overflow,
                stderrOverflow: stderrState.overflow, cleanupProven, errorObserved},
            stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr)});
        };
        const terminate = () => {
            try { killGroup(child.pid); } catch { /* cleanup remains unproved */ }
            if (cleanupTimer === null) cleanupTimer = setTimer(() => {
                child.stdout.destroy();
                child.stderr.destroy();
                child.unref?.();
                resolveResult(null, null, false);
            }, CAPABILITY_LIMITS.cleanupTimeoutMs);
        };
        const executionTimer = setTimer(() => { timedOut = true; terminate(); }, timeoutMs);
        child.stdout.on("data", chunk => {
            boundedAppend(stdout, chunk, stdoutState);
            if (stdoutState.overflow) terminate();
        });
        child.stderr.on("data", chunk => {
            boundedAppend(stderr, chunk, stderrState);
            if (stderrState.overflow) terminate();
        });
        child.once("error", error => {
            if (!settled) {
                if (Number.isInteger(child.pid) && child.pid > 0) {
                    errorObserved = true;
                    terminate();
                }
                else {
                    settled = true;
                    clearTimer(executionTimer);
                    if (cleanupTimer !== null) clearTimer(cleanupTimer);
                    reject(error);
                }
            }
        });
        child.once("close", (code, signal) => {
            if (settled) return;
            let cleanupProven = false;
            try { cleanupProven = !isGroupAlive(child.pid); } catch { cleanupProven = false; }
            if (!cleanupProven) terminate();
            if (cleanupProven) resolveResult(code, signal, true);
        });
    });
}

const runOwned = runOwnedProcess;

function findMount(taskPath, mountInfo) {
    const decode = value => value.replace(/\\040/g, " ").replace(/\\011/g, "\t").replace(/\\134/g, "\\");
    const mounts = mountInfo.trim().split("\n").map(line => {
        const [left, right] = line.split(" - ");
        const leftParts = left.split(" "), rightParts = right.split(" ");
        return {mountPoint: decode(leftParts[4]), mountOptions: leftParts[5], type: rightParts[0]};
    }).filter(entry => taskPath === entry.mountPoint || taskPath.startsWith(`${entry.mountPoint.replace(/\/$/, "")}/`));
    mounts.sort((left, right) => right.mountPoint.length - left.mountPoint.length);
    if (mounts.length === 0) throw new Error("task filesystem mount was not found");
    return mounts[0];
}

export function resolveCgroupLayout({cgroup, mountInfo}) {
    if (typeof cgroup !== "string" || typeof mountInfo !== "string") throw new TypeError("cgroup inputs are invalid");
    const unified = cgroup.trim().split("\n").filter(Boolean).filter(line => line.startsWith("0::"));
    if (unified.length !== 1) throw new Error("exactly one unified cgroup membership is required");
    const cgroupPath = unified[0].slice(3);
    if (!cgroupPath.startsWith("/") || cgroupPath.includes("..")) throw new Error("cgroup membership path is invalid");
    const mounts = mountInfo.trim().split("\n").filter(Boolean).map(line => {
        const [left, right] = line.split(" - ");
        if (!right) return null;
        const leftParts = left.split(" "), rightParts = right.split(" ");
        if (rightParts[0] !== "cgroup2") return null;
        return {root: leftParts[3], mountPoint: leftParts[4]};
    }).filter(Boolean);
    if (mounts.length !== 1) throw new Error("exactly one cgroup2 mount is required");
    const {root, mountPoint} = mounts[0];
    if (!cgroupPath.startsWith(root === "/" ? "/" : `${root}/`) && cgroupPath !== root)
        throw new Error("process cgroup is outside the cgroup2 mount root");
    const relative = root === "/" ? cgroupPath.slice(1) : cgroupPath.slice(root.length).replace(/^\//, "");
    const processDirectory = path.posix.join(mountPoint, relative);
    const ancestorDirectories = [];
    let current = processDirectory;
    while (true) {
        ancestorDirectories.push(current);
        if (current === mountPoint) break;
        const parent = path.posix.dirname(current);
        if (parent === current || !parent.startsWith(mountPoint)) throw new Error("cgroup ancestry escaped its mount");
        current = parent;
    }
    ancestorDirectories.reverse();
    return deepFreeze({root, mountPoint, processDirectory, ancestorDirectories});
}

export function readResourceObservation({workRoot, filesystem = fs, availableParallelism = os.availableParallelism}) {
    const stats = filesystem.statfsSync(workRoot, {bigint: true});
    const meminfo = filesystem.readFileSync("/proc/meminfo", UTF8);
    const match = /^MemAvailable:\s+([0-9]+) kB$/m.exec(meminfo);
    if (!match) throw new Error("MemAvailable is unavailable");
    const mountInfo = filesystem.readFileSync("/proc/self/mountinfo", UTF8);
    const cgroupLayout = resolveCgroupLayout({cgroup: filesystem.readFileSync("/proc/self/cgroup", UTF8), mountInfo});
    const hierarchyRootMayOmitControllers = cgroupLayout.root === "/";
    const memoryLevels = cgroupLayout.ancestorDirectories.map(directory => {
        const limitPath = path.posix.join(directory, "memory.max");
        const currentPath = path.posix.join(directory, "memory.current");
        if (!filesystem.existsSync(limitPath) && directory === cgroupLayout.mountPoint &&
            hierarchyRootMayOmitControllers)
            return {path: directory, limitBytes: null, currentBytes: null};
        if (!filesystem.existsSync(limitPath) || !filesystem.existsSync(currentPath))
            throw new Error("cgroup memory controller facts are incomplete");
        const limit = filesystem.readFileSync(limitPath, UTF8).trim();
        const current = filesystem.readFileSync(currentPath, UTF8).trim();
        return {path: directory, limitBytes: limit === "max" ? null : limit, currentBytes: current};
    });
    const cpuLevels = cgroupLayout.ancestorDirectories.map(directory => {
        const cpuPath = path.posix.join(directory, "cpu.max");
        if (!filesystem.existsSync(cpuPath) && directory === cgroupLayout.mountPoint &&
            hierarchyRootMayOmitControllers)
            return {path: directory, quota: null, period: null};
        if (!filesystem.existsSync(cpuPath)) throw new Error("cgroup CPU controller facts are incomplete");
        const [quota, period] = filesystem.readFileSync(cpuPath, UTF8).trim().split(" ");
        return {path: directory, quota: quota === "max" ? null : quota, period};
    });
    const mount = findMount(workRoot, mountInfo);
    const qemu = filesystem.existsSync("/usr/bin/qemu-system-x86_64") ?
        filesystem.realpathSync("/usr/bin/qemu-system-x86_64") : null;
    const ovmf = ["/usr/share/OVMF/OVMF_CODE.fd", "/usr/share/OVMF/OVMF_CODE_4M.fd"]
        .filter(candidate => filesystem.existsSync(candidate)).map(candidate => filesystem.realpathSync(candidate));
    const logicalProcessors = availableParallelism();
    return parseResourceObservation({
        filesystem: {availableBlocks: stats.bavail.toString(), blockSize: stats.bsize.toString(),
            type: mount.type, mountOptions: mount.mountOptions, taskPath: workRoot},
        memory: {memAvailableBytes: (BigInt(match[1]) * 1024n).toString(), cgroupLevels: memoryLevels},
        cpu: {logicalProcessors, cgroupLevels: cpuLevels},
        tools: {qemuSystemX8664: qemu, ovmf}
    });
}

function readResources(workRoot) {
    return readResourceObservation({workRoot});
}

function writeExclusive(filePath, bytes, maximumBytes) {
    if (Buffer.byteLength(bytes) <= 0 || Buffer.byteLength(bytes) > maximumBytes) throw new Error("output size is invalid");
    fs.writeFileSync(filePath, bytes, {flag: "wx", mode: 0o600});
}

function readOwnedFile(filePath, maximumBytes) {
    const descriptor = fs.openSync(filePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
        const before = fs.fstatSync(descriptor, {bigint: true});
        if (!before.isFile() || before.size <= 0n || before.size > BigInt(maximumBytes))
            throw new Error("owned file size is invalid");
        const bytes = fs.readFileSync(descriptor);
        const after = fs.fstatSync(descriptor, {bigint: true});
        if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size ||
            before.mtimeNs !== after.mtimeNs || BigInt(bytes.length) !== before.size)
            throw new Error("owned file identity changed while reading");
        return bytes;
    } finally {
        fs.closeSync(descriptor);
    }
}

const nativeOperations = Object.freeze({
    writeExclusive,
    resolveCompiler() {
        const compilerPath = fs.realpathSync(COMPILER_PATH);
        return {path: compilerPath, bytes: readOwnedFile(compilerPath, MAX_TOOL_BYTES)};
    },
    readOwnedFile,
    runOwned,
    readResources,
    monotonicNs() { return process.hrtime.bigint(); }
});

function processFields(observation) {
    return {exitCode: observation.process.exitCode, signal: observation.process.signal,
        timedOut: observation.process.timedOut, stdoutOverflow: observation.process.stdoutOverflow,
        stderrOverflow: observation.process.stderrOverflow, cleanupProven: observation.process.cleanupProven,
        errorObserved: observation.process.errorObserved};
}

function normalizeOwnedObservation(value, name) {
    assertKeys(value, ["process", "stderr", "stdout"], name);
    if (!Buffer.isBuffer(value.stdout) || !Buffer.isBuffer(value.stderr)) throw new TypeError(`${name} streams are invalid`);
    validateProcess(value.process);
    return value;
}

function sanitizeFailure(error) {
    const message = error instanceof Error ? error.message : String(error);
    return message.replace(/[\x00-\x1f\x7f]+/g, " ").slice(0, 512) || "unspecified failure";
}

export async function runCapabilityObservation({context, manifest, workRoot, resultPath}, operations) {
    const checkedContext = validateHostedContext(context);
    assertKeys(manifest, MANIFEST_KEYS, "manifest");
    if (JSON.stringify(manifest.context) !== JSON.stringify(checkedContext)) throw new TypeError("manifest context mismatch");
    if (!operations || typeof operations !== "object") throw new TypeError("operations are required");
    for (const name of ["monotonicNs", "readOwnedFile", "readResources", "resolveCompiler", "runOwned", "writeExclusive"])
        if (typeof operations[name] !== "function") throw new TypeError(`operations.${name} is required`);
    const sourcePath = path.join(workRoot, "probe.c"), executablePath = path.join(workRoot, "probe");
    const sourceBytes = Buffer.from(KVM_PROBE_SOURCE);
    let stage = "source-write";
    let lastObservation = null;
    try {
        operations.writeExclusive(sourcePath, sourceBytes, CAPABILITY_LIMITS.resultBytes);
        if (!operations.readOwnedFile(sourcePath, CAPABILITY_LIMITS.resultBytes).equals(sourceBytes))
            throw new Error("probe source changed after creation");
        stage = "compiler-identity";
        const compiler = operations.resolveCompiler();
        assertKeys(compiler, ["bytes", "path"], "compiler identity");
        parseOptionalPath(compiler.path, "compiler path");
        if (!Buffer.isBuffer(compiler.bytes) || compiler.bytes.length <= 0 || compiler.bytes.length > MAX_TOOL_BYTES)
            throw new TypeError("compiler bytes are invalid");
        stage = "compiler-version";
        const versionRaw = await operations.runOwned(compiler.path, ["--version"], CAPABILITY_LIMITS.probeTimeoutMs);
        const versionObservation = normalizeOwnedObservation(versionRaw, "compiler version observation");
        lastObservation = serializeObservation(versionObservation, "compiler version observation");
        if (versionObservation.process.exitCode !== 0 || versionObservation.process.signal !== null ||
            versionObservation.process.timedOut || versionObservation.process.stdoutOverflow ||
            versionObservation.process.stderrOverflow || !versionObservation.process.cleanupProven ||
            versionObservation.process.errorObserved)
            throw new Error("compiler version observation failed");
        const version = versionObservation.stdout.toString(UTF8).split(/\r?\n/, 1)[0];
        assertExactString(version, SAFE_TEXT, "compiler version");
        const argv = ["-std=c11", "-O2", "-Wall", "-Wextra", "-Werror", "-fno-ident", "-o", executablePath, sourcePath];
        stage = "compile";
        const compileRaw = await operations.runOwned(compiler.path, argv, CAPABILITY_LIMITS.probeTimeoutMs);
        const compileObservation = normalizeOwnedObservation(compileRaw, "compile observation");
        lastObservation = serializeObservation(compileObservation, "compile observation");
        if (compileObservation.process.exitCode !== 0 || compileObservation.process.signal !== null ||
            compileObservation.process.timedOut || compileObservation.process.stdoutOverflow ||
            compileObservation.process.stderrOverflow || !compileObservation.process.cleanupProven ||
            compileObservation.process.errorObserved)
            throw new Error("probe compilation failed");
        const compilerAfter = operations.resolveCompiler();
        assertKeys(compilerAfter, ["bytes", "path"], "revalidated compiler identity");
        if (compilerAfter.path !== compiler.path || !Buffer.isBuffer(compilerAfter.bytes) ||
            !compilerAfter.bytes.equals(compiler.bytes)) throw new Error("compiler identity changed during compilation");
        const probeBinaryBefore = operations.readOwnedFile(executablePath, MAX_PROBE_BINARY_BYTES);
        stage = "resources";
        const resources = validateParsedResources(operations.readResources(workRoot));
        stage = "probe";
        const started = operations.monotonicNs();
        if (typeof started !== "bigint" || started < 0n) throw new TypeError("start monotonic time is invalid");
        const executionRaw = await operations.runOwned(executablePath, [], CAPABILITY_LIMITS.probeTimeoutMs);
        const execution = normalizeOwnedObservation(executionRaw, "probe observation");
        lastObservation = serializeObservation(execution, "probe observation");
        const finished = operations.monotonicNs();
        if (typeof finished !== "bigint" || finished < started) throw new TypeError("finish monotonic time is invalid");
        let probe;
        try { probe = JSON.parse(execution.stdout.toString(UTF8)); }
        catch { throw new Error("probe output is not strict JSON"); }
        const probeBinaryAfter = operations.readOwnedFile(executablePath, MAX_PROBE_BINARY_BYTES);
        const evidence = buildCapabilityEvidence({context: checkedContext, manifest, resources,
            sourceSha256: sha256(sourceBytes), probeBinary: {before: probeBinaryBefore, after: probeBinaryAfter},
            compiler: {path: compiler.path, sha256: sha256(compiler.bytes),
                version, argv, versionObservation, compileObservation}, process: processFields(execution),
            rawStreams: {stdout: execution.stdout, stderr: execution.stderr}, probe,
            startedMonotonicNs: started.toString(), finishedMonotonicNs: finished.toString()});
        operations.writeExclusive(resultPath, `${JSON.stringify(evidence)}\n`, CAPABILITY_LIMITS.resultBytes);
        return evidence;
    } catch (error) {
        const failure = deepFreeze({schemaVersion: SCHEMA_VERSION, status: "failed",
            classification: "github-hosted-linux-kvm-capability-nonqualifying", capability: "execution-failed",
            qualifying: false, releaseGateCleared: false, context: checkedContext,
            closure: structuredClone(manifest.module), stage, error: sanitizeFailure(error),
            lastObservation});
        operations.writeExclusive(resultPath, `${JSON.stringify(failure)}\n`, CAPABILITY_LIMITS.resultBytes);
        return failure;
    }
}

async function emitManifest(options) {
    assertOptionKeys("emit-manifest", options);
    const context = contextFromEnvironment(options, process.env);
    const output = path.resolve(options.output ?? "");
    const modulePath = fileURLToPath(import.meta.url);
    assertDirectChild(fs.realpathSync(path.dirname(modulePath)), output, "closure.json");
    const moduleBytes = fs.readFileSync(modulePath);
    const manifest = createClosureManifest({context, moduleBytes});
    writeExclusive(output, `${JSON.stringify(manifest)}\n`, CAPABILITY_LIMITS.resultBytes);
}

async function invokeProbe(options) {
    assertOptionKeys("probe", options);
    const context = contextFromEnvironment(options, process.env);
    const runnerTemp = fs.realpathSync(process.env.RUNNER_TEMP);
    const closureRoot = fs.realpathSync(options["closure-root"]);
    assertDirectChild(runnerTemp, closureRoot, "linux-kvm-capability-closure");
    const modulePath = assertDirectChild(closureRoot, fileURLToPath(import.meta.url), MODULE_NAME);
    const manifestPath = assertDirectChild(closureRoot, options.manifest, "closure.json");
    const moduleBytes = fs.readFileSync(modulePath);
    const manifestBytes = fs.readFileSync(manifestPath);
    if (manifestBytes.length === 0 || manifestBytes.length > CAPABILITY_LIMITS.resultBytes)
        throw new Error("manifest size is invalid");
    const manifest = validateClosureManifest({manifest: JSON.parse(manifestBytes.toString(UTF8)), moduleBytes,
        expectedContext: context});
    if (JSON.stringify(manifest.context) !== JSON.stringify(context)) throw new Error("closure context mismatch");
    const workRoot = path.join(runnerTemp, `myspeed-kvm-capability-${context.nonce}`);
    fs.mkdirSync(workRoot, {recursive: false, mode: 0o700});
    const resultPath = assertDirectChild(workRoot, options.result, RESULT_NAME);
    const evidence = await runCapabilityObservation({context, manifest, workRoot, resultPath}, nativeOperations);
    if (evidence.status !== "passed") process.exitCode = 1;
}

async function cli() {
    const {mode, options} = parseArguments(process.argv.slice(2));
    if (mode === "emit-manifest") await emitManifest(options);
    else if (mode === "probe") await invokeProbe(options);
    else assertOptionKeys(mode, options);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    cli().catch(error => {
        process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
        process.exitCode = 1;
    });
}
